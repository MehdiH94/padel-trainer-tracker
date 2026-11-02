from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..constants import CATEGORIES
from ..db import get_db
from ..models import Coach, Player
from ..services import signups

router = APIRouter(prefix="/admin", tags=["admin"])


def current_admin(coach: Coach = Depends(current_coach)) -> Coach:
    if not signups.is_admin(coach):
        raise HTTPException(403, "Réservé à l'administrateur")
    return coach


@router.get("/signups")
def list_signups(status: str = "a_valider", admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    q = select(Player).where(Player.signup_status == status).order_by(Player.signup_at.desc())
    return [signups.out(db, p) for p in db.scalars(q.limit(100))]


def _signup(db: Session, player_id: int) -> Player:
    p = db.get(Player, player_id)
    if not p or not p.signup_status:
        raise HTTPException(404, "Inscription introuvable")
    return p


class ValidateIn(BaseModel):
    category: str | None = None  # niveau corrigé par l'administrateur


@router.post("/signups/{player_id}/validate")
def validate(player_id: int, body: ValidateIn, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    p = _signup(db, player_id)
    if body.category:
        if body.category not in CATEGORIES:
            raise HTTPException(422, "Niveau invalide")
        p.category = body.category
    p.signup_status = "validee"
    db.commit()
    return signups.out(db, p)


@router.post("/signups/{player_id}/refuse")
def refuse(player_id: int, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Doublon ou fausse inscription: le compte est fermé (connexion impossible), la fiche reste chez le coach,
    qui peut renvoyer un lien plus tard."""
    p = _signup(db, player_id)
    p.signup_status, p.password_hash, p.email, p.email_token = "refusee", None, None, None
    db.commit()
    return {"ok": True}
