"""Clubs et réservation des terrains par SMS."""
import os

import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Club, Coach, CourtBooking, CourtExpense, Player, Promotion, TrainingSession
from ..services.common import TUNIS, aware
from ..schemas import normalize_tn_phone
from ..services import courts, groups
from ..sms import get_sms_provider
from ..sms.base import SmsProvider

router = APIRouter(tags=["terrains"])
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "dev-webhook-secret")
if os.getenv("COOKIE_SECURE") == "1" and WEBHOOK_SECRET == "dev-webhook-secret":
    raise RuntimeError("WEBHOOK_SECRET must be set in production")


class ClubIn(BaseModel):
    name: str
    phone: str = ""
    sms_template: str = ""
    auto_send: bool = True

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v) if v.strip() else ""


def club_out(c: Club) -> dict:
    return {"id": c.id, "name": c.name, "phone": c.phone, "sms_template": c.sms_template, "auto_send": c.auto_send, "active": c.active,
            "default_template": courts.DEFAULT_TEMPLATE}


def _key(name: str) -> str:
    return " ".join(name.lower().split())


def owned_club(db: Session, coach: Coach, club_id: int) -> Club:
    c = db.get(Club, club_id)
    if not c or c.coach_id != coach.id:
        raise HTTPException(404, "Club introuvable")
    return c


@router.get("/clubs")
def list_clubs(all: bool = False, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Clubs où le coach entraîne (all=true: y compris ceux qu'il a retirés)."""
    q = select(Club).where(Club.coach_id == coach.id, Club.removed.is_(False)).order_by(Club.name)
    return [club_out(c) for c in db.scalars(q if all else q.where(Club.active.is_(True)))]


@router.get("/clubs/catalog")
def clubs_catalog(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Clubs connus dans l'application (ceux de tous les coachs), et ceux où ce coach entraîne."""
    mine = sorted((c.name for c in db.scalars(select(Club).where(Club.coach_id == coach.id, Club.active.is_(True)))), key=_key)
    known: dict[str, dict] = {}
    for c in db.scalars(select(Club).where(Club.removed.is_(False)).order_by(Club.name)):
        if _key(c.name) not in known and _key(c.name) not in {_key(m) for m in mine}:
            known[_key(c.name)] = {"name": c.name.strip(), "phone": c.phone}
    return {"mine": mine, "known": sorted(known.values(), key=lambda x: x["name"])}


class NewClub(BaseModel):
    name: str
    phone: str = ""

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v) if v.strip() else ""


class SelectionIn(BaseModel):
    names: list[str]  # clubs (connus) où le coach entraîne
    new: list[NewClub] = []  # clubs ajoutés à la main


@router.put("/clubs/selection")
def select_clubs(body: SelectionIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach choisit ses clubs: ceux qu'il quitte restent en base (historique, terrains) mais ne sont plus proposés."""
    known = {_key(c.name): c for c in db.scalars(select(Club).where(Club.removed.is_(False)))}  # nom et téléphone de référence
    wanted = {_key(n): n.strip() for n in body.names if n.strip()}
    extra = {_key(c.name): c for c in body.new if c.name.strip()}
    own = {_key(c.name): c for c in db.scalars(select(Club).where(Club.coach_id == coach.id))}
    for k, c in own.items():
        c.active = k in wanted or k in extra
    for k in set(wanted) | set(extra):
        if k not in own:
            name = known[k].name.strip() if k in known else extra[k].name.strip() if k in extra else wanted[k]
            phone = (extra[k].phone if k in extra else "") or (known[k].phone if k in known else "")
            db.add(Club(coach_id=coach.id, name=name, phone=phone))
        elif k in extra and extra[k].phone and not own[k].phone:
            own[k].phone = extra[k].phone
    db.commit()
    return clubs_catalog(coach, db)


@router.post("/clubs", status_code=201)
def create_club(body: ClubIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    c = Club(coach_id=coach.id, **body.model_dump())
    db.add(c)
    db.commit()
    return club_out(c)


@router.put("/clubs/{club_id}")
def update_club(club_id: int, body: ClubIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    c = owned_club(db, coach, club_id)
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    db.commit()
    return club_out(c)


def court_state_label(cb: CourtBooking, s: TrainingSession | None) -> str:
    """État affiché dans le calendrier des terrains (une couleur par état):
    complet = terrain réservé et séance pleine (ou plus personne ne peut la rejoindre); completable = confirmée
    (minimum atteint) mais il reste des places: le coach peut encore la compléter jusqu'au début;
    incomplet = réservé mais minimum pas atteint;
    libre = réservé, encore aucun joueur; demande = terrain demandé au club, pas encore confirmé; refuse / annule."""
    if cb.status in ("a_envoyer", "en_attente"):
        return "demande"
    if cb.status in ("refusee", "annulee"):
        return "refuse" if cb.status == "refusee" else "annule"
    if not s or not s.attendances or s.status == "annulee":
        return "libre"
    if len(s.attendances) < groups.min_needed(s):
        return "incomplet"
    upcoming = s.status == "prevue" and aware(s.start) > datetime.now(timezone.utc)
    return "completable" if upcoming and groups.capacity(s) > len(s.attendances) else "complet"


def cb_out(db: Session, cb: CourtBooking) -> dict:
    club = db.get(Club, cb.club_id)
    s = db.get(TrainingSession, cb.session_id) if cb.session_id else None
    names = [db.get(Player, a.player_id).name for a in s.attendances] if s else []
    coach = db.get(Coach, cb.coach_id)
    return {
        "id": cb.id, "status": cb.status, "source": cb.source, "club_id": club.id, "club_name": club.name, "club_phone": club.phone,
        "session_id": cb.session_id, "start": cb.start or s.start, "duration_min": s.duration_min if s else cb.duration_min,
        "session_status": s.status if s else None, "players": names, "court_label": cb.court_label, "free": s is None,
        "message": cb.message or (courts.render(db, coach, club, cb, s) if cb.source == "sms" else ""), "sent_at": cb.sent_at,
        "reply": cb.reply, "replied_at": cb.replied_at, "series_id": cb.series_id,
        "players_count": len(s.attendances) if s else 0, "min_needed": groups.min_needed(s) if s and s.attendances else None,
        "max_players": groups.capacity(s) if s and s.attendances else None,
        "kind": s.kind if s else None, "state": court_state_label(cb, s),
        "cost_millimes": court_cost(db, cb),
    }


def _span(x) -> tuple[datetime, datetime]:
    return aware(x.start), aware(x.start) + timedelta(minutes=x.duration_min)


def court_cost(db: Session, cb: CourtBooking) -> int:
    """Prix payé par le coach pour ce terrain (terrains saisis à la main, voir CourtExpense)."""
    if not cb.start:
        return 0
    lo, hi = _span(cb)
    return sum(e.amount_millimes for e in db.scalars(select(CourtExpense).where(CourtExpense.coach_id == cb.coach_id, CourtExpense.club_id == cb.club_id))
               if _span(e)[0] < hi and lo < _span(e)[1])


@router.get("/court-bookings")
def list_court_bookings(status: str | None = None, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    if courts.merge_free(db, coach.id):  # terrains libres qui se suivent (même terrain): un seul bloc
        db.commit()
    q = select(CourtBooking).where(CourtBooking.coach_id == coach.id, CourtBooking.status != "annulee")
    if status:
        q = q.where(CourtBooking.status == status)
    items = [cb_out(db, cb) for cb in db.scalars(q)]
    return sorted((i for i in items if i["session_status"] != "annulee"), key=lambda i: i["start"])


@router.get("/court-bookings/cover")
def court_cover(start: datetime, duration_min: int = 60, club_id: int | None = None, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Nouvelle séance: un de mes terrains réservés et libres couvre-t-il ce créneau ? Au club choisi (« here »),
    ou dans un autre de mes clubs (« elsewhere »: pour proposer de choisir ce club)."""
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    held = courts.held_covering(db, coach, start, duration_min)
    here = next((cb for cb in held if club_id and cb.club_id == club_id), None)
    other = [cb for cb in held if cb is not here and cb.club_id != club_id]
    # aucun terrain libre ne couvre l'horaire, mais un autre terrain le chevauche: pas de second terrain possible
    busy = [] if held else courts.overlapping(db, coach, start, duration_min)
    return {"here": cb_out(db, here) if here else None, "elsewhere": [cb_out(db, cb) for cb in other][:3],
            "busy": courts.busy_message(db, busy[0]) if busy else None}


class ManualIn(BaseModel):
    club_id: int
    start: datetime
    duration_min: int = 60
    court_label: str = ""
    # Terrain réservé de façon régulière: tous les jours, ou certains jours chaque semaine, jusqu'à une date
    repeat: str = "none"  # none / daily / weekly
    weekdays: list[int] = []  # 0 = lundi (weekly; par défaut le jour de la première date)
    until: date | None = None  # dernier jour inclus (par défaut 8 semaines)
    cost_millimes: int = 0  # prix payé au club pour ce terrain (chaque fois): déduit des revenus du coach


MAX_DAYS = 183  # six mois au plus


def _expense(db: Session, coach: Coach, club: Club, start: datetime, minutes: int, amount: int, series: str | None = None) -> None:
    """Prix du terrain payé par le coach (rien si 0), pour le créneau saisi."""
    if amount:
        db.add(CourtExpense(coach_id=coach.id, club_id=club.id, start=start, duration_min=minutes, amount_millimes=amount, series_id=series))


@router.post("/court-bookings/manual", status_code=201)
def add_manual(body: ManualIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Terrain que le coach a déjà réservé lui-même (téléphone, sur place…), disponible pour ses séances.
    Avec repeat, une série de terrains est créée (les créneaux déjà saisis au même club et à la même heure sont sautés)."""
    club = owned_club(db, coach, body.club_id)
    if not 15 <= body.duration_min <= 480 or body.repeat not in ("none", "daily", "weekly"):
        raise HTTPException(422, "Durée ou répétition invalide")
    if body.cost_millimes < 0:
        raise HTTPException(422, "Prix du terrain invalide.")
    label = body.court_label.strip()
    if body.repeat == "none":
        busy = courts.overlapping(db, coach, body.start, body.duration_min)
        if busy:  # un coach n'a qu'un terrain à la fois
            raise HTTPException(409, courts.busy_message(db, busy[0]))
        cb = courts.create_free_court(db, coach, club, body.start, body.duration_min, label)
        _expense(db, coach, club, body.start, body.duration_min, body.cost_millimes)
        db.commit()
        return cb_out(db, cb)
    first = aware(body.start).astimezone(TUNIS)
    until = body.until or (first.date() + timedelta(weeks=8))
    if until < first.date() or (until - first.date()).days > MAX_DAYS:
        raise HTTPException(422, "Date de fin invalide (six mois au plus)")
    days = set(body.weekdays or [first.weekday()]) if body.repeat == "weekly" else set(range(7))
    if not days <= set(range(7)):
        raise HTTPException(422, "Jours invalides")
    existing = {(c.club_id, aware(c.start)) for c in db.scalars(select(CourtBooking).where(
        CourtBooking.coach_id == coach.id, CourtBooking.status != "annulee", CourtBooking.start.is_not(None)))}
    series, now = str(uuid.uuid4()), datetime.now(timezone.utc)
    created, skipped = [], 0
    d = first.date()
    while d <= until:
        if d.weekday() in days:
            start = datetime.combine(d, first.timetz().replace(tzinfo=None), TUNIS).astimezone(timezone.utc)
            if start <= now or (club.id, start) in existing or courts.overlapping(db, coach, start, body.duration_min):
                skipped += 1  # passé, déjà saisi, ou un autre terrain à la même heure (un seul terrain à la fois)
            else:
                cb = courts.create_free_court(db, coach, club, start, body.duration_min, label)
                cb.series_id = series
                _expense(db, coach, club, body.start, body.duration_min, body.cost_millimes)
                created.append(cb)
        d += timedelta(days=1)
    if not created:
        raise HTTPException(409, "Aucun nouveau terrain : ces créneaux sont passés, déjà saisis, ou vous avez déjà un terrain à ces heures-là.")
    db.commit()
    return cb_out(db, created[0]) | {"created": len(created), "skipped": skipped}


def owned_cb(db: Session, coach: Coach, cb_id: int) -> CourtBooking:
    cb = db.get(CourtBooking, cb_id)
    if not cb or cb.coach_id != coach.id:
        raise HTTPException(404, "Demande introuvable")
    return cb


@router.post("/court-bookings/{cb_id}/send")
def send_now(cb_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    """(Ré)envoie le SMS au club."""
    cb = owned_cb(db, coach, cb_id)
    try:
        courts.send(db, coach, cb, sms)
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.commit()
    return cb_out(db, cb)


class StatusIn(BaseModel):
    status: str


@router.post("/court-bookings/{cb_id}/status")
def set_status(cb_id: int, body: StatusIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach tranche à la main (SMS envoyé depuis son téléphone, réponse par appel…)."""
    if body.status not in ("en_attente", "confirmee", "refusee"):
        raise HTTPException(422, "Statut invalide")
    cb = owned_cb(db, coach, cb_id)
    cb.status = body.status
    if body.status == "confirmee":
        courts.mark_confirmed(db, cb)
    db.commit()
    return cb_out(db, cb)


class ReplyIn(BaseModel):
    text: str


@router.post("/court-bookings/{cb_id}/reply")
def paste_reply(cb_id: int, body: ReplyIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach colle la réponse du club; on en déduit confirmée/refusée si le message est clair."""
    cb = owned_cb(db, coach, cb_id)
    verdict = courts.apply_reply(db, cb, body.text)
    db.commit()
    return cb_out(db, cb) | {"understood": verdict is not None}


@router.delete("/court-bookings/{cb_id}")
def delete_free_court(cb_id: int, series: bool = False, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Supprime un terrain réservé à la main qui n'est lié à aucune séance."""
    cb = owned_cb(db, coach, cb_id)
    if cb.session_id is not None or cb.source != "manuel":
        raise HTTPException(409, "Seul un terrain libre saisi à la main peut être supprimé")
    # series=true: ce terrain et les suivants de la même série encore libres (ceux déjà utilisés restent)
    targets = [cb]
    if series and cb.series_id:
        targets = list(db.scalars(select(CourtBooking).where(
            CourtBooking.series_id == cb.series_id, CourtBooking.session_id.is_(None), CourtBooking.start >= cb.start)))
    for t in targets:
        for p in db.scalars(select(Promotion).where(Promotion.court_booking_id == t.id)):
            db.delete(p)
        lo, hi = _span(t)  # terrain annulé: son prix ne compte plus dans les dépenses
        for e in db.scalars(select(CourtExpense).where(CourtExpense.coach_id == coach.id, CourtExpense.club_id == t.club_id)):
            if lo <= _span(e)[0] and _span(e)[1] <= hi:
                db.delete(e)
        db.delete(t)
    db.commit()
    return {"ok": True, "deleted": len(targets)}


@router.post("/court-bookings/send-due")
def send_due(coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    return {"sent": courts.send_due(db, coach, sms)}


class Inbound(BaseModel):
    phone: str
    text: str

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v)


@router.post("/courts/inbound")
def inbound(body: Inbound, x_webhook_secret: str = Header(""), db: Session = Depends(get_db)):
    """Webhook de la passerelle SMS: réponse d'un club à une demande en attente."""
    if x_webhook_secret != WEBHOOK_SECRET:
        raise HTTPException(403, "Secret invalide")
    cb = courts.match_inbound(db, body.phone)
    if not cb:
        return {"matched": False}
    verdict = courts.apply_reply(db, cb, body.text)
    db.commit()
    return {"matched": True, "court_booking_id": cb.id, "status": cb.status, "understood": verdict is not None}
