"""Absences du coach (vacances, jours où il ne travaille pas, avec une raison facultative).
Ces jours-là, aucun créneau n'est proposé aux joueurs; le calendrier les affiche."""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, TimeOff, TrainingSession
from ..services.common import TUNIS, aware

router = APIRouter(prefix="/time-off", tags=["absences"])


class TimeOffIn(BaseModel):
    start_date: date
    end_date: date | None = None  # vide = un seul jour
    reason: str = ""


def out(t: TimeOff) -> dict:
    return {"id": t.id, "start_date": t.start_date.isoformat(), "end_date": t.end_date.isoformat(), "reason": t.reason}


@router.get("")
def list_time_off(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    return [out(t) for t in db.scalars(select(TimeOff).where(TimeOff.coach_id == coach.id).order_by(TimeOff.start_date))]


@router.post("", status_code=201)
def add_time_off(body: TimeOffIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    end = body.end_date or body.start_date
    if end < body.start_date:
        raise HTTPException(422, "La date de fin doit être après la date de début.")
    if (end - body.start_date).days > 366:
        raise HTTPException(422, "Une absence dure au plus un an.")
    t = TimeOff(coach_id=coach.id, start_date=body.start_date, end_date=end, reason=body.reason.strip()[:120])
    db.add(t)
    db.commit()
    # séances déjà prévues pendant l'absence: le coach est prévenu pour les déplacer ou les annuler
    planned = [s for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status == "prevue"))
               if body.start_date <= aware(s.start).astimezone(TUNIS).date() <= end]
    return out(t) | {"sessions_during": len(planned)}


@router.delete("/{time_off_id}")
def remove_time_off(time_off_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    t = db.get(TimeOff, time_off_id)
    if not t or t.coach_id != coach.id:
        raise HTTPException(404, "Absence introuvable")
    db.delete(t)
    db.commit()
    return {"ok": True}
