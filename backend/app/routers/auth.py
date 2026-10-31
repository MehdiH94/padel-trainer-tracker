from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import create_token, hash_password, verify_password
from ..db import get_db
from ..models import Coach, Player
from ..schemas import Creds

router = APIRouter(prefix="/auth", tags=["auth"])


def session_for(user_id: int, role: str) -> dict:
    return {"token": create_token(user_id, role), "role": role}


@router.post("/register")
def register(c: Creds, db: Session = Depends(get_db)):
    """Création d'un compte coach."""
    email = c.email.strip().lower()
    if db.scalar(select(Coach).where(Coach.email == email)) or db.scalar(select(Player).where(Player.email == email, Player.password_hash.is_not(None))):
        raise HTTPException(409, "Email déjà utilisé")
    coach = Coach(email=email, password_hash=hash_password(c.password), name=c.name or email)
    db.add(coach)
    db.commit()
    return session_for(coach.id, "coach")


@router.post("/login")
def login(c: Creds, db: Session = Depends(get_db)):
    """Connexion commune: le rôle (coach ou joueur) est déduit du compte."""
    email = c.email.strip().lower()
    coach = db.scalar(select(Coach).where(Coach.email == email))
    if coach and verify_password(c.password, coach.password_hash):
        return session_for(coach.id, "coach")
    player = db.scalar(select(Player).where(Player.email == email, Player.password_hash.is_not(None)))
    if player and verify_password(c.password, player.password_hash):
        return session_for(player.id, "player")
    raise HTTPException(401, "Identifiants incorrects")


class InviteAccept(BaseModel):
    email: str
    password: str


def _by_token(db: Session, token: str) -> Player:
    p = db.scalar(select(Player).where(Player.invite_token == token))
    if not p:
        raise HTTPException(404, "Invitation invalide ou déjà utilisée")
    return p


@router.get("/invite/{token}")
def invite_info(token: str, db: Session = Depends(get_db)):
    p = _by_token(db, token)
    return {"player_name": p.name, "coach_name": db.get(Coach, p.coach_id).name, "email": p.email}


@router.post("/invite/{token}")
def invite_accept(token: str, body: InviteAccept, db: Session = Depends(get_db)):
    """Le joueur crée son compte depuis le lien d'invitation envoyé par le coach."""
    p = _by_token(db, token)
    email = body.email.strip().lower()
    if "@" not in email or len(body.password) < 6:
        raise HTTPException(422, "Email invalide ou mot de passe trop court (6 caractères minimum)")
    taken = db.scalar(select(Coach).where(Coach.email == email)) or db.scalar(select(Player).where(Player.email == email, Player.id != p.id))
    if taken:
        raise HTTPException(409, "Email déjà utilisé")
    p.email, p.password_hash, p.invite_token = email, hash_password(body.password), None
    db.commit()
    return session_for(p.id, "player")
