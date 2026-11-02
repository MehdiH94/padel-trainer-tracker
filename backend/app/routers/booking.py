"""Côté coach: réglages, demandes de réservation (avec disponibilité des terrains), groupes à compléter."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..constants import CAPACITY
from ..db import get_db
from ..models import Availability, Booking, Club, Coach, CourtBooking, HappyHour, Player, Proposal, TrainingSession
from ..services import booking as svc
from ..services import courts
from ..services.common import TUNIS, aware
from ..services.exercises_catalog import WORK_THEMES
from ..services import groups as grp
from ..services import signups
from ..services.pricing import base_price, duration_for
from ..sms import get_sms_provider
from ..sms.base import SmsProvider

router = APIRouter(tags=["booking"])
JOURS = courts.JOURS
KIND_LABEL = {"individuel": "individuelle", "duo": "en duo", "groupe": "en groupe"}


class Window(BaseModel):
    weekday: int
    start_time: str
    end_time: str


class HappyIn(BaseModel):
    weekday: int
    start_time: str
    end_time: str
    discount_pct: int


class Settings(BaseModel):
    auto_confirm: bool
    slot_minutes: int
    price_individuel: int
    price_duo: int
    price_groupe: int
    cancel_hours: int = 24
    availability: list[Window]
    booking_mode: str | None = None  # « terrains » ou « disponibilites » (None = inchangé)
    duration_duo: int | None = None  # durée par formule (None = comme la séance individuelle)
    duration_groupe: int | None = None
    happy_hours: list[HappyIn] | None = None  # None = inchangé
    bio: str | None = None  # page publique du coach (None = inchangé)
    specialties: list[str] | None = None


def settings_out(db: Session, coach: Coach) -> dict:
    rows = db.scalars(select(Availability).where(Availability.coach_id == coach.id).order_by(Availability.weekday, Availability.start_time))
    return {
        "auto_confirm": coach.auto_confirm, "slot_minutes": coach.slot_minutes, "cancel_hours": coach.cancel_hours,
        "price_individuel": coach.price_individuel, "price_duo": coach.price_duo, "price_groupe": coach.price_groupe,
        "availability": [{"weekday": r.weekday, "start_time": r.start_time, "end_time": r.end_time} for r in rows],
        "bio": coach.bio, "specialties": [x for x in coach.specialties.split(",") if x], "name": coach.name,
        "duration_duo": duration_for(coach, "duo"), "duration_groupe": duration_for(coach, "groupe"), "booking_mode": coach.booking_mode,
        "happy_hours": [{"weekday": h.weekday, "start_time": h.start_time, "end_time": h.end_time, "discount_pct": h.discount_pct}
                        for h in db.scalars(select(HappyHour).where(HappyHour.coach_id == coach.id).order_by(HappyHour.weekday, HappyHour.start_time))],
    }


@router.get("/booking/settings")
def get_settings(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    return settings_out(db, coach)


@router.put("/booking/settings")
def put_settings(body: Settings, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    prices = (body.price_individuel, body.price_duo, body.price_groupe)
    if not 15 <= body.slot_minutes <= 240 or min(prices) < 0 or not 0 <= body.cancel_hours <= 168:
        raise HTTPException(422, "Réglages invalides")
    for w in [*body.availability, *(body.happy_hours or [])]:
        if not (0 <= w.weekday <= 6 and w.start_time < w.end_time):
            raise HTTPException(422, "Plage horaire invalide")
    if any(not 1 <= h.discount_pct <= 90 for h in body.happy_hours or []):
        raise HTTPException(422, "La remise d'une happy hour doit être entre 1 et 90 %")
    if any(d is not None and not 15 <= d <= 240 for d in (body.duration_duo, body.duration_groupe)):
        raise HTTPException(422, "Durée invalide")
    coach.duration_duo, coach.duration_groupe = body.duration_duo, body.duration_groupe
    if body.booking_mode is not None:
        if body.booking_mode not in ("terrains", "disponibilites"):
            raise HTTPException(422, "Mode de réservation invalide")
        coach.booking_mode = body.booking_mode
    if body.happy_hours is not None:
        for old in db.scalars(select(HappyHour).where(HappyHour.coach_id == coach.id)):
            db.delete(old)
        db.add_all(HappyHour(coach_id=coach.id, **h.model_dump()) for h in body.happy_hours)
    coach.auto_confirm, coach.slot_minutes, coach.cancel_hours = body.auto_confirm, body.slot_minutes, body.cancel_hours
    coach.price_individuel, coach.price_duo, coach.price_groupe = prices
    if body.bio is not None:
        coach.bio = body.bio.strip()[:2000]
    if body.specialties is not None:
        coach.specialties = ",".join(t for t in body.specialties if t in WORK_THEMES)
    for old in db.scalars(select(Availability).where(Availability.coach_id == coach.id)):
        db.delete(old)
    db.add_all(Availability(coach_id=coach.id, **w.model_dump()) for w in body.availability)
    db.commit()
    return settings_out(db, coach)


def _fmt(dt: datetime) -> str:
    t = aware(dt).astimezone(TUNIS)
    return f"{JOURS[t.weekday()]} {t:%d/%m} à {t:%H}h{t:%M}"


def _court_out(cb: CourtBooking, db: Session) -> dict:
    return {"id": cb.id, "club_id": cb.club_id, "club_name": db.get(Club, cb.club_id).name, "court_label": cb.court_label, "start": cb.start, "duration_min": cb.duration_min}


def booking_out(db: Session, coach: Coach, b: Booking) -> dict:
    p = db.get(Player, b.player_id)
    s = db.get(TrainingSession, b.session_id) if b.session_id else None
    out = {
        "id": b.id, "player_id": p.id, "name": p.name, "phone": p.phone, "email": p.email, "category": p.category, "gender": p.gender,
        "kind": b.kind, "start": b.start, "duration_min": b.duration_min, "status": b.status, "charged_millimes": b.charged_millimes,
        "session_id": b.session_id, "join": s is not None and b.status == "en_attente", "notified_at": b.notified_at,
        "partners": [x.name for x in (db.get(Player, i) for i in svc.attendee_ids(s)) if x.id != p.id] if s else [],
        "club": s.club if s else "", "court_state": svc.court_state(db, s) if s else None,
        "accepted_kinds": [k for k in (b.accepted_kinds or b.kind).split(",") if k],  # formules acceptées par le joueur
        "max_players": max(grp.sizes(grp.split(b.accepted_kinds) or [b.kind])),  # plafond voulu par le joueur
        "min_players": min(grp.sizes(grp.split(b.accepted_kinds) or [b.kind])),  # minimum voulu (plus petite formule cochée)
        "players_count": len(s.attendances) if s else 0, "min_needed": grp.min_needed(s) if s else None,
        # prix convenu; les réservations d'avant les remises n'en ont pas: prix de la séance ou tarif du coach
        "price_millimes": b.price_millimes or b.charged_millimes or (s.price_millimes if s else 0) or base_price(coach, b.kind),
        "base_millimes": base_price(coach, b.kind),
    }
    if b.status == "en_attente":
        # y a-t-il un terrain pour ce créneau ?
        out["courts_available"] = [] if s else [_court_out(cb, db) for cb in courts.held_covering(db, coach, b.start, b.duration_min)]
    if b.status == "confirmee":
        where = f" ({s.club})" if s and s.club else ""
        out["message"] = f"Bonjour {p.name.split()[0]}, votre séance de padel {KIND_LABEL[b.kind]} du {_fmt(b.start)}{where} est confirmée. À bientôt ! — {coach.name}"
    return out


@router.get("/booking/requests")
def list_requests(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Demandes à traiter, séances acceptées en attente de terrain, et confirmations à communiquer aux joueurs."""
    items = []
    now = datetime.now(timezone.utc)
    for b in db.scalars(select(Booking).where(Booking.coach_id == coach.id).order_by(Booking.start)):
        if aware(b.start) < now and b.status != "confirmee":
            continue
        if b.status in ("en_attente", "attente_joueurs", "acceptee") or (b.status == "confirmee" and b.notified_at is None and aware(b.start) >= now):
            items.append(booking_out(db, coach, b))
    return items


@router.get("/booking/summary")
def summary(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    items = list_requests(coach, db)
    count = lambda st: sum(1 for i in items if i["status"] == st and (st != "confirmee" or i["notified_at"] is None))  # noqa: E731
    out = {"pending": count("en_attente"), "waiting_court": count("acceptee"), "to_notify": count("confirmee"), "waiting_players": count("attente_joueurs")}
    if signups.is_admin(coach):  # administrateur: inscriptions de joueurs à confirmer
        out |= {"admin": True, "coach_id": coach.id, "signups": db.scalar(select(func.count(Player.id)).where(Player.signup_status == "a_valider"))}
    return out


def _owned(db: Session, coach: Coach, booking_id: int) -> Booking:
    b = db.get(Booking, booking_id)
    if not b or b.coach_id != coach.id:
        raise HTTPException(404, "Demande introuvable")
    return b


class AcceptIn(BaseModel):
    court_booking_id: int | None = None  # terrain déjà réservé à utiliser
    club_id: int | None = None  # sinon: demander un terrain à ce club par SMS


@router.post("/booking/requests/{booking_id}/accept")
def accept(booking_id: int, body: AcceptIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    b = _owned(db, coach, booking_id)
    court = club = None
    if body.court_booking_id:
        court = db.get(CourtBooking, body.court_booking_id)
        if not court or court.coach_id != coach.id or court.session_id is not None or court.status != "confirmee":
            raise HTTPException(409, "Ce terrain n'est plus libre")
    if body.club_id:
        club = db.get(Club, body.club_id)
        if not club or club.coach_id != coach.id:
            raise HTTPException(404, "Club introuvable")
    try:
        svc.accept(db, coach, b, sms, court=court, club=club)
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return booking_out(db, coach, b)


@router.post("/booking/requests/{booking_id}/refuse")
def refuse(booking_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Refus: les crédits sont rendus au joueur."""
    b = _owned(db, coach, booking_id)
    try:
        svc.refuse(db, b)
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return booking_out(db, coach, b)


@router.post("/booking/requests/{booking_id}/court-ok")
def court_ok(booking_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach a obtenu le terrain (hors application): la réservation passe à « confirmée »."""
    b = _owned(db, coach, booking_id)
    if b.status != "acceptee":
        raise HTTPException(409, "Cette réservation n'attend pas de terrain")
    b.status = "confirmee"
    db.flush()
    svc.announce_confirmed(db, db.get(TrainingSession, b.session_id))  # e-mail de confirmation au joueur
    db.commit()
    return booking_out(db, coach, b)


@router.post("/booking/requests/{booking_id}/notified")
def notified(booking_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach a envoyé la confirmation au joueur (SMS, WhatsApp ou e-mail)."""
    b = _owned(db, coach, booking_id)
    b.notified_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


# --- Groupes à compléter ------------------------------------------------

@router.get("/groups")
def groups(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Séances ouvertes avec des places libres + joueurs compatibles (classement, type de séance souhaité)."""
    now = datetime.now(timezone.utc)
    out = []
    for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.open.is_(True), TrainingSession.status == "prevue").order_by(TrainingSession.start)):
        if aware(s.start) < now or svc.spots_left(db, s) <= 0:
            continue
        proposed = [
            {"id": p.id, "player_id": p.player_id, "name": db.get(Player, p.player_id).name}
            for p in db.scalars(select(Proposal).where(Proposal.session_id == s.id, Proposal.status == "proposee"))
        ]
        out.append({
            "session_id": s.id, "start": s.start, "duration_min": s.duration_min, "kind": s.kind, "club": s.club,
            "spots_left": svc.spots_left(db, s), "capacity": grp.capacity(s), "level": s.level,
            "players": [{"name": p.name, "category": p.category, "gender": p.gender} for p in (db.get(Player, i) for i in svc.attendee_ids(s))],
            "candidates": svc.candidates(db, coach, s), "proposed": proposed,
        })
    return out


class ProposeIn(BaseModel):
    session_id: int
    player_id: int


@router.post("/proposals", status_code=201)
def propose(body: ProposeIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    s = db.get(TrainingSession, body.session_id)
    p = db.get(Player, body.player_id)
    if not s or s.coach_id != coach.id or not p or p.coach_id != coach.id:
        raise HTTPException(404, "Séance ou joueur introuvable")
    if not s.open or svc.spots_left(db, s) <= 0 or p.id in svc.attendee_ids(s):
        raise HTTPException(409, "Plus de place dans cette séance")
    if db.scalar(select(Proposal).where(Proposal.session_id == s.id, Proposal.player_id == p.id, Proposal.status == "proposee")):
        raise HTTPException(409, "Proposition déjà envoyée")
    db.add(Proposal(coach_id=coach.id, session_id=s.id, player_id=p.id))
    db.commit()
    return {"ok": True}


@router.delete("/proposals/{proposal_id}")
def withdraw(proposal_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    p = db.get(Proposal, proposal_id)
    if not p or p.coach_id != coach.id:
        raise HTTPException(404, "Proposition introuvable")
    db.delete(p)
    db.commit()
    return {"ok": True}
