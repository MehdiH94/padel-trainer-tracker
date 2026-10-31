"""Côté joueur: l'application simplifiée (solde de crédits, réservation, séances, propositions, progression)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_player
from ..constants import CAPACITY
from ..db import get_db
from ..models import Attendance, Booking, Coach, CreditTx, Player, Proposal, TrainingSession
from ..services import booking as svc
from ..services.common import aware
from ..services.finance import credit_balance
from ..sms import get_sms_provider
from ..sms.base import SmsProvider
from .profile import build_profile

router = APIRouter(prefix="/me", tags=["joueur"])


def _prices(coach: Coach) -> dict:
    return {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}


@router.get("")
def me(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    coach = db.get(Coach, player.coach_id)
    return {
        "name": player.name, "phone": player.phone, "email": player.email, "category": player.category, "gender": player.gender,
        "pref_kinds": player.pref_kinds.split(","), "coach_name": coach.name, "credits_millimes": credit_balance(db, player.id),
        "slot_minutes": coach.slot_minutes, "prices": _prices(coach), "auto_confirm": coach.auto_confirm, "cancel_hours": coach.cancel_hours,
    }


@router.get("/slots")
def slots(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    return [s.isoformat() for s in svc.free_slots(db, db.get(Coach, player.coach_id))]


@router.get("/suggestions")
def suggestions(kinds: str = "individuel,duo,groupe", player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Séances déjà montées qui correspondent au classement et aux types de séance choisis."""
    wanted = [k for k in kinds.split(",") if k in CAPACITY] or list(CAPACITY)
    player.pref_kinds = ",".join(wanted)  # on retient les préférences du joueur (utilisées pour lui proposer des groupes)
    db.commit()
    return svc.suggestions(db, db.get(Coach, player.coach_id), player, wanted)


class BookIn(BaseModel):
    kind: str | None = None
    start: datetime | None = None  # nouveau créneau
    session_id: int | None = None  # ou rejoindre une séance existante


@router.post("/book", status_code=201)
def book(body: BookIn, player: Player = Depends(current_player), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    coach = db.get(Coach, player.coach_id)
    try:
        if body.session_id:
            s = db.get(TrainingSession, body.session_id)
            if not s or s.coach_id != coach.id:
                raise HTTPException(404, "Séance introuvable")
            b = svc.request_join(db, coach, player, s, sms)
        elif body.start and body.kind:
            b = svc.request_new(db, coach, player, body.kind, body.start, sms)
        else:
            raise HTTPException(422, "Choisissez une séance ou un créneau")
    except svc.InsufficientCredits as e:
        raise HTTPException(402, str(e))
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    return {"id": b.id, "status": b.status, "kind": b.kind, "start": b.start, "credits_millimes": credit_balance(db, player.id)}


def _partners(db: Session, s: TrainingSession, me_id: int) -> list[dict]:
    return [{"name": p.name, "category": p.category, "gender": p.gender} for p in (db.get(Player, i) for i in svc.attendee_ids(s)) if p.id != me_id]


@router.get("/sessions")
def my_sessions(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    rows = db.execute(
        select(TrainingSession, Attendance).join(Attendance, Attendance.session_id == TrainingSession.id)
        .where(Attendance.player_id == player.id).order_by(TrainingSession.start)
    ).all()
    bookings = list(db.scalars(select(Booking).where(Booking.player_id == player.id, Booking.status.in_(svc.ACTIVE))))
    by_session = {b.session_id: b for b in bookings if b.session_id and b.status != "en_attente"}
    upcoming, history = [], []
    for s, a in rows:
        b = by_session.get(s.id)
        item = {
            "session_id": s.id, "booking_id": b.id if b else None, "start": s.start, "duration_min": s.duration_min,
            "kind": s.kind, "club": s.club, "court_state": svc.court_state(db, s), "spots_left": svc.spots_left(db, s) if s.open else 0,
            "partners": _partners(db, s, player.id), "status": b.status if b else "confirmee", "session_status": s.status,
            "worked_on": [t for t in a.worked_on.split(",") if t], "note": a.note, "to_improve": a.to_improve,
        }
        (upcoming if s.status == "prevue" and aware(s.start) >= now else history).append(item)
    for b in bookings:  # demandes pas encore traitées par le coach
        if b.status == "en_attente" and aware(b.start) >= now:
            s = db.get(TrainingSession, b.session_id) if b.session_id else None
            upcoming.append({
                "session_id": None, "booking_id": b.id, "start": b.start, "duration_min": b.duration_min, "kind": b.kind,
                "club": s.club if s else "", "court_state": None, "spots_left": 0, "partners": _partners(db, s, player.id) if s else [],
                "status": "en_attente", "session_status": "prevue", "worked_on": [], "note": "", "to_improve": "",
            })
    return {"upcoming": sorted(upcoming, key=lambda x: aware(x["start"])), "history": history[::-1][:60]}


@router.post("/bookings/{booking_id}/cancel")
def cancel(booking_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    b = db.get(Booking, booking_id)
    if not b or b.player_id != player.id:
        raise HTTPException(404, "Réservation introuvable")
    try:
        refunded = svc.cancel_booking(db, db.get(Coach, player.coach_id), b)
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return {"refunded": refunded, "credits_millimes": credit_balance(db, player.id)}


@router.get("/proposals")
def proposals(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Séances que le coach propose au joueur."""
    coach = db.get(Coach, player.coach_id)
    out = []
    for p in db.scalars(select(Proposal).where(Proposal.player_id == player.id, Proposal.status == "proposee")):
        s = db.get(TrainingSession, p.session_id)
        if s.status != "prevue" or aware(s.start) < datetime.now(timezone.utc) or svc.spots_left(db, s) <= 0:
            continue
        out.append({
            "id": p.id, "session_id": s.id, "start": s.start, "duration_min": s.duration_min, "kind": s.kind, "club": s.club,
            "price_millimes": s.price_millimes or svc.price_for(coach, s.kind), "partners": _partners(db, s, player.id),
            "spots_left": svc.spots_left(db, s),
        })
    return sorted(out, key=lambda x: aware(x["start"]))


def _own_proposal(db: Session, player: Player, proposal_id: int) -> Proposal:
    p = db.get(Proposal, proposal_id)
    if not p or p.player_id != player.id or p.status != "proposee":
        raise HTTPException(404, "Proposition introuvable")
    return p


@router.post("/proposals/{proposal_id}/accept")
def accept_proposal(proposal_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    p = _own_proposal(db, player, proposal_id)
    coach = db.get(Coach, player.coach_id)
    try:
        b = svc.request_join(db, coach, player, db.get(TrainingSession, p.session_id), sms, force_accept=True)  # le coach l'a proposé: acceptation directe
    except svc.InsufficientCredits as e:
        raise HTTPException(402, str(e))
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    p.status = "acceptee"
    db.commit()
    return {"id": b.id, "status": b.status, "credits_millimes": credit_balance(db, player.id)}


@router.post("/proposals/{proposal_id}/decline")
def decline_proposal(proposal_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    _own_proposal(db, player, proposal_id).status = "refusee"
    db.commit()
    return {"ok": True}


@router.get("/credits")
def credits(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    rows = db.scalars(select(CreditTx).where(CreditTx.player_id == player.id).order_by(CreditTx.id.desc()).limit(30)).all()
    return [{"id": t.id, "amount_millimes": t.amount_millimes, "reason": t.reason, "created_at": t.created_at} for t in rows]


@router.get("/progress")
def progress(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    full = build_profile(db, player.coach_id, player)
    return {k: full[k] for k in ("stats", "skills", "strengths", "weaknesses", "last_session")} | {"goals": player.goals}
