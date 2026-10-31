import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..constants import CAPACITY
from ..models import Attendance, Club, Coach, CourtBooking, TrainingSession
from ..schemas import SessionIn, SessionOut, SessionPatch
from ..services import booking as booking_svc
from ..services import courts
from ..sms import get_sms_provider
from ..sms.base import SmsProvider
from .players import get_owned_player

router = APIRouter(prefix="/sessions", tags=["sessions"])


def to_out(s: TrainingSession, court_status: str | None = None) -> SessionOut:
    out = SessionOut.model_validate(s)
    out.player_ids = [a.player_id for a in s.attendances]
    out.court_status = court_status
    out.feedback_missing = s.status == "effectuee" and any(not (a.worked_on or a.note or a.to_improve) for a in s.attendances)
    return out


def get_owned_session(db: Session, coach: Coach, session_id: int) -> TrainingSession:
    s = db.get(TrainingSession, session_id)
    if not s or s.coach_id != coach.id:
        raise HTTPException(404, "Séance introuvable")
    return s


@router.get("", response_model=list[SessionOut])
def list_sessions(
    start: datetime | None = None,
    end: datetime | None = None,
    coach: Coach = Depends(current_coach),
    db: Session = Depends(get_db),
):
    q = select(TrainingSession).where(TrainingSession.coach_id == coach.id)
    if start:
        q = q.where(TrainingSession.start >= start)
    if end:
        q = q.where(TrainingSession.start < end)
    court = {cb.session_id: cb.status for cb in db.scalars(select(CourtBooking).where(CourtBooking.coach_id == coach.id))}
    return [to_out(s, court.get(s.id)) for s in db.scalars(q.order_by(TrainingSession.start))]


@router.post("", response_model=list[SessionOut], status_code=201)
def create_sessions(
    body: SessionIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)
):
    if body.price_mode not in ("par_joueur", "groupe"):
        raise HTTPException(422, "price_mode doit être par_joueur ou groupe")
    max_players = CAPACITY.get(body.kind)
    if body.kind not in ("individuel", "duo", "groupe"):
        raise HTTPException(422, "Type de séance invalide")
    if max_players and len(body.player_ids) > max_players:
        raise HTTPException(422, f"Une séance {body.kind} accepte {max_players} joueur(s) maximum")
    if not 1 <= body.repeat_weeks <= 52:
        raise HTTPException(422, "repeat_weeks doit être entre 1 et 52")
    for pid in body.player_ids:
        get_owned_player(db, coach, pid)
    club = None
    if body.club_id:
        club = db.get(Club, body.club_id)
        if not club or club.coach_id != coach.id:
            raise HTTPException(404, "Club introuvable")
    rec = str(uuid.uuid4()) if body.repeat_weeks > 1 else None
    data = body.model_dump(exclude={"player_ids", "repeat_weeks", "start", "court_booked"})
    if club:
        data["club"] = club.name
    created = []
    for i in range(body.repeat_weeks):
        s = TrainingSession(
            coach_id=coach.id, start=body.start + timedelta(weeks=i), recurrence_id=rec, **data
        )
        s.attendances = [Attendance(player_id=pid) for pid in body.player_ids]
        db.add(s)
        created.append(s)
    db.flush()
    if club:
        for s in created:
            courts.create_for_session(db, coach, club, s, already_booked=body.court_booked)
    db.commit()
    if club:
        courts.send_due(db, coach, sms)  # envoie tout de suite celles qui ont lieu dans les 7 jours
    court = {cb.session_id: cb.status for cb in db.scalars(select(CourtBooking).where(CourtBooking.coach_id == coach.id))}
    return [to_out(s, court.get(s.id)) for s in created]


@router.patch("/{session_id}", response_model=SessionOut)
def patch_session(
    session_id: int, body: SessionPatch, coach: Coach = Depends(current_coach), db: Session = Depends(get_db),
    sms: SmsProvider = Depends(get_sms_provider),
):
    s = get_owned_session(db, coach, session_id)
    if body.status is not None:
        if body.status not in ("prevue", "effectuee", "annulee"):
            raise HTTPException(422, "Statut invalide")
        if s.status == "effectuee" and body.status != "effectuee":
            raise HTTPException(409, "Une séance effectuée ne peut plus changer de statut")
        if body.status == "annulee" and s.status != "annulee":
            booking_svc.coach_cancel_session(db, s)  # réservations payées en crédits: remboursement
            courts.release_or_cancel(db, coach, s, sms)  # terrain manuel libéré, club prévenu sinon
        s.status = body.status
    if body.start is not None:  # report
        s.start = body.start
    db.commit()
    cb = db.scalar(select(CourtBooking).where(CourtBooking.session_id == s.id))
    return to_out(s, cb.status if cb else None)
