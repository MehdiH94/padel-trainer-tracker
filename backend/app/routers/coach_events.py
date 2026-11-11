"""Autre chose qu'une séance sur le planning du coach (rendez-vous, tournoi, réunion…), avec un début et une fin.
Le créneau est bloqué: aucune séance du coach ni réservation de joueur ne peut le chevaucher (booking._busy)."""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, CoachEvent, TrainingSession
from ..services.common import aware, quand

router = APIRouter(prefix="/coach-events", tags=["planning coach"])


class CoachEventIn(BaseModel):
    title: str
    start: datetime
    duration_min: int = 60
    note: str = ""


def out(e: CoachEvent) -> dict:
    return {"id": e.id, "title": e.title, "start": e.start, "duration_min": e.duration_min, "note": e.note}


def overlapping(db: Session, coach_id: int, start: datetime, minutes: int, exclude: int | None = None) -> CoachEvent | None:
    """Événement du coach qui chevauche ce créneau (None = libre)."""
    end = aware(start) + timedelta(minutes=minutes)
    for e in db.scalars(select(CoachEvent).where(CoachEvent.coach_id == coach_id, CoachEvent.id != (exclude or 0))):
        if aware(e.start) < end and aware(start) < aware(e.start) + timedelta(minutes=e.duration_min):
            return e
    return None


@router.get("")
def list_events(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    return [out(e) for e in db.scalars(select(CoachEvent).where(CoachEvent.coach_id == coach.id).order_by(CoachEvent.start))]


@router.post("", status_code=201)
def add_event(body: CoachEventIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Donnez un nom à cet événement (ex. Tournoi, Rendez-vous).")
    if not 15 <= body.duration_min <= 24 * 60:
        raise HTTPException(422, "L'heure de fin doit être après l'heure de début.")
    end = aware(body.start) + timedelta(minutes=body.duration_min)
    clash = next((s for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status != "annulee"))
                  if aware(s.start) < end and aware(body.start) < aware(s.start) + timedelta(minutes=s.duration_min)), None)
    if clash:
        raise HTTPException(409, f"Vous avez déjà une séance à ce moment-là ({quand(clash.start, clash.duration_min)}).")
    other = overlapping(db, coach.id, body.start, body.duration_min)
    if other:
        raise HTTPException(409, f"Vous avez déjà « {other.title} » à ce moment-là ({quand(other.start, other.duration_min)}).")
    e = CoachEvent(coach_id=coach.id, title=title[:120], start=body.start, duration_min=body.duration_min, note=body.note.strip())
    db.add(e)
    db.commit()
    return out(e)


@router.delete("/{event_id}")
def remove_event(event_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    e = db.get(CoachEvent, event_id)
    if not e or e.coach_id != coach.id:
        raise HTTPException(404, "Événement introuvable")
    db.delete(e)
    db.commit()
    return {"ok": True}
