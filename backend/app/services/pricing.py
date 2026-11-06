"""Durées et prix des séances selon la formule (seul / duo / groupe), avec heures creuses et promotions (réductions en dinars).

Le coach fixe un prix par heure et par joueur pour chaque formule; une séance d'une autre durée est au prorata
(100 TND l'heure -> 150 TND pour 1 h 30). Côté joueur, la durée se choisit à la réservation: seul = toujours 1 h,
à deux ou en groupe = 1 h, 1 h 30 ou les deux (1 h 30 par défaut). Le coach, lui, crée ses séances comme il veut."""
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, CourtBooking, HappyHour, Promotion
from .common import TUNIS, aware


PLAYER_DURATIONS = {"individuel": (60,), "duo": (60, 90), "groupe": (60, 90)}  # durées que le joueur peut choisir
DEFAULT_DURATION = {"individuel": 60, "duo": 90, "groupe": 90}


def duration_for(coach: Coach | None, kind: str) -> int:
    """Durée proposée par défaut pour une formule (seul 1 h, à deux ou en groupe 1 h 30)."""
    return DEFAULT_DURATION.get(kind, 60)


def player_durations(chosen: dict | None) -> dict[str, list[int]]:
    """Durées acceptées par le joueur pour chaque formule (seul: toujours 1 h). Rien de précisé pour une formule:
    toutes ses durées possibles (l'appli, elle, envoie toujours le choix du joueur: 1 h 30 par défaut)."""
    chosen = chosen or {}
    return {k: sorted({int(m) for m in (chosen.get(k) or allowed) if int(m) in allowed}) or list(allowed)
            for k, allowed in PLAYER_DURATIONS.items()}


def base_price(coach: Coach, kind: str, minutes: int | None = None) -> int:
    """Prix par joueur: prix de l'heure de la formule (Réglages) au prorata de la durée (1 h 30 = 1,5 fois)."""
    price = {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}[kind]
    return round(price * (minutes or 60) / 60)


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


def quote(db: Session, coach: Coach, kind: str, start: datetime, minutes: int | None = None) -> dict:
    """Prix par joueur d'une nouvelle séance de cette durée (prix de l'heure au prorata):
    la plus forte réduction entre heure creuse et promotion s'applique."""
    minutes = minutes or duration_for(coach, kind)
    base = base_price(coach, kind, minutes)
    best = (0, 0, 0, None)  # (réduction en millimes, %, dinars, raison)
    for item, reason in ((happy_hour(db, coach, start), "happy_hour"), (promo_for(db, coach, start, minutes), "promo")):
        if item:
            cut = base - reduced(base, item.discount_pct, item.discount_millimes)
            if cut > best[0]:
                best = (cut, 0 if item.discount_millimes else item.discount_pct, item.discount_millimes, reason)
    cut, pct, millimes, reason = best
    return {"kind": kind, "duration_min": minutes, "base_millimes": base, "price_millimes": base - cut,
            "discount_pct": pct, "discount_millimes": millimes, "reduction_millimes": cut, "reason": reason}
