"""Promotions sur un terrain déjà réservé et encore libre: le coach fixe une remise, ses joueurs sont prévenus."""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach, current_player
from ..db import get_db
from ..models import Club, Coach, CourtBooking, Player, Promotion
from ..notify import Notifier, channel_for
from ..services.accounts import account_of, contact_email, linked
from ..services.common import TUNIS, aware
from ..services.courts import JOURS
from ..services.pricing import base_price, duration_for
from ..sms import get_sms_provider
from ..sms.base import SmsProvider

router = APIRouter(tags=["promotions"])
APP_URL = os.getenv("APP_URL", "http://localhost:5173")


def _when(cb: CourtBooking) -> str:
    t = aware(cb.start).astimezone(TUNIS)
    return f"{JOURS[t.weekday()]} {t:%d/%m} à {t:%H}h{t:%M}"


def default_message(db: Session, coach: Coach, cb: CourtBooking, pct: int) -> str:
    club = db.get(Club, cb.club_id).name
    return (f"Promo padel -{pct} % avec {coach.name} : terrain réservé {_when(cb)} au {club}. "
            f"Seul, à deux ou en groupe, réservez vite dans l'appli : {APP_URL}")


def promo_out(db: Session, p: Promotion) -> dict:
    cb = db.get(CourtBooking, p.court_booking_id)
    coach = db.get(Coach, p.coach_id)
    taken = cb.session_id is not None
    return {
        "id": p.id, "coach_id": coach.id, "coach_name": coach.name, "court_booking_id": cb.id, "club": db.get(Club, cb.club_id).name,
        "start": cb.start, "duration_min": cb.duration_min, "discount_pct": p.discount_pct, "message": p.message,
        "notified_count": p.notified_count, "active": p.active and not taken and aware(cb.start) > datetime.now(timezone.utc), "taken": taken,
        "prices": {k: round(base_price(coach, k) * (100 - p.discount_pct) / 100) for k in ("individuel", "duo", "groupe")},
        "base_prices": {k: base_price(coach, k) for k in ("individuel", "duo", "groupe")},
        "durations": {k: duration_for(coach, k) for k in ("individuel", "duo", "groupe")},
    }


def recipients(db: Session, coach: Coach) -> list[Player]:
    """Joueurs du coach, un seul message par compte (un joueur peut avoir plusieurs fiches)."""
    seen, out = set(), []
    for p in db.scalars(select(Player).where(Player.coach_id == coach.id)):
        key = account_of(db, p).id
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


class PromoIn(BaseModel):
    court_booking_id: int
    discount_pct: int
    message: str = ""  # vide = message par défaut


@router.get("/promotions")
def list_promotions(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    rows = db.scalars(select(Promotion).where(Promotion.coach_id == coach.id).order_by(Promotion.created_at.desc()))
    return {"items": [promo_out(db, p) for p in rows], "recipients": len(recipients(db, coach))}


@router.get("/promotions/preview")
def preview(court_booking_id: int, discount_pct: int = 20, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    cb = db.get(CourtBooking, court_booking_id)
    if not cb or cb.coach_id != coach.id:
        raise HTTPException(404, "Terrain introuvable")
    return {"message": default_message(db, coach, cb, discount_pct), "recipients": len(recipients(db, coach))}


@router.post("/promotions", status_code=201)
def create_promotion(body: PromoIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    cb = db.get(CourtBooking, body.court_booking_id)
    if not cb or cb.coach_id != coach.id:
        raise HTTPException(404, "Terrain introuvable")
    if cb.session_id is not None or cb.status != "confirmee" or not cb.start or aware(cb.start) <= datetime.now(timezone.utc):
        raise HTTPException(409, "Ce terrain n'est plus libre")
    if not 5 <= body.discount_pct <= 90:
        raise HTTPException(422, "La remise doit être entre 5 et 90 %")
    for old in db.scalars(select(Promotion).where(Promotion.court_booking_id == cb.id, Promotion.active.is_(True))):
        old.active = False  # une seule promotion à la fois par terrain
    message = body.message.strip() or default_message(db, coach, cb, body.discount_pct)
    p = Promotion(coach_id=coach.id, court_booking_id=cb.id, discount_pct=body.discount_pct, message=message)
    db.add(p)
    # Prévenir les joueurs par le moyen qu'ils ont choisi (SMS par défaut)
    notifier, sent = Notifier(sms), 0
    for pl in recipients(db, coach):
        channel = channel_for(pl, contact_email(db, pl))  # e-mail en version bêta
        if channel == "email" and not contact_email(db, pl):
            channel = "sms"
        try:
            notifier.send(pl, channel, f"Promo padel avec {coach.name}", message, email=contact_email(db, pl))
            sent += 1
        except Exception:  # un envoi raté ne bloque pas les autres
            continue
    p.notified_count = sent
    db.commit()
    return promo_out(db, p)


@router.delete("/promotions/{promo_id}")
def stop_promotion(promo_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    p = db.get(Promotion, promo_id)
    if not p or p.coach_id != coach.id:
        raise HTTPException(404, "Promotion introuvable")
    p.active = False
    db.commit()
    return {"ok": True}


@router.get("/me/promotions")
def my_promotions(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Promotions en cours chez les coachs du joueur (ceux dont il a une fiche)."""
    coach_ids = {p.coach_id for p in linked(db, player)}
    rows = db.scalars(select(Promotion).where(Promotion.active.is_(True), Promotion.coach_id.in_(coach_ids)))
    return sorted((x for x in (promo_out(db, p) for p in rows) if x["active"]), key=lambda x: aware(x["start"]))
