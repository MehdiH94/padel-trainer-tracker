"""Promotions sur un terrain déjà réservé et encore libre: le coach fixe une remise, ses joueurs sont prévenus."""
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach, current_player
from ..db import get_db
from ..models import Club, Coach, CourtBooking, Player, Promotion
from ..notify import Notifier, channel_for
from ..services import booking as booking_svc
from ..services import isolation
from ..services.accounts import account_of, contact_email, has_account, linked
from ..notify import letter
from ..services.common import TUNIS, aware, dinars, quand
from ..services.courts import JOURS
from ..services.pricing import base_price, duration_for, reduced
from ..sms import get_sms_provider
from ..sms.base import SmsProvider

router = APIRouter(tags=["promotions"])
APP_URL = os.getenv("APP_URL", "http://localhost:5173")


def _when(cb: CourtBooking) -> str:
    t = aware(cb.start).astimezone(TUNIS)
    return f"{JOURS[t.weekday()]} {t:%d/%m} à {t:%H}h{t:%M}"


def default_message(db: Session, coach: Coach, cb: CourtBooking, off: int) -> str:
    """Annonce d'un créneau en heures creuses: réduction en dinars par joueur."""
    club = db.get(Club, cb.club_id).name
    return letter(None, f"Ce créneau est en heures creuses : -{dinars(off)} par joueur !", [("Quand", quand(cb.start, cb.duration_min)), ("Où", club)],
                  "Venez choisir votre entraînement : seul, à deux ou en groupe, dites-moi comment vous voulez vous entraîner en réservant dans l'application.",
                  [("Application", APP_URL)], sign=coach.name)


def promo_out(db: Session, p: Promotion) -> dict:
    cb = db.get(CourtBooking, p.court_booking_id)
    coach = db.get(Coach, p.coach_id)
    taken = cb.session_id is not None
    return {
        "id": p.id, "coach_id": coach.id, "coach_name": coach.name, "court_booking_id": cb.id, "club": db.get(Club, cb.club_id).name,
        "start": cb.start, "duration_min": cb.duration_min, "discount_pct": p.discount_pct, "discount_millimes": p.discount_millimes, "message": p.message,
        "notified_count": p.notified_count, "active": p.active and not taken and aware(cb.start) > datetime.now(timezone.utc), "taken": taken,
        "prices": {k: reduced(base_price(coach, k, duration_for(coach, k)), p.discount_pct, p.discount_millimes) for k in ("individuel", "duo", "groupe")},
        "base_prices": {k: base_price(coach, k, duration_for(coach, k)) for k in ("individuel", "duo", "groupe")},
        "durations": {k: duration_for(coach, k) for k in ("individuel", "duo", "groupe")},
    }


def recipients(db: Session, coach: Coach) -> list[Player]:
    """Joueurs du coach, un seul message par compte (un joueur peut avoir plusieurs fiches).
    Comptes test à part: un coach test n'écrit qu'aux joueurs test, un vrai coach jamais à eux."""
    seen, out = set(), []
    for p in db.scalars(select(Player).where(Player.coach_id == coach.id)):
        key = account_of(db, p).id
        if key not in seen and isolation.same_world(db, coach, p):
            seen.add(key)
            out.append(p)
    return out


class PromoIn(BaseModel):
    court_booking_id: int
    discount_millimes: int  # réduction par joueur, en millimes
    message: str = ""  # vide = message par défaut


@router.get("/promotions")
def list_promotions(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    rows = db.scalars(select(Promotion).where(Promotion.coach_id == coach.id).order_by(Promotion.created_at.desc()))
    return {"items": [promo_out(db, p) for p in rows], "recipients": len(recipients(db, coach))}


@router.get("/promotions/preview")
def preview(court_booking_id: int, discount_millimes: int = 10000, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    cb = db.get(CourtBooking, court_booking_id)
    if not cb or cb.coach_id != coach.id:
        raise HTTPException(404, "Terrain introuvable")
    return {"message": default_message(db, coach, cb, discount_millimes), "recipients": len(recipients(db, coach))}


@router.post("/promotions", status_code=201)
def create_promotion(body: PromoIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    cb = db.get(CourtBooking, body.court_booking_id)
    if not cb or cb.coach_id != coach.id:
        raise HTTPException(404, "Terrain introuvable")
    if cb.session_id is not None or cb.status != "confirmee" or not cb.start or aware(cb.start) <= datetime.now(timezone.utc):
        raise HTTPException(409, "Ce terrain n'est plus libre")
    if body.discount_millimes <= 0:
        raise HTTPException(422, "Indiquez la réduction en dinars (plus de 0).")
    for old in db.scalars(select(Promotion).where(Promotion.court_booking_id == cb.id, Promotion.active.is_(True))):
        old.active = False  # une seule promotion à la fois par terrain
    message = body.message.strip() or default_message(db, coach, cb, body.discount_millimes)
    p = Promotion(coach_id=coach.id, court_booking_id=cb.id, discount_pct=0, discount_millimes=body.discount_millimes, message=message)
    db.add(p)
    db.flush()
    # Prévenir les joueurs par le moyen qu'ils ont choisi (SMS par défaut)
    notifier, sent = Notifier(sms), 0
    for pl in recipients(db, coach):
        channel = channel_for(pl, contact_email(db, pl))  # e-mail en version bêta
        if channel == "email" and not contact_email(db, pl):
            channel = "sms"
        booking_svc.app_notify(db, pl, f"Promo padel avec {coach.name}", message, "promo", promotion_id=p.id)
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
    coach_ids = {p.coach_id for p in linked(db, player) if p.coach_id and isolation.same_world(db, db.get(Coach, p.coach_id), player)}
    rows = db.scalars(select(Promotion).where(Promotion.active.is_(True), Promotion.coach_id.in_(coach_ids)))
    return sorted((x for x in (promo_out(db, p) for p in rows) if x["active"]), key=lambda x: aware(x["start"]))


# --- Terrain libre: le coach prévient les joueurs de son choix (sans remise) ------------------

def _free_court(db: Session, coach: Coach, cb_id: int) -> CourtBooking:
    cb = db.get(CourtBooking, cb_id)
    if not cb or cb.coach_id != coach.id:
        raise HTTPException(404, "Terrain introuvable")
    if cb.session_id is not None or cb.status != "confirmee" or not cb.start or aware(cb.start) <= datetime.now(timezone.utc):
        raise HTTPException(409, "Ce terrain n'est plus libre")
    return cb


def free_court_message(db: Session, coach: Coach, cb: CourtBooking) -> str:
    club = db.get(Club, cb.club_id).name
    return letter(None, "Ce créneau est disponible, venez vous entraîner !", [("Quand", quand(cb.start, cb.duration_min)), ("Où", club)],
                  "Seul, à deux ou en groupe : choisissez votre entraînement en réservant dans l'application.", [("Application", APP_URL)], sign=coach.name)


@router.get("/court-bookings/{cb_id}/announce")
def announce_preview(cb_id: int, discount_millimes: int = 0, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Joueurs du coach à qui annoncer ce terrain libre (ceux sans compte n'ont pas d'e-mail: rien ne leur est envoyé)."""
    cb = _free_court(db, coach, cb_id)
    players = sorted(recipients(db, coach), key=lambda p: (not has_account(p), p.name))
    return {
        "players": [{"id": p.id, "name": p.name, "category": p.category, "gender": p.gender, "has_account": has_account(p),
                     "contact_channel": p.contact_channel or "sms"} for p in players],
        "message": default_message(db, coach, cb, discount_millimes) if discount_millimes else free_court_message(db, coach, cb),
    }


class AnnounceIn(BaseModel):
    player_ids: list[int]
    message: str = ""
    discount_millimes: int = 0  # facultatif: heures creuses sur ce créneau, réduction en dinars par joueur


@router.post("/court-bookings/{cb_id}/announce")
def announce(cb_id: int, body: AnnounceIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    cb = _free_court(db, coach, cb_id)
    mine = {p.id: p for p in recipients(db, coach)}
    chosen = [mine[i] for i in body.player_ids if i in mine]
    off = body.discount_millimes
    if off < 0:
        raise HTTPException(422, "Réduction invalide.")
    message = body.message.strip() or (default_message(db, coach, cb, off) if off else free_court_message(db, coach, cb))
    subject = f"Heures creuses -{dinars(off)} avec {coach.name}" if off else f"Créneau de padel libre avec {coach.name}"
    sent = booking_svc.notify(db, chosen, subject, lambda _p: message, "promo" if off else "place")
    if off:  # la réduction s'applique aux réservations sur ce terrain (une seule promotion à la fois)
        for old in db.scalars(select(Promotion).where(Promotion.court_booking_id == cb.id, Promotion.active.is_(True))):
            old.active = False
        db.add(Promotion(coach_id=coach.id, court_booking_id=cb.id, discount_pct=0, discount_millimes=off, message=message, notified_count=sent))
    db.commit()
    return {"sent": sent}
