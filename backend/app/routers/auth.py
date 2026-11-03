from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from fastapi.security import HTTPAuthorizationCredentials

from ..auth import _decode, bearer, create_token, hash_password, verify_password
from ..db import get_db
from ..models import Coach, Player
from ..constants import CATEGORIES
from ..schemas import CHANNELS, Creds
from ..services import email_verification as verification
from ..errors import check_fields
from ..services import signups
from ..services.accounts import contact_conflicts

router = APIRouter(prefix="/auth", tags=["auth"])


def session_for(user_id: int, role: str) -> dict:
    return {"token": create_token(user_id, role), "role": role}


class RegisterIn(BaseModel):
    email: str
    password: str
    name: str = ""
    phone: str = ""
    base: str = ""  # adresse de l'application (lien de vérification)


@router.post("/register")
def register(c: RegisterIn, db: Session = Depends(get_db)):
    """Création d'un compte coach. Dès que l'application a un administrateur, le nouveau coach vérifie son e-mail
    puis attend qu'un administrateur confirme son compte (rien n'est possible avant)."""
    from ..schemas import normalize_tn_phone
    email = c.email.strip().lower()
    check_fields(name=c.name or email, email=email, password=c.password)
    if db.scalar(select(Coach).where(Coach.email == email)) or db.scalar(select(Player).where(Player.email == email, Player.password_hash.is_not(None))):
        raise HTTPException(409, "Cette adresse e-mail a déjà un compte : connectez-vous, ou utilisez une autre adresse.")
    try:
        phone = normalize_tn_phone(c.phone) if c.phone.strip() else ""
    except ValueError as e:
        raise HTTPException(422, str(e))
    coach = Coach(email=email, password_hash=hash_password(c.password), name=c.name.strip() or email, phone=phone)
    db.add(coach)
    db.flush()
    if signups.review_coaches(db) and email not in signups.admin_emails():
        verification.send_link(db, coach, c.base)
        signups.coach_submitted(db, coach, c.base)
    db.commit()
    return session_for(coach.id, "coach")


@router.get("/account")
def account(creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)):
    """État du compte connecté, lisible même en attente: e-mail à vérifier, confirmation de l'administrateur."""
    data = _decode(creds)
    uid, role = int(data["sub"]), data.get("role")
    user = db.get(Coach, uid) if role == "coach" else db.get(Player, uid) if role == "player" else None
    if user is None:
        raise HTTPException(401, "Session expirée : reconnectez-vous.")
    pending = (signups.coach_pending(user) if role == "coach" else signups.player_pending(user)) and not data.get("admin")
    return {"role": role, "name": user.name, "email": user.email, "pending": pending, "signup_status": user.signup_status,
            "email_verified": verification.is_verified(user),
            "email_required": verification.coach_required() if role == "coach" else verification.required()}


class BaseIn(BaseModel):
    base: str = ""


@router.post("/account/resend")
def resend(body: BaseIn, creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)):
    """Nouveau lien de vérification de l'e-mail (au plus un par minute), pour un compte en attente."""
    data = _decode(creds)
    uid, role = int(data["sub"]), data.get("role")
    user = db.get(Coach, uid) if role == "coach" else db.get(Player, uid) if role == "player" else None
    if user is None:
        raise HTTPException(401, "Session expirée : reconnectez-vous.")
    if verification.is_verified(user):
        return {"ok": True, "already_verified": True}
    if not verification.can_resend(user):
        raise HTTPException(429, "Un e-mail vient d'être envoyé. Patientez une minute avant d'en demander un autre.")
    verification.send_link(db, user, body.base)
    db.commit()
    return {"ok": True, "email": user.email}


@router.post("/refresh")
def refresh(creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)):
    """« Rester connecté »: à chaque ouverture de l'appli, un nouveau jeton de 60 jours remplace l'ancien.
    L'accès d'un administrateur à un autre espace n'est pas prolongé."""
    data = _decode(creds)
    if data.get("admin"):
        raise HTTPException(409, "Accès administrateur limité à 12 h")
    uid, role = int(data["sub"]), data.get("role")
    user = db.get(Coach, uid) if role == "coach" else db.get(Player, uid) if role == "player" else None
    if user is None or (role == "player" and (user.password_hash is None or user.signup_status == "refusee")):
        raise HTTPException(401, "Session expirée : reconnectez-vous.")
    return session_for(uid, role)


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
    base: str = ""  # adresse de l'application (pour le lien de vérification envoyé par e-mail)
    contact_channel: str | None = None  # whatsapp / sms / email: moyen choisi pour les rappels de séance
    # Fiche pré-remplie par le coach, complétée ou corrigée par le joueur
    name: str | None = None
    phone: str | None = None
    gender: str | None = None
    category: str | None = None


def _by_token(db: Session, token: str) -> Player:
    p = db.scalar(select(Player).where(Player.invite_token == token))
    if not p:
        raise HTTPException(404, "Invitation invalide ou déjà utilisée")
    return p


@router.get("/invite/{token}")
def invite_info(token: str, db: Session = Depends(get_db)):
    p = _by_token(db, token)
    return {"player_name": p.name, "coach_name": db.get(Coach, p.coach_id).name, "email": p.email,
            "phone": p.phone, "gender": p.gender, "category": p.category}


@router.post("/invite/{token}")
def invite_accept(token: str, body: InviteAccept, db: Session = Depends(get_db)):
    """Le joueur crée son compte depuis le lien d'invitation envoyé par le coach."""
    p = _by_token(db, token)
    email = body.email.strip().lower()
    check_fields(email=email, password=body.password)
    if contact_conflicts(db, p.coach_id, email, None, p.id)["email"]:
        raise HTTPException(409, "Cette adresse e-mail est déjà utilisée par un autre compte. Utilisez-en une autre, ou connectez-vous avec ce compte.")
    if body.contact_channel is not None and body.contact_channel not in CHANNELS:
        raise HTTPException(422, "Moyen de contact invalide")
    if (body.gender and body.gender not in ("M", "F")) or (body.category and body.category not in CATEGORIES):
        raise HTTPException(422, "Genre ou niveau invalide")
    p.invited_category = p.category  # niveau indiqué par le coach, comparé par l'administrateur
    p.name = (body.name or "").strip() or p.name
    p.phone = (body.phone or "").strip() or p.phone
    p.gender, p.category = body.gender or p.gender, body.category or p.category
    p.email, p.password_hash, p.invite_token = email, hash_password(body.password), None
    p.contact_channel = body.contact_channel or p.contact_channel or "email"  # version bêta: tout par e-mail
    verification.send_link(db, p, body.base)  # DP-002: lien de vérification de l'adresse
    signups.submitted(db, p, body.base)  # l'administrateur confirme le niveau et l'absence de doublon
    db.commit()
    return session_for(p.id, "player")


class SignupIn(BaseModel):
    name: str
    phone: str
    email: str
    password: str
    gender: str = "M"
    category: str = "P100-"
    base: str = ""


@router.post("/signup")
def public_signup(body: SignupIn, db: Session = Depends(get_db)):
    """Inscription par le lien public (publicité, page de l'administrateur): compte sans coach.
    Le joueur voit tous les coachs et en choisit un en réservant; l'administrateur confirme l'inscription."""
    from ..schemas import normalize_tn_phone
    email = body.email.strip().lower()
    check_fields(name=body.name, email=email, password=body.password)
    try:
        phone = normalize_tn_phone(body.phone)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if body.gender not in ("M", "F"):
        raise HTTPException(422, "Genre : choisissez Homme ou Dame.")
    if body.category not in CATEGORIES:
        raise HTTPException(422, "Niveau invalide : choisissez un niveau de P25- à P1000+.")
    if contact_conflicts(db, None, email, None)["email"]:
        raise HTTPException(409, "Cette adresse e-mail a déjà un compte : connectez-vous, ou utilisez une autre adresse.")
    p = Player(coach_id=None, name=body.name.strip(), phone=phone, email=email, password_hash=hash_password(body.password),
               gender=body.gender, category=body.category, contact_channel="email")
    db.add(p)
    db.flush()
    verification.send_link(db, p, body.base)
    signups.submitted(db, p, body.base)  # l'administrateur confirme le niveau et l'absence de doublon
    db.commit()
    return session_for(p.id, "player")


@router.post("/verify/{token}")
def verify_email(token: str, db: Session = Depends(get_db)):
    """Lien reçu par e-mail: l'adresse du compte est vérifiée."""
    p = db.scalar(select(Player).where(Player.email_token == token)) or db.scalar(select(Coach).where(Coach.email_token == token))
    if not p:
        raise HTTPException(404, "Lien invalide ou déjà utilisé. Demandez un nouveau lien depuis l'application.")
    p.email_verified_at, p.email_token = datetime.now(timezone.utc), None
    db.commit()
    waiting = signups.coach_pending(p) if isinstance(p, Coach) else signups.player_pending(p)  # reste la confirmation
    return {"ok": True, "email": p.email, "name": p.name, "coach": isinstance(p, Coach), "waiting_admin": waiting}
