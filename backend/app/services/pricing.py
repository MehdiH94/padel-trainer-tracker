"""Durées et prix des séances selon la formule (seul / duo / groupe), avec heures creuses et promotions (réductions en dinars).

Le coach choisit, pour chaque formule, les durées qu'il propose aux joueurs (1 h, 1 h 30) et le prix par joueur de
chacune, pas forcément au prorata (1 h = 100 TND, 1 h 30 = 120 TND). Sans grille (anciens réglages): prix de l'heure,
seul 1 h, à deux et en groupe 1 h ou 1 h 30 au prorata. Côté joueur, la durée se choisit à la réservation parmi
celles du coach (à deux 1 h par défaut, en groupe 1 h 30). Le coach crée ses séances de 1 h ou 1 h 30, au prix de
sa grille pour cette formule et cette durée, sans calcul au prorata (`grid_price`)."""
import json
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, CourtBooking, HappyHour, Promotion
from .common import TUNIS, aware


PLAYER_DURATIONS = {"individuel": (60, 90), "duo": (60, 90), "groupe": (60, 90)}  # durées que le joueur peut choisir
KINDS = ("individuel", "duo", "groupe")
HORIZONS = (7, 14, 21, 30, 60, 90)  # limite de réservation à l'avance: 1, 2, 3 semaines, 1, 2, 3 mois


def grid(coach: Coach) -> dict[str, dict[int, int]]:
    """Durées proposées et prix par joueur de chaque formule: {"duo": {60: 40000, 90: 55000}, ...}.
    Formule sans durée = pas proposée aux joueurs."""
    if coach.price_grid:
        raw = json.loads(coach.price_grid)
        return {k: {int(m): int(p) for m, p in (raw.get(k) or {}).items()} for k in KINDS}
    hourly = {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}
    return {k: {m: round(hourly[k] * m / 60) for m in ((60,) if k == "individuel" else (60, 90))} for k in KINDS}


def coach_durations(coach: Coach, kind: str) -> list[int]:
    """Durées que ce coach propose aux joueurs pour cette formule."""
    return sorted(grid(coach)[kind])
DEFAULT_DURATION = {"individuel": 60, "duo": 60, "groupe": 90}  # proposé par défaut: seul et à deux 1 h, en groupe 1 h 30


def duration_for(coach: Coach | None, kind: str) -> int:
    """Durée proposée par défaut pour une formule (seul et à deux 1 h, en groupe 1 h 30)."""
    return DEFAULT_DURATION.get(kind, 60)


def player_durations(chosen: dict | None) -> dict[str, list[int]]:
    """Durées acceptées par le joueur pour chaque formule. Rien de précisé pour une formule: toutes les durées
    possibles (l'appli, elle, envoie toujours le choix du joueur); chaque coach ne propose que les siennes."""
    chosen = chosen or {}
    return {k: sorted({int(m) for m in (chosen.get(k) or allowed) if int(m) in allowed}) or list(allowed)
            for k, allowed in PLAYER_DURATIONS.items()}


def base_price(coach: Coach, kind: str, minutes: int | None = None) -> int:
    """Prix par joueur de la grille du coach pour cette formule et cette durée; une autre durée (séance du coach)
    au prorata du prix d'1 h (ou de la durée la plus proche)."""
    m = minutes or 60
    g = grid(coach)[kind]
    if m in g:
        return g[m]
    if not g:  # formule pas proposée aux joueurs: prix de l'heure au prorata
        return round({"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}[kind] * m / 60)
    ref = 60 if 60 in g else min(g, key=lambda x: abs(x - m))
    return round(g[ref] * m / ref)


SESSION_DURATIONS = (60, 90)  # durées d'une séance créée par le coach


def grid_price(coach: Coach, kind: str, minutes: int) -> int | None:
    """Prix par joueur que le coach a fixé dans Réglages › Formules pour cette formule et cette durée, tel quel
    (jamais au prorata); None = pas de prix réglé pour cette durée."""
    return grid(coach).get(kind, {}).get(minutes)


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
