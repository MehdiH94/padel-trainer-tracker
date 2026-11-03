from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

import re
import secrets

from sqlalchemy import delete, func

from ..auth import create_token, current_coach, hash_password
from ..constants import CATEGORIES
from ..db import get_db
from ..models import Attendance, Club, Coach, CourtBooking, Player, Promotion, TrainingSession
from ..services.common import aware
from ..schemas import PlayerIn
from ..errors import check_fields
from ..services import admin_ops, signups
from ..services.accounts import account_of, contact_conflicts, has_account, share_profile

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


# --- Joueurs, coachs et clubs de toute l'application -----------------------------------------

@router.get("/players")
def all_players(admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Toutes les fiches joueurs (une par coach), avec leur coach et leur compte."""
    coaches = {c.id: c.name for c in db.scalars(select(Coach))}
    counts = dict(db.execute(select(Attendance.player_id, func.count()).group_by(Attendance.player_id)).all())
    return [{"id": p.id, "name": p.name, "phone": p.phone, "email": account_of(db, p).email, "gender": p.gender, "category": p.category,
             "coach_id": p.coach_id, "coach_name": coaches.get(p.coach_id, "?") if p.coach_id else "Sans coach", "has_account": has_account(p),
             "signup_status": p.signup_status, "sessions": counts.get(p.id, 0),
             "dominant_hand": p.dominant_hand, "side": p.side, "goals": p.goals, "notes": p.notes}
            for p in db.scalars(select(Player).order_by(Player.name))]


class AdminPlayerIn(PlayerIn):
    coach_id: int


@router.post("/players", status_code=201)
def add_player(body: AdminPlayerIn, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Ajoute un élève chez un coach; le lien d'inscription pré-rempli est créé (comme quand le coach l'ajoute)."""
    if not db.get(Coach, body.coach_id):
        raise HTTPException(404, "Coach introuvable")
    errors = contact_conflicts(db, body.coach_id, body.email, body.phone)
    if errors["email"] or errors["phone"]:
        raise HTTPException(409, errors["email"] or errors["phone"])
    p = Player(invite_token=secrets.token_urlsafe(16), **body.model_dump())
    db.add(p)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(409, "Cet e-mail est déjà utilisé par un autre joueur")
    return {"id": p.id, "invite_path": f"/invite/{p.invite_token}"}


@router.delete("/players/{player_id}")
def remove_player(player_id: int, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    p = db.get(Player, player_id)
    if not p:
        raise HTTPException(404, "Joueur introuvable")
    admin_ops.delete_player(db, p)
    db.commit()
    return {"ok": True}


@router.get("/coaches")
def all_coaches(admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    players = dict(db.execute(select(Player.coach_id, func.count()).group_by(Player.coach_id)).all())
    sessions = dict(db.execute(select(TrainingSession.coach_id, func.count()).group_by(TrainingSession.coach_id)).all())
    return [{"id": c.id, "name": c.name, "email": c.email, "players": players.get(c.id, 0), "sessions": sessions.get(c.id, 0),
             "admin": signups.is_admin(c), "clubs": sorted(x.name for x in db.scalars(select(Club).where(Club.coach_id == c.id, Club.active.is_(True), Club.removed.is_(False))))}
            for c in db.scalars(select(Coach).order_by(Coach.name))]


class CoachIn(BaseModel):
    name: str
    email: str
    password: str = ""  # vide = mot de passe provisoire généré


@router.post("/coaches", status_code=201)
def add_coach(body: CoachIn, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    check_fields(name=body.name, email=email, password=body.password, password_required=False)
    if db.scalar(select(Coach).where(Coach.email == email)) or db.scalar(select(Player).where(Player.email == email)):
        raise HTTPException(409, "Cet e-mail est déjà utilisé")
    password = body.password or secrets.token_urlsafe(6)
    if len(password) < 6:
        raise HTTPException(422, "Mot de passe de 6 caractères minimum")
    c = Coach(email=email, name=body.name.strip(), password_hash=hash_password(password))
    db.add(c)
    db.commit()
    return {"id": c.id, "email": email, "password": password}  # à transmettre au coach


@router.delete("/coaches/{coach_id}")
def remove_coach(coach_id: int, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    c = db.get(Coach, coach_id)
    if not c:
        raise HTTPException(404, "Coach introuvable")
    if c.id == admin.id:
        raise HTTPException(409, "Vous ne pouvez pas supprimer votre propre compte")
    admin_ops.delete_coach(db, c)
    db.commit()
    return {"ok": True}


def _key(name: str) -> str:
    return " ".join(name.lower().split())


@router.get("/clubs")
def all_clubs(admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Clubs de l'application, regroupés par nom (chaque coach a sa propre ligne pour un même club)."""
    out: dict[str, dict] = {}
    coaches = {c.id: c.name for c in db.scalars(select(Coach))}
    for c in db.scalars(select(Club).where(Club.removed.is_(False)).order_by(Club.name)):
        x = out.setdefault(_key(c.name), {"key": _key(c.name), "name": c.name.strip(), "phone": c.phone, "coaches": []})
        x["phone"] = x["phone"] or c.phone
        if c.active:  # coachs qui y entraînent
            x["coaches"].append(coaches.get(c.coach_id, "?"))
    return sorted(out.values(), key=lambda x: x["key"])


class ClubIn(BaseModel):
    name: str
    phone: str = ""


@router.post("/clubs", status_code=201)
def add_club(body: ClubIn, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Ajoute un club au catalogue: les coachs pourront le choisir dans Réglages › Mes clubs.
    Il est rangé chez l'administrateur, inactif (il n'apparaît pas dans ses propres clubs)."""
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Nom du club requis")
    if db.scalar(select(Club).where(func.lower(Club.name) == name.lower(), Club.removed.is_(False))):
        raise HTTPException(409, "Ce club existe déjà")
    phone = re.sub(r"[\s.\-()]", "", body.phone)
    if phone:
        from ..schemas import normalize_tn_phone
        try:
            phone = normalize_tn_phone(phone)
        except ValueError as e:
            raise HTTPException(422, str(e))
    db.add(Club(coach_id=admin.id, name=name, phone=phone, active=False))
    db.commit()
    return {"ok": True}


@router.delete("/clubs/{key}")
def remove_club(key: str, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Retire le club de l'application: plus proposé aux coachs ni aux joueurs. L'historique (séances, terrains passés)
    est gardé; les terrains à venir encore libres dans ce club sont supprimés."""
    rows = [c for c in db.scalars(select(Club).where(Club.removed.is_(False))) if _key(c.name) == _key(key)]
    if not rows:
        raise HTTPException(404, "Club introuvable")
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    for c in rows:
        c.removed, c.active = True, False
        for cb in db.scalars(select(CourtBooking).where(CourtBooking.club_id == c.id, CourtBooking.session_id.is_(None))):
            if cb.start and aware(cb.start) > now:
                db.execute(delete(Promotion).where(Promotion.court_booking_id == cb.id))
                db.delete(cb)
    db.commit()
    return {"ok": True}


# --- Tous les droits: agir dans l'espace d'un coach ou d'un joueur, tout modifier ---------------

@router.post("/coaches/{coach_id}/act")
def act_as_coach(coach_id: int, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """L'administrateur ouvre l'espace de ce coach et peut y faire tout ce que le coach fait (jeton de 12 h)."""
    c = db.get(Coach, coach_id)
    if not c:
        raise HTTPException(404, "Coach introuvable")
    return {"token": create_token(c.id, "coach", admin_id=admin.id), "role": "coach", "label": f"coach {c.name}"}


@router.post("/players/{player_id}/act")
def act_as_player(player_id: int, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """L'administrateur ouvre l'espace joueur (réserver, annuler, céder sa place… comme le joueur)."""
    p = db.get(Player, player_id)
    if not p or not has_account(p):
        raise HTTPException(404, "Ce joueur n'a pas encore de compte")
    acc = account_of(db, p)
    return {"token": create_token(acc.id, "player", admin_id=admin.id), "role": "player", "label": f"joueur {acc.name}"}


class AdminPlayerEdit(BaseModel):
    name: str
    phone: str
    email: str | None = None
    gender: str = "M"
    category: str = "P100-"
    dominant_hand: str = "droitier"
    side: str = "drive"
    goals: str = ""
    notes: str = ""
    password: str = ""  # vide = inchangé; avec un e-mail, crée le compte si le joueur n'en a pas


@router.put("/players/{player_id}")
def edit_player(player_id: int, body: AdminPlayerEdit, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Tout modifier, y compris l'e-mail de connexion et le mot de passe (la fiche est la même chez tous ses coachs)."""
    from ..schemas import normalize_tn_phone
    p = db.get(Player, player_id)
    if not p:
        raise HTTPException(404, "Joueur introuvable")
    try:
        phone = normalize_tn_phone(body.phone)
    except ValueError as e:
        raise HTTPException(422, str(e))
    email = (body.email or "").strip().lower() or None
    check_fields(name=body.name, email=email, password=body.password, email_required=False, password_required=False)
    if body.gender not in ("M", "F"):
        raise HTTPException(422, "Genre : choisissez Homme ou Dame.")
    if body.category not in CATEGORIES:
        raise HTTPException(422, "Niveau invalide : choisissez un niveau de P25- à P1000+.")
    errors = contact_conflicts(db, p.coach_id, email, phone, p.id)
    if errors["email"] or errors["phone"]:
        raise HTTPException(409, errors["email"] or errors["phone"])
    if body.password and len(body.password) < 6:
        raise HTTPException(422, "Mot de passe de 6 caractères minimum")
    acc = account_of(db, p)
    p.name, p.phone, p.gender, p.category = body.name.strip() or p.name, phone, body.gender, body.category
    p.dominant_hand, p.side, p.goals, p.notes = body.dominant_hand, body.side, body.goals, body.notes
    if has_account(p):
        acc.email = email or acc.email  # e-mail de connexion (sur la fiche compte)
        if body.password:
            acc.password_hash = hash_password(body.password)
    else:
        p.email = email
        if body.password and email:  # l'administrateur crée directement le compte
            p.password_hash, p.invite_token, p.signup_status = hash_password(body.password), None, "validee"
    share_profile(db, p)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(409, "Cet e-mail est déjà utilisé")
    return {"ok": True}


class CoachEdit(BaseModel):
    name: str
    email: str
    password: str = ""  # vide = inchangé


@router.put("/coaches/{coach_id}")
def edit_coach(coach_id: int, body: CoachEdit, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    c = db.get(Coach, coach_id)
    if not c:
        raise HTTPException(404, "Coach introuvable")
    email = body.email.strip().lower()
    check_fields(name=body.name, email=email, password=body.password, password_required=False)
    if db.scalar(select(Coach).where(func.lower(Coach.email) == email, Coach.id != c.id)) or db.scalar(select(Player).where(func.lower(Player.email) == email)):
        raise HTTPException(409, "Cet e-mail est déjà utilisé")
    if body.password and len(body.password) < 6:
        raise HTTPException(422, "Mot de passe de 6 caractères minimum")
    c.name, c.email = body.name.strip(), email
    if body.password:
        c.password_hash = hash_password(body.password)
    db.commit()
    return {"ok": True}


@router.put("/clubs/{key}")
def edit_club(key: str, body: ClubIn, admin: Coach = Depends(current_admin), db: Session = Depends(get_db)):
    """Renomme le club ou change son téléphone, chez tous les coachs (et sur leurs séances)."""
    from ..schemas import normalize_tn_phone
    rows = [c for c in db.scalars(select(Club).where(Club.removed.is_(False))) if _key(c.name) == _key(key)]
    if not rows:
        raise HTTPException(404, "Club introuvable")
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Nom du club requis")
    if _key(name) != _key(key) and any(_key(c.name) == _key(name) for c in db.scalars(select(Club).where(Club.removed.is_(False)))):
        raise HTTPException(409, "Un autre club porte déjà ce nom")
    try:
        phone = normalize_tn_phone(body.phone) if body.phone.strip() else ""
    except ValueError as e:
        raise HTTPException(422, str(e))
    for c in rows:
        old = c.name
        c.name, c.phone = name, phone
        for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == c.coach_id, TrainingSession.club == old)):
            s.club = name
    db.commit()
    return {"ok": True}
