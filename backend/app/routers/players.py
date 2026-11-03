import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, CreditTx, Payment, Player
from ..schemas import PlayerIn, PlayerOut
from sqlalchemy.orm import object_session

from ..schemas import normalize_tn_phone
from ..services.accounts import account_of, contact_conflicts, has_account, share_profile
from ..services.finance import credit_balance, settle

router = APIRouter(prefix="/players", tags=["players"])


def get_owned_player(db: Session, coach: Coach, player_id: int) -> Player:
    p = db.get(Player, player_id)
    if not p or p.coach_id != coach.id:
        raise HTTPException(404, "Joueur introuvable")
    return p


def player_out(p: Player, credits: int = 0) -> PlayerOut:
    out = PlayerOut.model_validate(p)
    out.has_account, out.credits_millimes = has_account(p), credits
    out.invite_path = f"/invite/{p.invite_token}" if p.invite_token and not has_account(p) else None
    out.email_verified = has_account(p) and account_of(object_session(p), p).email_verified_at is not None
    return out


def _save(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Cet email est déjà utilisé par un autre joueur")


@router.get("", response_model=list[PlayerOut])
def list_players(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    balances = dict(db.execute(select(CreditTx.player_id, func.sum(CreditTx.amount_millimes)).where(CreditTx.coach_id == coach.id).group_by(CreditTx.player_id)).all())
    return [player_out(p, balances.get(p.id, 0)) for p in db.scalars(select(Player).where(Player.coach_id == coach.id).order_by(Player.name))]


def _check_contact(db: Session, coach: Coach, email: str | None, phone: str, exclude_id: int | None = None) -> None:
    errors = contact_conflicts(db, coach.id, email, phone, exclude_id)
    if errors["email"] or errors["phone"]:
        raise HTTPException(409, errors["email"] or errors["phone"])


@router.get("/check")
def check_contact(email: str = "", phone: str = "", exclude: int | None = None, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Vérification pendant la saisie: e-mail ou téléphone déjà utilisés ?"""
    try:
        phone = normalize_tn_phone(phone) if phone.strip() else ""
    except ValueError:
        return {"email": None, "phone": "Numéro de téléphone invalide : il faut 8 chiffres (ex. 22 123 456)."}
    return contact_conflicts(db, coach.id, email, phone, exclude)


@router.post("", response_model=PlayerOut, status_code=201)
def create_player(body: PlayerIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    _check_contact(db, coach, body.email, body.phone)
    # le lien d'inscription pré-rempli est créé tout de suite: le coach n'a plus qu'à le copier
    p = Player(coach_id=coach.id, invite_token=secrets.token_urlsafe(16), **body.model_dump())
    db.add(p)
    _save(db)
    return player_out(p)


@router.put("/{player_id}", response_model=PlayerOut)
def update_player(player_id: int, body: PlayerIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    p = get_owned_player(db, coach, player_id)
    _check_contact(db, coach, None if p.password_hash else body.email, body.phone, p.id)
    data = body.model_dump()
    if p.password_hash:  # l'email d'un compte actif sert à la connexion: on ne le change pas ici
        data.pop("email")
    for k, v in data.items():
        setattr(p, k, v)
    share_profile(db, p)  # même fiche chez tous ses coachs
    _save(db)
    return player_out(p, credit_balance(db, p.id))


@router.post("/{player_id}/invite")
def invite(player_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Génère (ou renvoie) le lien d'invitation permettant au joueur de créer son compte."""
    p = get_owned_player(db, coach, player_id)
    if has_account(p):
        raise HTTPException(409, "Ce joueur a déjà un compte")
    if not p.invite_token:
        p.invite_token = secrets.token_urlsafe(16)
        db.commit()
    return {"token": p.invite_token, "path": f"/invite/{p.invite_token}"}


class CreditIn(BaseModel):
    amount_millimes: int
    method: str = "especes"


@router.post("/{player_id}/credits", status_code=201)
def recharge(player_id: int, body: CreditIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le joueur paie à l'avance: l'argent encaissé devient des crédits utilisables pour réserver."""
    p = get_owned_player(db, coach, player_id)
    if body.amount_millimes <= 0 or body.method not in ("especes", "virement"):
        raise HTTPException(422, "Montant invalide : indiquez un montant supérieur à 0, payé en espèces ou par virement.")
    db.add(Payment(coach_id=coach.id, player_id=p.id, amount_millimes=body.amount_millimes, method=body.method, kind="credit"))
    db.add(CreditTx(coach_id=coach.id, player_id=p.id, amount_millimes=body.amount_millimes, reason="recharge"))
    db.flush()
    settle(db, coach.id, [p.id])  # la recharge règle d'abord les séances effectuées encore dues
    from ..services.booking import notify  # reçu envoyé au joueur
    from ..services.finance import net_balance
    net = net_balance(db, p)
    from ..notify import letter
    amount = lambda m: f"{m / 1000:.3f} TND".replace(".", ",")  # noqa: E731
    notify(db, [p], "Recharge de crédits", lambda x: letter(
        x.name, f"{coach.name} a enregistré une recharge de crédits sur votre compte.",
        [("Montant", amount(body.amount_millimes)), ("Nouveau solde" if net >= 0 else "Reste à régler", amount(abs(net)))],
        "Vos crédits servent à payer vos séances chez ce coach.", sign=coach.name))
    db.commit()
    return {"balance_millimes": credit_balance(db, p.id)}


@router.get("/{player_id}/credits")
def credits(player_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    p = get_owned_player(db, coach, player_id)
    rows = db.scalars(select(CreditTx).where(CreditTx.player_id == p.id).order_by(CreditTx.id.desc()).limit(30)).all()
    return {
        "balance_millimes": credit_balance(db, p.id),
        "transactions": [{"id": t.id, "amount_millimes": t.amount_millimes, "reason": t.reason, "created_at": t.created_at} for t in rows],
    }
