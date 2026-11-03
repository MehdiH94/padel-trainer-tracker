"""Vérification de l'adresse e-mail des joueurs (DP-002).

Les rappels de séance partent par e-mail: une adresse fausse fait rater ses rappels au joueur.
À la création du compte, un lien de vérification est envoyé; tant que l'adresse n'est pas vérifiée,
le joueur voit l'application mais ne peut pas réserver.
La vérification est exigée dès que l'envoi d'e-mails est possible (SMTP_HOST réglé), ou si
REQUIRE_EMAIL_VERIFICATION=1; REQUIRE_EMAIL_VERIFICATION=0 la désactive.
"""
import os
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..models import Coach, Player
from ..notify import letter, send_email
from .common import aware

APP_URL = os.getenv("APP_URL", "http://localhost:5173")
RESEND_DELAY = timedelta(seconds=60)


def required() -> bool:
    flag = os.getenv("REQUIRE_EMAIL_VERIFICATION")
    return flag == "1" if flag in ("0", "1") else bool(os.getenv("SMTP_HOST"))


def is_verified(p: Player) -> bool:
    return p.email_verified_at is not None


def can_book(p: Player) -> bool:
    return is_verified(p) or not required()


def send_link(db: Session, p: Player, base: str = "") -> None:
    """Nouveau lien (l'ancien ne marche plus) envoyé à l'adresse du compte."""
    if not p.email:
        return
    p.email_token = secrets.token_urlsafe(24)
    p.email_token_sent_at = datetime.now(timezone.utc)
    coach = db.get(Coach, p.coach_id)
    link = f"{(base or APP_URL).rstrip('/')}/verify/{p.email_token}"
    send_email(p.email, "Vérifiez votre adresse e-mail — Padel Coach", letter(
        p.name, f"Bienvenue sur Padel Coach{f' avec {coach.name}' if coach else ''} !",
        "Pour recevoir les rappels de vos séances et pouvoir réserver, confirmez votre adresse e-mail en ouvrant ce lien :",
        link, "Si vous n'avez pas créé de compte, ignorez ce message."))


def can_resend(p: Player) -> bool:
    return not p.email_token_sent_at or datetime.now(timezone.utc) - aware(p.email_token_sent_at) >= RESEND_DELAY
