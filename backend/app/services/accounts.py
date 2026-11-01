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
        contact_channel=account.contact_channel,
    )
    db.add(p)
    db.flush()
    return p


def contact_email(db: Session, p: Player) -> str | None:
    return p.email or account_of(db, p).email
