"""Compte: mot de passe oublié (coach et joueur) et suppression de son compte par le joueur."""
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_player, hash_password, verify_password
from ..db import get_db
from ..models import Booking, Coach, Notification, Player, PlayerEvent
from ..notify import letter, send_email
from ..services import antibot
from ..services.accounts import account_of, linked
from ..services.common import aware

router = APIRouter(tags=["compte"])
RESET_VALID = timedelta(hours=1)


class ForgotIn(BaseModel):
    email: str
    base: str = ""  # adresse du site (lien du message)


def _account(db: Session, email: str):
    email = email.strip().lower()
    return (db.scalar(select(Coach).where(Coach.email == email))
            or db.scalar(select(Player).where(Player.email == email, Player.password_hash.is_not(None))))


@router.post("/auth/password/forgot")
def forgot(body: ForgotIn, request: Request, db: Session = Depends(get_db)):
    """Envoie un lien pour choisir un nouveau mot de passe (valable 1 h). Toujours la même réponse, qu'un compte
    existe ou non: on ne révèle pas quelles adresses sont inscrites."""
    antibot.limit(request, "mot-de-passe", 5, 3600)
    user = _account(db, body.email)
    now = datetime.now(timezone.utc)
    if user and not (user.reset_sent_at and now - aware(user.reset_sent_at) < timedelta(minutes=1)):
        user.reset_token, user.reset_sent_at = secrets.token_urlsafe(24), now
        import os
        link = f"{(body.base or os.getenv('APP_URL', '')).rstrip('/')}/reinitialiser/{user.reset_token}"
        send_email(user.email, "Nouveau mot de passe — Padel Boost", letter(
            user.name, "Vous avez demandé à changer votre mot de passe. Ouvrez ce lien pour en choisir un nouveau (valable 1 heure) :",
            link, "Si vous n'avez rien demandé, ignorez ce message : votre mot de passe ne change pas."))
        db.commit()
    return {"ok": True}


class ResetIn(BaseModel):
    token: str
    password: str


@router.post("/auth/password/reset")
def reset(body: ResetIn, request: Request, db: Session = Depends(get_db)):
    antibot.limit(request, "mot-de-passe-lien", 20, 3600)
    user = (db.scalar(select(Coach).where(Coach.reset_token == body.token))
            or db.scalar(select(Player).where(Player.reset_token == body.token))) if body.token else None
    if not user or not user.reset_sent_at or datetime.now(timezone.utc) - aware(user.reset_sent_at) > RESET_VALID:
        raise HTTPException(400, "Ce lien n'est plus valable : redemandez un nouveau mot de passe.")
    if len(body.password) < 6:
        raise HTTPException(422, "Mot de passe trop court : 6 caractères minimum.")
    user.password_hash, user.reset_token, user.reset_sent_at = hash_password(body.password), None, None
    db.commit()
    return {"ok": True}


class DeleteIn(BaseModel):
    password: str


@router.post("/me/account/delete")
def delete_account(body: DeleteIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Le joueur supprime son compte: ses données personnelles sont effacées sur toutes ses fiches (nom remplacé,
    e-mail, téléphone, objectifs, planning, notifications). L'historique des séances reste chez ses coachs, anonyme.
    Refusé s'il a encore des séances ou demandes à venir (à annuler d'abord)."""
    acc = account_of(db, player)
    if not acc.password_hash or not verify_password(body.password, acc.password_hash):
        raise HTTPException(403, "Mot de passe incorrect.")
    from ..services.booking import ACTIVE
    rows = linked(db, player)
    ids = {p.id for p in rows}
    now = datetime.now(timezone.utc)
    if any(aware(b.start) > now for b in db.scalars(select(Booking).where(Booking.player_id.in_(ids), Booking.status.in_(ACTIVE + ("en_formation",))))):
        raise HTTPException(409, "Vous avez encore des séances ou des demandes à venir : annulez-les d'abord, puis supprimez votre compte.")
    for e in db.scalars(select(PlayerEvent).where(PlayerEvent.account_id == acc.id)):
        db.delete(e)
    for n in db.scalars(select(Notification).where(Notification.account_id == acc.id)):
        db.delete(n)
    from ..models import PushSubscription, Review, Waitlist  # noqa: F401 (tables ajoutées avec ces fonctions)
    for model, col in ((PushSubscription, PushSubscription.player_id), (Review, Review.account_id), (Waitlist, Waitlist.player_id)):
        for x in db.scalars(select(model).where(col.in_(ids))):
            db.delete(x)
    for p in rows:
        p.name, p.email, p.phone, p.password_hash = "Joueur supprimé", None, "", None
        p.goals, p.invite_token, p.email_token, p.reset_token, p.fav_coaches, p.fav_clubs = "", None, None, None, "", ""
        p.signup_status = "refusee"  # plus de connexion possible
    db.commit()
    return {"ok": True}
