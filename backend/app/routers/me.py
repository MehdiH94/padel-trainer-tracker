"""Côté joueur: l'application simplifiée (solde de crédits, réservation, séances, propositions, progression).
Le joueur peut réserver chez tous les coachs: ses fiches chez chaque coach sont reliées à son compte (services/accounts)."""
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_player
from ..constants import CAPACITY
from ..db import get_db
from ..models import Attendance, Booking, Coach, CreditTx, Player, Proposal, TrainingSession
from ..services import booking as svc
from ..services import groups, marketplace
from ..services import email_verification as verification
from ..services.accounts import linked, row_for_coach
from ..services.common import aware
from ..services.finance import credit_balance
from ..sms import get_sms_provider
from ..sms.base import SmsProvider
from ..schemas import CHANNELS
from .profile import build_profile

router = APIRouter(prefix="/me", tags=["joueur"])


def _prices(coach: Coach) -> dict:
    return {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}


@router.get("")
def me(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    coach = db.get(Coach, player.coach_id)
    return {
        "name": player.name, "phone": player.phone, "email": player.email, "category": player.category, "gender": player.gender,
        "pref_kinds": player.pref_kinds.split(","), "coach_name": coach.name, "credits_millimes": credit_balance(db, player.id),
        "contact_channel": player.contact_channel,
        "email_verified": verification.is_verified(player), "can_book": verification.can_book(player),
        "slot_minutes": coach.slot_minutes, "prices": _prices(coach), "auto_confirm": coach.auto_confirm, "cancel_hours": coach.cancel_hours,
        "wallets": [{"coach_id": p.coach_id, "coach_name": db.get(Coach, p.coach_id).name, "credits_millimes": credit_balance(db, p.id)} for p in linked(db, player)],
    }


class ContactIn(BaseModel):
    contact_channel: str


@router.put("/contact")
def set_contact(body: ContactIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Le joueur choisit comment recevoir ses rappels de séance: WhatsApp, SMS ou e-mail."""
    if body.contact_channel not in CHANNELS:
        raise HTTPException(422, "Moyen de contact invalide")
    for p in linked(db, player):
        p.contact_channel = body.contact_channel
    db.commit()
    return {"contact_channel": player.contact_channel}


class ResendIn(BaseModel):
    base: str = ""


@router.post("/verify-email/resend")
def resend_verification(body: ResendIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Nouveau lien de vérification (au plus un par minute)."""
    if verification.is_verified(player):
        return {"ok": True, "already_verified": True}
    if not verification.can_resend(player):
        raise HTTPException(429, "Un e-mail vient d'être envoyé. Patientez une minute avant d'en demander un autre.")
    verification.send_link(db, player, body.base)
    db.commit()
    return {"ok": True, "email": player.email}


def _require_verified(player: Player) -> None:
    if not verification.can_book(player):
        raise HTTPException(403, "Vérifiez d'abord votre adresse e-mail (lien reçu par e-mail) pour pouvoir réserver.")


@router.get("/slots")
def slots(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    return [s.isoformat() for s in svc.free_slots(db, db.get(Coach, player.coach_id))]


@router.get("/suggestions")
def suggestions(kinds: str = "individuel,duo,groupe", player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Séances déjà montées qui correspondent au classement et aux types de séance choisis."""
    wanted = [k for k in kinds.split(",") if k in CAPACITY] or list(CAPACITY)
    player.pref_kinds = ",".join(wanted)  # on retient les préférences du joueur (utilisées pour lui proposer des groupes)
    db.commit()
    return svc.suggestions(db, db.get(Coach, player.coach_id), player, wanted)


class BookIn(BaseModel):
    kind: str | None = None
    start: datetime | None = None  # nouveau créneau
    coach_id: int | None = None  # coach du nouveau créneau (par défaut: le coach qui a invité le joueur)
    kinds: list[str] = []  # toutes les formules acceptées par le joueur (montrées au coach)
    session_id: int | None = None  # ou rejoindre une séance existante


@router.post("/book", status_code=201)
def book(body: BookIn, player: Player = Depends(current_player), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    _require_verified(player)
    s = db.get(TrainingSession, body.session_id) if body.session_id else None
    coach = db.get(Coach, s.coach_id if s else body.coach_id or player.coach_id)
    if not coach or (body.session_id and not s):
        raise HTTPException(404, "Séance introuvable")
    row = row_for_coach(db, player, coach)  # fiche du joueur chez ce coach (créée au besoin)
    try:
        if s:
            b = svc.request_join(db, coach, row, s, sms, kinds=body.kinds)
        elif body.start and body.kind:
            b = svc.request_new(db, coach, row, body.kind, body.start, sms, accepted_kinds=body.kinds)
        else:
            raise HTTPException(422, "Choisissez une séance ou un créneau")
    except svc.BookingError as e:
        db.rollback()
        raise HTTPException(409, str(e))
    return {"id": b.id, "status": b.status, "kind": b.kind, "start": b.start, "coach_name": coach.name,
            "price_millimes": b.price_millimes, "charged_millimes": b.charged_millimes, "credits_millimes": credit_balance(db, row.id)}


def _partners(db: Session, s: TrainingSession, me_ids: int | set[int]) -> list[dict]:
    me_ids = me_ids if isinstance(me_ids, set) else {me_ids}
    return [{"name": p.name, "category": p.category, "gender": p.gender} for p in (db.get(Player, i) for i in svc.attendee_ids(s)) if p.id not in me_ids]


@router.get("/sessions")
def my_sessions(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    ids = {p.id for p in linked(db, player)}
    coach_names = {c.id: c.name for c in db.scalars(select(Coach))}
    rows = db.execute(
        select(TrainingSession, Attendance).join(Attendance, Attendance.session_id == TrainingSession.id)
        .where(Attendance.player_id.in_(ids)).order_by(TrainingSession.start)
    ).all()
    bookings = list(db.scalars(select(Booking).where(Booking.player_id.in_(ids), Booking.status.in_(svc.ACTIVE))))
    by_session = {b.session_id: b for b in bookings if b.session_id and b.status != "en_attente"}
    upcoming, history = [], []
    for s, a in rows:
        b = by_session.get(s.id)
        item = {
            "session_id": s.id, "booking_id": b.id if b else None, "start": s.start, "duration_min": s.duration_min,
            "kind": s.kind, "club": s.club, "court_state": svc.court_state(db, s), "spots_left": svc.spots_left(db, s) if s.open else 0,
            "partners": _partners(db, s, ids), "status": b.status if b else "confirmee", "session_status": s.status,
            "coach_name": coach_names.get(s.coach_id, ""), "players_count": len(s.attendances), "min_needed": groups.min_needed(s),
            "booking_kind": b.kind if b else s.kind, "accepted_kinds": groups.split(b.accepted_kinds) if b else [],
            "worked_on": [t for t in a.worked_on.split(",") if t], "note": a.note, "to_improve": a.to_improve,
        }
        (upcoming if s.status == "prevue" and aware(s.start) >= now else history).append(item)
    for b in bookings:  # demandes pas encore traitées par le coach
        if b.status == "en_attente" and aware(b.start) >= now:
            s = db.get(TrainingSession, b.session_id) if b.session_id else None
            upcoming.append({
                "session_id": None, "booking_id": b.id, "start": b.start, "duration_min": b.duration_min, "kind": b.kind,
                "club": s.club if s else "", "court_state": None, "spots_left": 0, "partners": _partners(db, s, ids) if s else [],
                "coach_name": coach_names.get(b.coach_id, ""),
                "status": "en_attente", "session_status": "prevue", "worked_on": [], "note": "", "to_improve": "",
            })
    return {"upcoming": sorted(upcoming, key=lambda x: aware(x["start"])), "history": history[::-1][:60]}


@router.post("/bookings/{booking_id}/cancel")
def cancel(booking_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    b = db.get(Booking, booking_id)
    if not b or b.player_id not in {p.id for p in linked(db, player)}:
        raise HTTPException(404, "Réservation introuvable")
    try:
        refunded = svc.cancel_booking(db, db.get(Coach, b.coach_id), b)
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return {"refunded": refunded, "refunded_millimes": b.charged_millimes if refunded else 0, "credits_millimes": credit_balance(db, b.player_id)}


class FormulaIn(BaseModel):
    kind: str


@router.post("/bookings/{booking_id}/formula")
def change_formula(booking_id: int, body: FormulaIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Le joueur reconsidère son choix (ex. passer de « à deux » à « seul » si personne ne l'a rejoint)."""
    b = db.get(Booking, booking_id)
    if not b or b.player_id not in {p.id for p in linked(db, player)}:
        raise HTTPException(404, "Réservation introuvable")
    try:
        svc.reconsider(db, db.get(Coach, b.coach_id), b, body.kind)
    except svc.BookingError as e:
        db.rollback()
        raise HTTPException(409, str(e))
    db.commit()
    return {"status": b.status, "kind": b.kind, "price_millimes": b.price_millimes, "credits_millimes": credit_balance(db, b.player_id)}


@router.get("/proposals")
def proposals(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Séances que le coach propose au joueur."""
    ids = {x.id for x in linked(db, player)}
    out = []
    for p in db.scalars(select(Proposal).where(Proposal.player_id.in_(ids), Proposal.status == "proposee")):
        s = db.get(TrainingSession, p.session_id)
        coach = db.get(Coach, s.coach_id)
        if s.status != "prevue" or aware(s.start) < datetime.now(timezone.utc) or svc.spots_left(db, s) <= 0:
            continue
        out.append({
            "id": p.id, "session_id": s.id, "start": s.start, "duration_min": s.duration_min, "kind": s.kind, "club": s.club,
            "price_millimes": s.price_millimes or svc.price_for(coach, s.kind), "partners": _partners(db, s, ids), "coach_name": coach.name,
            "spots_left": svc.spots_left(db, s),
        })
    return sorted(out, key=lambda x: aware(x["start"]))


def _own_proposal(db: Session, player: Player, proposal_id: int) -> Proposal:
    p = db.get(Proposal, proposal_id)
    if not p or p.player_id not in {x.id for x in linked(db, player)} or p.status != "proposee":
        raise HTTPException(404, "Proposition introuvable")
    return p


@router.post("/proposals/{proposal_id}/accept")
def accept_proposal(proposal_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    _require_verified(player)
    p = _own_proposal(db, player, proposal_id)
    row = db.get(Player, p.player_id)
    coach = db.get(Coach, row.coach_id)
    try:
        b = svc.request_join(db, coach, row, db.get(TrainingSession, p.session_id), sms, force_accept=True)  # le coach l'a proposé: acceptation directe
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    p.status = "acceptee"
    db.commit()
    return {"id": b.id, "status": b.status, "price_millimes": b.price_millimes, "charged_millimes": b.charged_millimes, "credits_millimes": credit_balance(db, row.id)}


@router.post("/proposals/{proposal_id}/decline")
def decline_proposal(proposal_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    _own_proposal(db, player, proposal_id).status = "refusee"
    db.commit()
    return {"ok": True}


@router.get("/credits")
def credits(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    ids = {p.id for p in linked(db, player)}
    rows = db.scalars(select(CreditTx).where(CreditTx.player_id.in_(ids)).order_by(CreditTx.id.desc()).limit(30)).all()
    return [{"id": t.id, "amount_millimes": t.amount_millimes, "reason": t.reason, "created_at": t.created_at, "coach_name": db.get(Coach, t.coach_id).name} for t in rows]


@router.get("/progress")
def progress(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    full = build_profile(db, player.coach_id, player)
    return {k: full[k] for k in ("stats", "skills", "strengths", "weaknesses", "last_session")} | {"goals": player.goals}


# --- Prise de rendez-vous tous coachs confondus ------------------------------

@router.get("/coaches")
def coaches(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Tous les coachs de l'application (les « miens » en premier)."""
    out = [marketplace.coach_summary(db, c, player) for c in db.scalars(select(Coach).order_by(Coach.name))]
    return sorted(out, key=lambda c: not c["mine"])


@router.get("/coaches/{coach_id}")
def coach_page(coach_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    coach = db.get(Coach, coach_id)
    if not coach:
        raise HTTPException(404, "Coach introuvable")
    row = row_for_coach(db, player, coach, create=False)
    return marketplace.coach_profile(db, coach, player) | {"credits_millimes": credit_balance(db, row.id) if row else 0}


@router.get("/clubs")
def clubs(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    return marketplace.all_clubs(db)


@router.get("/offers")
def offers(day: date, kinds: str = "", kind: str = "", coach_id: int | None = None, club: str | None = None, period: str | None = None,
           hour: int | None = None, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Pour le jour choisi: groupes à rejoindre et créneaux à créer, selon le coach, le club et les formules acceptées
    (kinds=individuel,duo: plusieurs choix possibles)."""
    wanted = [k for k in (kinds or kind or "groupe").split(",") if k]
    if any(k not in CAPACITY for k in wanted):
        raise HTTPException(422, "Type de séance invalide")
    player.pref_kinds = ",".join(wanted)  # préférences retenues (groupes proposés par le coach)
    db.commit()
    return marketplace.offers(db, player, day, wanted, coach_id, club or None, period or None, hour)
