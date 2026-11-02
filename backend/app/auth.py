import os
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .db import get_db
from .models import Coach, Player

SECRET = os.getenv("SECRET_KEY", "dev-secret-change-me-in-production-0123456789")
bearer = HTTPBearer(auto_error=False)


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    return bcrypt.checkpw(pw.encode(), hashed.encode())


def create_token(user_id: int, role: str = "coach", admin_id: int | None = None) -> str:
    """Jeton de connexion. admin_id: l'administrateur agit dans l'espace de ce compte (valable 12 h)."""
    exp = datetime.now(timezone.utc) + (timedelta(hours=12) if admin_id else timedelta(days=30))
    data = {"sub": str(user_id), "role": role, "exp": exp}
    if admin_id:
        data["admin"] = admin_id
    return jwt.encode(data, SECRET, algorithm="HS256")


def _decode(creds: HTTPAuthorizationCredentials | None) -> dict:
    if creds is None:
        raise HTTPException(401, "Non authentifié")
    try:
        return jwt.decode(creds.credentials, SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Jeton invalide")


def current_coach(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> Coach:
    data = _decode(creds)
    coach = db.get(Coach, int(data["sub"])) if data.get("role") == "coach" else None
    if coach is None:
        raise HTTPException(401, "Jeton invalide")
    return coach


def current_player(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> Player:
    data = _decode(creds)
    player = db.get(Player, int(data["sub"])) if data.get("role") == "player" else None
    if player is None or player.signup_status == "refusee":  # inscription refusée par l'administrateur
        raise HTTPException(401, "Jeton invalide")
    return player
