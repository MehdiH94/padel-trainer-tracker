"""Lien « remplacez-moi »: un joueur qui ne peut plus annuler (délai dépassé) cède sa place.
Le remplaçant se connecte (ou crée son compte chez ce coach) et reprend la réservation."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_player, hash_password
from ..constants import CATEGORIES
from ..db import get_db
from ..models import Booking, Coach, Player, TrainingSession
from ..schemas import CHANNELS, normalize_tn_phone
from ..services import booking as svc
from ..services import email_verification as verification
from ..services import signups
from ..services.accounts import row_for_coach
from ..services.common import aware
from .auth import session_for

router = APIRouter(prefix="/replace", tags=["remplacement"])


def _booking(db: Session, token: str) -> Booking:
    b = db.scalar(select(Booking).where(Booking.replace_token == token))
    if not b or b.status not in ("acceptee", "confirmee", "attente_joueurs") or aware(b.start) <= datetime.now(timezone.utc):
        raise HTTPException(404, "Cette place n'est plus disponible (déjà reprise, annulée ou séance passée).")
    return b


@router.get("/{token}")
def info(token: str, db: Session = Depends(get_db)):
    b = _booking(db, token)
    s = db.get(TrainingSession, b.session_id)
    others = [db.get(Player, i) for i in svc.attendee_ids(s) if i != b.player_id]
    return {
        "start": b.start, "duration_min": b.duration_min, "kind": b.kind, "price_millimes": b.charged_millimes or b.price_millimes,
        "club": s.club, "court": s.court, "coach_name": db.get(Coach, b.coach_id).name,
        "leaving": db.get(Player, b.player_id).name.split()[0],
        "players": [{"name": p.name.split()[0], "category": p.category, "gender": p.gender} for p in others],
    }


def _take(db: Session, b: Booking, account: Player) -> dict:
    row = row_for_coach(db, account, db.get(Coach, b.coach_id))
    try:
        nb = svc.replace(db, b, row)
    except svc.BookingError as e:
        db.rollback()
        raise HTTPException(409, str(e))
    return {"booking_id": nb.id, "start": nb.start}


@router.post("/{token}/take")
def take(token: str, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Joueur déjà inscrit (connecté): il prend la place."""
    out = _take(db, _booking(db, token), player)
    db.commit()
    return out


class SignupIn(BaseModel):
    name: str
    phone: str
    email: str
    password: str
    gender: str = "M"
    category: str = "P100-"
    contact_channel: str = "whatsapp"
    base: str = ""

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v)


@router.post("/{token}/signup")
def signup(token: str, body: SignupIn, db: Session = Depends(get_db)):
    """Nouveau joueur: il crée son compte chez ce coach (inscription à confirmer par l'administrateur) et prend la place."""
    b = _booking(db, token)
    email = body.email.strip().lower()
    if "@" not in email or len(body.password) < 6 or not body.name.strip():
        raise HTTPException(422, "Nom, e-mail valide et mot de passe de 6 caractères minimum requis")
    if body.gender not in ("M", "F") or body.category not in CATEGORIES or body.contact_channel not in CHANNELS:
        raise HTTPException(422, "Genre, niveau ou moyen de contact invalide")
    if db.scalar(select(Coach).where(Coach.email == email)) or db.scalar(select(Player).where(Player.email == email)):
        raise HTTPException(409, "Cet e-mail a déjà un compte : connectez-vous pour prendre la place.")
    p = Player(coach_id=b.coach_id, name=body.name.strip(), phone=body.phone, email=email, password_hash=hash_password(body.password),
               gender=body.gender, category=body.category, contact_channel=body.contact_channel)
    db.add(p)
    db.flush()
    _take(db, b, p)
    verification.send_link(db, p, body.base)
    signups.submitted(db, p, body.base)  # l'administrateur confirme le niveau et l'absence de doublon
    db.commit()
    return session_for(p.id, "player")
