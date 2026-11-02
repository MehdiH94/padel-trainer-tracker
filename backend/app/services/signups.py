"""Inscriptions des joueurs par le lien du coach, confirmées par l'administrateur.

- Le coach ajoute un élève: un lien d'inscription est créé tout de suite, avec la fiche pré-remplie
  (nom, téléphone, genre, niveau). L'élève complète (et corrige au besoin) puis crée son compte.
- L'administrateur (e-mails listés dans ADMIN_EMAILS, comptes coach) est prévenu par e-mail et voit les
  inscriptions à confirmer: niveau déclaré face à celui du coach, doublons possibles (même téléphone,
  même e-mail ou même nom chez un autre compte).
"""
import os
import re
import unicodedata
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, Player
from ..notify import send_email
from .accounts import account_of


def admin_emails() -> set[str]:
    return {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}


def is_admin(coach: Coach) -> bool:
    return coach.email.lower() in admin_emails()


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", phone or "")[-8:]


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    return " ".join(sorted(s.split()))  # « Ben Ali Sami » = « Sami Ben Ali »


def duplicates(db: Session, p: Player) -> list[dict]:
    """Autres joueurs (hors fiches du même compte) qui ressemblent à celui-ci."""
    me = account_of(db, p).id
    out = []
    for o in db.scalars(select(Player).where(Player.id != p.id)):
        if account_of(db, o).id == me:
            continue
        why = []
        if _digits(o.phone) and _digits(o.phone) == _digits(p.phone):
            why.append("même téléphone")
        if o.email and p.email and o.email.lower() == p.email.lower():
            why.append("même e-mail")
        if _norm(o.name) == _norm(p.name):
            why.append("même nom")
        if why:
            out.append({"id": o.id, "name": o.name, "phone": o.phone, "category": o.category, "gender": o.gender,
                        "coach_name": db.get(Coach, o.coach_id).name, "has_account": o.password_hash is not None, "why": why})
    return out


def submitted(db: Session, p: Player, base: str = "") -> None:
    """Le joueur a fini de remplir sa fiche: inscription à confirmer, l'administrateur est prévenu."""
    p.signup_status, p.signup_at = "a_valider", datetime.now(timezone.utc)
    coach = db.get(Coach, p.coach_id)
    level = p.category + (f" (le coach avait indiqué {p.invited_category})" if p.invited_category and p.invited_category != p.category else "")
    body = (f"Nouvelle inscription à confirmer: {p.name}, {p.phone}, {p.email}, niveau {level}, élève de {coach.name}.\n"
            f"Vérifier le niveau et les doublons: {(base or os.getenv('APP_URL', '')).rstrip('/')}/#admin")
    for to in admin_emails():
        send_email(to, f"Inscription à confirmer : {p.name}", body)


def out(db: Session, p: Player) -> dict:
    return {
        "id": p.id, "name": p.name, "phone": p.phone, "email": p.email, "gender": p.gender, "category": p.category,
        "invited_category": p.invited_category, "status": p.signup_status, "signup_at": p.signup_at,
        "coach_name": db.get(Coach, p.coach_id).name, "duplicates": duplicates(db, p),
    }
