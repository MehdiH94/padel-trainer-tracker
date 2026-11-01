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
from ..services.accounts import has_account
from ..services.finance import credit_balance

router = APIRouter(prefix="/players", tags=["players"])


def get_owned_player(db: Session, coach: Coach, player_id: int) -> Player:
    p = db.get(Player, player_id)
    if not p or p.coach_id != coach.id:
        raise HTTPException(404, "Joueur introuvable")
    return p


def player_out(p: Player, credits: int = 0) -> PlayerOut:
    out = PlayerOut.model_validate(p)
    out.has_account, out.credits_millimes = has_account(p), credits
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


@router.post("", response_model=PlayerOut, status_code=201)
def create_player(body: PlayerIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    p = Player(coach_id=coach.id, **body.model_dump())
    db.add(p)
    _save(db)
    return player_out(p)


@router.put("/{player_id}", response_model=PlayerOut)
def update_player(player_id: int, body: PlayerIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    p = get_owned_player(db, coach, player_id)
    data = body.model_dump()
    if p.password_hash:  # l'email d'un compte actif sert à la connexion: on ne le change pas ici
        data.pop("email")
    for k, v in data.items():
        setattr(p, k, v)
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
        raise HTTPException(422, "Recharge invalide")
    db.add(Payment(coach_id=coach.id, player_id=p.id, amount_millimes=body.amount_millimes, method=body.method, kind="credit"))
    db.add(CreditTx(coach_id=coach.id, player_id=p.id, amount_millimes=body.amount_millimes, reason="recharge"))
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
