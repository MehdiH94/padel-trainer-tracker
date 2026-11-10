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
from ..notify import letter, send_email
from .accounts import account_of


def admin_emails() -> set[str]:
    return {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}


def is_admin(coach: Coach) -> bool:
    """Administrateur: e-mail listé dans ADMIN_EMAILS, ou coach nommé administrateur par un autre administrateur."""
    return bool(coach.is_admin) or coach.email.lower() in admin_emails()


def admin_recipients(db: Session) -> set[str]:
    """Adresses des administrateurs, prévenus des inscriptions à confirmer."""
    return admin_emails() | {c.email.lower() for c in db.scalars(select(Coach).where(Coach.is_admin.is_(True)))}


def review_coaches(db: Session) -> bool:
    """Un nouveau coach attend la confirmation d'un administrateur dès que l'application en a un."""
    return bool(admin_recipients(db))


def coach_pending(coach: Coach) -> bool:
    """Coach inscrit lui-même: rien n'est possible tant que son e-mail n'est pas vérifié et qu'un administrateur
    n'a pas confirmé son compte."""
    from .email_verification import coach_required
    if coach.signup_status in ("a_valider", "refusee"):
        return True
    return coach.signup_status is not None and coach_required() and coach.email_verified_at is None


def player_pending(p: Player) -> bool:
    """Joueur inscrit seul (lien public, ou lien général d'un coach): rien n'est possible avant la confirmation de
    l'administrateur."""
    return p.signup_status == "a_valider" and p.account_id is None and (p.coach_id is None or bool(p.open_signup))


def _admin_link(base: str) -> str:
    return f"{(base or os.getenv('APP_URL', '')).rstrip('/')}/#admin"


def coach_submitted(db: Session, c: Coach, base: str = "") -> None:
    """Nouveau coach inscrit: les administrateurs sont prévenus."""
    c.signup_status, c.signup_at = "a_valider", datetime.now(timezone.utc)
    body = letter(None, "Un nouveau coach s'est inscrit et attend votre confirmation :",
                  [("Coach", c.name), ("E-mail", c.email), ("Téléphone", c.phone or "—")],
                  "Confirmez ou refusez son compte dans l'administration :", [("Lien", _admin_link(base))])
    for to in admin_recipients(db):
        if to != c.email.lower():
            send_email(to, f"Nouveau coach à confirmer : {c.name}", body)


def confirmed(email: str | None, name: str, what: str, base: str = "") -> None:
    """Prévient le joueur ou le coach que son compte est confirmé. base = adresse du site vue par l'administrateur
    (la même que celle des joueurs), sinon APP_URL."""
    link = (base or os.getenv("APP_URL", "")).rstrip("/")
    if email:
        send_email(email, "Votre compte Padel Boost est confirmé", letter(
            name, f"Bonne nouvelle : un administrateur a confirmé votre compte {what}.",
            "Vous pouvez maintenant utiliser l'application :", [("Lien", link or "l'application Padel Boost")],
            "Un guide « Bien démarrer » vous montre les premières étapes." if what == "coach" else ""))


def coach_out(c: Coach) -> dict:
    return {"id": c.id, "name": c.name, "email": c.email, "phone": c.phone, "status": c.signup_status, "signup_at": c.signup_at,
            "email_verified": c.email_verified_at is not None}


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", phone or "")[-8:]


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    return " ".join(sorted(s.split()))  # « Ben Ali Sami » = « Sami Ben Ali »


def _coach_name(db: Session, coach_id: int | None) -> str:
    return db.get(Coach, coach_id).name if coach_id else "Sans coach (inscription publique)"


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
                        "coach_name": _coach_name(db, o.coach_id), "has_account": o.password_hash is not None, "why": why})
    return out


def submitted(db: Session, p: Player, base: str = "") -> None:
    """Le joueur a fini de remplir sa fiche: inscription à confirmer, l'administrateur est prévenu."""
    p.signup_status, p.signup_at = "a_valider", datetime.now(timezone.utc)
    coach_name = _coach_name(db, p.coach_id)
    level = p.category + (f" (le coach avait indiqué {p.invited_category})" if p.invited_category and p.invited_category != p.category else "")
    body = letter(None, "Une nouvelle inscription est à confirmer :",
                  [("Joueur", p.name), ("Téléphone", p.phone), ("E-mail", p.email), ("Niveau", level), ("Coach", coach_name)],
                  "Vérifiez le niveau et les doublons dans l'administration :",
                  [("Lien", _admin_link(base))])
    for to in admin_recipients(db):
        send_email(to, f"Inscription à confirmer : {p.name}", body)


def out(db: Session, p: Player) -> dict:
    return {
        "id": p.id, "name": p.name, "phone": p.phone, "email": p.email, "gender": p.gender, "category": p.category,
        "invited_category": p.invited_category, "status": p.signup_status, "signup_at": p.signup_at,
        "coach_name": _coach_name(db, p.coach_id), "duplicates": duplicates(db, p),
    }
