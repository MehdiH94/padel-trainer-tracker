"""Durées et prix des séances selon la formule (seul / duo / groupe), avec happy hours et promotions."""
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, CourtBooking, HappyHour, Promotion
from .common import TUNIS, aware


def duration_for(coach: Coach, kind: str) -> int:
    return {"duo": coach.duration_duo, "groupe": coach.duration_groupe}.get(kind) or coach.slot_minutes


def base_price(coach: Coach, kind: str) -> int:
    return {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}[kind]


def happy_discount(db: Session, coach: Coach, start: datetime) -> int:
    local = aware(start).astimezone(TUNIS)
    hm = f"{local:%H:%M}"
    return max((h.discount_pct for h in db.scalars(select(HappyHour).where(HappyHour.coach_id == coach.id, HappyHour.weekday == local.weekday()))
                if h.start_time <= hm < h.end_time), default=0)


def promo_for(db: Session, coach: Coach, start: datetime, minutes: int) -> Promotion | None:
    """Promotion active sur un terrain encore libre qui couvre tout le créneau."""
    best = None
    for p in db.scalars(select(Promotion).where(Promotion.coach_id == coach.id, Promotion.active.is_(True))):
        cb = db.get(CourtBooking, p.court_booking_id)
        if not cb or cb.session_id is not None or cb.status != "confirmee" or not cb.start:
            continue
        if aware(cb.start) <= aware(start) and aware(start) + timedelta(minutes=minutes) <= aware(cb.start) + timedelta(minutes=cb.duration_min):
            if not best or p.discount_pct > best.discount_pct:
                best = p
    return best


def quote(db: Session, coach: Coach, kind: str, start: datetime) -> dict:
    """Prix par joueur d'une nouvelle séance: la plus forte remise entre happy hour et promotion s'applique."""
    base, minutes = base_price(coach, kind), duration_for(coach, kind)
    happy = happy_discount(db, coach, start)
    promo = promo_for(db, coach, start, minutes)
    pct, reason = max((happy, "happy_hour"), (promo.discount_pct if promo else 0, "promo"))
    return {"kind": kind, "duration_min": minutes, "base_millimes": base, "price_millimes": round(base * (100 - pct) / 100),
            "discount_pct": pct, "reason": reason if pct else None}
