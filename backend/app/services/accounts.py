"""Compte joueur multi-coachs: le joueur se connecte avec sa fiche « compte » (celle qui a un mot de passe)
et réserve chez n'importe quel coach. Chez un nouveau coach, une fiche reliée au compte est créée automatiquement:
le coach la voit comme ses autres joueurs (séances, paiements, crédits propres à ce coach)."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, Player


def has_account(p: Player) -> bool:
    return p.password_hash is not None or p.account_id is not None


def account_of(db: Session, p: Player) -> Player:
    return db.get(Player, p.account_id) if p.account_id else p


def linked(db: Session, account: Player) -> list[Player]:
    """La fiche compte et ses fiches chez les autres coachs."""
    return [account, *db.scalars(select(Player).where(Player.account_id == account.id).order_by(Player.id))]


def row_for_coach(db: Session, account: Player, coach: Coach, create: bool = True) -> Player | None:
    """Fiche du joueur chez ce coach (créée au besoin, copie du profil sportif)."""
    for p in linked(db, account):
        if p.coach_id == coach.id:
            return p
    if not create:
        return None
    p = Player(
        coach_id=coach.id, account_id=account.id, name=account.name, phone=account.phone, gender=account.gender,
        category=account.category, pref_kinds=account.pref_kinds, dominant_hand=account.dominant_hand, side=account.side,
        contact_channel=account.contact_channel, goals=account.goals,
    )
    db.add(p)
    db.flush()
    return p


def contact_email(db: Session, p: Player) -> str | None:
    return p.email or account_of(db, p).email


def contact_conflicts(db: Session, coach_id: int, email: str | None, phone: str | None, exclude_id: int | None = None) -> dict:
    """E-mail ou téléphone déjà pris ? E-mail: unique dans toute l'application (comptes coach et joueurs, hors fiches
    du même joueur). Téléphone: unique parmi les joueurs de ce coach. Retourne les messages d'erreur (None = libre)."""
    from sqlalchemy import func
    me = account_of(db, db.get(Player, exclude_id)).id if exclude_id and db.get(Player, exclude_id) else None
    out = {"email": None, "phone": None}
    email = (email or "").strip().lower()
    if email:
        if db.scalar(select(Coach).where(func.lower(Coach.email) == email)):
            out["email"] = "Cette adresse e-mail est déjà celle d'un compte coach."
        else:
            for o in db.scalars(select(Player).where(func.lower(Player.email) == email)):
                if o.id != exclude_id and account_of(db, o).id != me:
                    out["email"] = (f"Cette adresse e-mail est déjà celle de {o.name} dans vos joueurs." if o.coach_id == coach_id
                                    else "Cette adresse e-mail est déjà utilisée par un autre compte joueur.")
                    break
    if phone:
        o = db.scalar(select(Player).where(Player.coach_id == coach_id, Player.phone == phone, Player.id != (exclude_id or 0)))
        if o:
            out["phone"] = f"Ce numéro est déjà celui de {o.name} dans vos joueurs."
    return out


# Fiche partagée: un joueur suivi par plusieurs coachs a une fiche chez chacun, mais son identité et son profil
# sportif sont les mêmes partout. Les notes privées du coach et ses évaluations restent propres à chaque coach.
SHARED = ("name", "phone", "gender", "category", "dominant_hand", "side", "goals", "pref_kinds", "contact_channel")


def share_profile(db: Session, p: Player) -> None:
    """Recopie l'identité et le profil de cette fiche sur toutes les fiches du même joueur."""
    for o in linked(db, account_of(db, p)):
        if o.id != p.id:
            for k in SHARED:
                setattr(o, k, getattr(p, k))
