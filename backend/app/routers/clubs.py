"""Clubs et réservation des terrains par SMS."""
import os

from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Club, Coach, CourtBooking, Player, TrainingSession
from ..schemas import normalize_tn_phone
from ..services import courts
from ..sms import get_sms_provider
from ..sms.base import SmsProvider

router = APIRouter(tags=["terrains"])
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "dev-webhook-secret")


class ClubIn(BaseModel):
    name: str
    phone: str = ""
    sms_template: str = ""
    auto_send: bool = True

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v) if v.strip() else ""


def club_out(c: Club) -> dict:
    return {"id": c.id, "name": c.name, "phone": c.phone, "sms_template": c.sms_template, "auto_send": c.auto_send, "active": c.active,
            "default_template": courts.DEFAULT_TEMPLATE}


def _key(name: str) -> str:
    return " ".join(name.lower().split())


def owned_club(db: Session, coach: Coach, club_id: int) -> Club:
    c = db.get(Club, club_id)
    if not c or c.coach_id != coach.id:
        raise HTTPException(404, "Club introuvable")
    return c


@router.get("/clubs")
def list_clubs(all: bool = False, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Clubs où le coach entraîne (all=true: y compris ceux qu'il a retirés)."""
    q = select(Club).where(Club.coach_id == coach.id).order_by(Club.name)
    return [club_out(c) for c in db.scalars(q if all else q.where(Club.active.is_(True)))]


@router.get("/clubs/catalog")
def clubs_catalog(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Clubs connus dans l'application (ceux de tous les coachs), et ceux où ce coach entraîne."""
    mine = sorted((c.name for c in db.scalars(select(Club).where(Club.coach_id == coach.id, Club.active.is_(True)))), key=_key)
    known: dict[str, dict] = {}
    for c in db.scalars(select(Club).order_by(Club.name)):
        if _key(c.name) not in known and _key(c.name) not in {_key(m) for m in mine}:
            known[_key(c.name)] = {"name": c.name.strip(), "phone": c.phone}
    return {"mine": mine, "known": sorted(known.values(), key=lambda x: x["name"])}


class NewClub(BaseModel):
    name: str
    phone: str = ""

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v) if v.strip() else ""


class SelectionIn(BaseModel):
    names: list[str]  # clubs (connus) où le coach entraîne
    new: list[NewClub] = []  # clubs ajoutés à la main


@router.put("/clubs/selection")
def select_clubs(body: SelectionIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach choisit ses clubs: ceux qu'il quitte restent en base (historique, terrains) mais ne sont plus proposés."""
    known = {_key(c.name): c for c in db.scalars(select(Club))}  # nom et téléphone de référence
    wanted = {_key(n): n.strip() for n in body.names if n.strip()}
    extra = {_key(c.name): c for c in body.new if c.name.strip()}
    own = {_key(c.name): c for c in db.scalars(select(Club).where(Club.coach_id == coach.id))}
    for k, c in own.items():
        c.active = k in wanted or k in extra
    for k in set(wanted) | set(extra):
        if k not in own:
            name = known[k].name.strip() if k in known else extra[k].name.strip() if k in extra else wanted[k]
            phone = (extra[k].phone if k in extra else "") or (known[k].phone if k in known else "")
            db.add(Club(coach_id=coach.id, name=name, phone=phone))
        elif k in extra and extra[k].phone and not own[k].phone:
            own[k].phone = extra[k].phone
    db.commit()
    return clubs_catalog(coach, db)


@router.post("/clubs", status_code=201)
def create_club(body: ClubIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    c = Club(coach_id=coach.id, **body.model_dump())
    db.add(c)
    db.commit()
    return club_out(c)


@router.put("/clubs/{club_id}")
def update_club(club_id: int, body: ClubIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    c = owned_club(db, coach, club_id)
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    db.commit()
    return club_out(c)


def cb_out(db: Session, cb: CourtBooking) -> dict:
    club = db.get(Club, cb.club_id)
    s = db.get(TrainingSession, cb.session_id) if cb.session_id else None
    names = [db.get(Player, a.player_id).name for a in s.attendances] if s else []
    coach = db.get(Coach, cb.coach_id)
    return {
        "id": cb.id, "status": cb.status, "source": cb.source, "club_id": club.id, "club_name": club.name, "club_phone": club.phone,
        "session_id": cb.session_id, "start": cb.start or s.start, "duration_min": s.duration_min if s else cb.duration_min,
        "session_status": s.status if s else None, "players": names, "court_label": cb.court_label, "free": s is None,
        "message": cb.message or (courts.render(db, coach, club, cb, s) if cb.source == "sms" else ""), "sent_at": cb.sent_at,
        "reply": cb.reply, "replied_at": cb.replied_at,
    }


@router.get("/court-bookings")
def list_court_bookings(status: str | None = None, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    q = select(CourtBooking).where(CourtBooking.coach_id == coach.id, CourtBooking.status != "annulee")
    if status:
        q = q.where(CourtBooking.status == status)
    items = [cb_out(db, cb) for cb in db.scalars(q)]
    return sorted((i for i in items if i["session_status"] != "annulee"), key=lambda i: i["start"])


class ManualIn(BaseModel):
    club_id: int
    start: datetime
    duration_min: int = 60
    court_label: str = ""


@router.post("/court-bookings/manual", status_code=201)
def add_manual(body: ManualIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Terrain que le coach a déjà réservé lui-même (téléphone, sur place…), disponible pour ses séances."""
    club = owned_club(db, coach, body.club_id)
    if not 15 <= body.duration_min <= 480:
        raise HTTPException(422, "Durée invalide")
    cb = courts.create_free_court(db, coach, club, body.start, body.duration_min, body.court_label.strip())
    db.commit()
    return cb_out(db, cb)


def owned_cb(db: Session, coach: Coach, cb_id: int) -> CourtBooking:
    cb = db.get(CourtBooking, cb_id)
    if not cb or cb.coach_id != coach.id:
        raise HTTPException(404, "Demande introuvable")
    return cb


@router.post("/court-bookings/{cb_id}/send")
def send_now(cb_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    """(Ré)envoie le SMS au club."""
    cb = owned_cb(db, coach, cb_id)
    try:
        courts.send(db, coach, cb, sms)
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.commit()
    return cb_out(db, cb)


class StatusIn(BaseModel):
    status: str


@router.post("/court-bookings/{cb_id}/status")
def set_status(cb_id: int, body: StatusIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach tranche à la main (SMS envoyé depuis son téléphone, réponse par appel…)."""
    if body.status not in ("en_attente", "confirmee", "refusee"):
        raise HTTPException(422, "Statut invalide")
    cb = owned_cb(db, coach, cb_id)
    cb.status = body.status
    if body.status == "confirmee":
        courts.mark_confirmed(db, cb)
    db.commit()
    return cb_out(db, cb)


class ReplyIn(BaseModel):
    text: str


@router.post("/court-bookings/{cb_id}/reply")
def paste_reply(cb_id: int, body: ReplyIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach colle la réponse du club; on en déduit confirmée/refusée si le message est clair."""
    cb = owned_cb(db, coach, cb_id)
    verdict = courts.apply_reply(db, cb, body.text)
    db.commit()
    return cb_out(db, cb) | {"understood": verdict is not None}


@router.delete("/court-bookings/{cb_id}")
def delete_free_court(cb_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Supprime un terrain réservé à la main qui n'est lié à aucune séance."""
    cb = owned_cb(db, coach, cb_id)
    if cb.session_id is not None or cb.source != "manuel":
        raise HTTPException(409, "Seul un terrain libre saisi à la main peut être supprimé")
    db.delete(cb)
    db.commit()
    return {"ok": True}


@router.post("/court-bookings/send-due")
def send_due(coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    return {"sent": courts.send_due(db, coach, sms)}


class Inbound(BaseModel):
    phone: str
    text: str

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v)


@router.post("/courts/inbound")
def inbound(body: Inbound, x_webhook_secret: str = Header(""), db: Session = Depends(get_db)):
    """Webhook de la passerelle SMS: réponse d'un club à une demande en attente."""
    if x_webhook_secret != WEBHOOK_SECRET:
        raise HTTPException(403, "Secret invalide")
    cb = courts.match_inbound(db, body.phone)
    if not cb:
        return {"matched": False}
    verdict = courts.apply_reply(db, cb, body.text)
    db.commit()
    return {"matched": True, "court_booking_id": cb.id, "status": cb.status, "understood": verdict is not None}
