"""Durées et prix des séances selon la formule (seul / duo / groupe), avec heures creuses et promotions (réductions en dinars)."""
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, CourtBooking, HappyHour, Promotion
from .common import TUNIS, aware


def duration_for(coach: Coach, kind: str) -> int:
    return {"duo": coach.duration_duo, "groupe": coach.duration_groupe}.get(kind) or coach.slot_minutes


def base_price(coach: Coach, kind: str) -> int:
    return {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}[kind]


def reduced(base: int, pct: int = 0, millimes: int = 0) -> int:
    """Prix après réduction: en dinars (heures creuses, promotions) ou, pour les anciennes données, en %."""
    if millimes:
        return max(base - millimes, 0)
    return round(base * (100 - (pct or 0)) / 100)


def happy_hour(db: Session, coach: Coach, start: datetime) -> HappyHour | None:
    """Heure creuse qui couvre ce début de séance (la plus forte réduction s'il y en a plusieurs)."""
    local = aware(start).astimezone(TUNIS)
    hm = f"{local:%H:%M}"
    hits = [h for h in db.scalars(select(HappyHour).where(HappyHour.coach_id == coach.id, HappyHour.weekday == local.weekday()))
            if h.start_time <= hm < h.end_time]
    return max(hits, key=lambda h: (h.discount_millimes or 0, h.discount_pct or 0), default=None)


def promo_for(db: Session, coach: Coach, start: datetime, minutes: int) -> Promotion | None:
    """Promotion active sur un terrain encore libre qui couvre tout le créneau."""
    best = None
    for p in db.scalars(select(Promotion).where(Promotion.coach_id == coach.id, Promotion.active.is_(True))):
        cb = db.get(CourtBooking, p.court_booking_id)
        if not cb or cb.session_id is not None or cb.status != "confirmee" or not cb.start:
            continue
        if aware(cb.start) <= aware(start) and aware(start) + timedelta(minutes=minutes) <= aware(cb.start) + timedelta(minutes=cb.duration_min):
            if not best or (p.discount_millimes, p.discount_pct) > (best.discount_millimes, best.discount_pct):
                best = p
    return best


def quote(db: Session, coach: Coach, kind: str, start: datetime) -> dict:
    """Prix par joueur d'une nouvelle séance: la plus forte réduction entre heure creuse et promotion s'applique."""
    base, minutes = base_price(coach, kind), duration_for(coach, kind)
    best = (0, 0, 0, None)  # (réduction en millimes, %, dinars, raison)
    for item, reason in ((happy_hour(db, coach, start), "happy_hour"), (promo_for(db, coach, start, minutes), "promo")):
        if item:
            cut = base - reduced(base, item.discount_pct, item.discount_millimes)
            if cut > best[0]:
                best = (cut, 0 if item.discount_millimes else item.discount_pct, item.discount_millimes, reason)
    cut, pct, millimes, reason = best
    return {"kind": kind, "duration_min": minutes, "base_millimes": base, "price_millimes": base - cut,
            "discount_pct": pct, "discount_millimes": millimes, "reduction_millimes": cut, "reason": reason}
