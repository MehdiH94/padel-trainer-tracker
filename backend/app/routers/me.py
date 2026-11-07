"""Côté joueur: l'application simplifiée (solde de crédits, réservation, séances, propositions, progression).
Le joueur peut réserver chez tous les coachs: ses fiches chez chaque coach sont reliées à son compte (services/accounts)."""
import secrets
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
from ..services import groups, isolation, marketplace
from ..services import email_verification as verification
from ..services.accounts import linked, row_for_coach
from ..services.common import aware
from ..services.finance import credit_balance, net_balance
from ..sms import get_sms_provider
from ..sms.base import SmsProvider
from ..schemas import CHANNELS
from .profile import build_profile, skills_of

router = APIRouter(prefix="/me", tags=["joueur"])


def _prices(coach: Coach) -> dict:
    return {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}


@router.get("")
def me(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    coach = _main_coach(db, player)  # None: compte créé sans coach (lien public), il en choisit un en réservant
    return {
        "name": player.name, "phone": player.phone, "email": player.email, "category": player.category, "gender": player.gender,
        "pref_kinds": player.pref_kinds.split(","),
        "favorites": {"coach_ids": [int(x) for x in (player.fav_coaches or "").split(",") if x.isdigit()],
                      "clubs": [c for c in (player.fav_clubs or "").split("|") if c]}, "coach_name": coach.name if coach else "", "coach_id": coach.id if coach else None,
        "credits_millimes": credit_balance(db, player.id),
        "contact_channel": player.contact_channel,
        "email_verified": verification.is_verified(player), "can_book": verification.can_book(player),
        "slot_minutes": coach.slot_minutes if coach else 60, "prices": _prices(coach) if coach else {"individuel": 0, "duo": 0, "groupe": 0},
        "auto_confirm": coach.auto_confirm if coach else False, "cancel_hours": coach.cancel_hours if coach else 24,
        "signup_status": player.signup_status,
        # Un solde par coach (pas de solde global): soit des crédits, soit un impayé, jamais les deux
        "wallets": [_wallet(db, p) for p in linked(db, player) if p.coach_id],
        "absences": _absences(db, player),
    }


def _absences(db: Session, player: Player) -> list[dict]:
    """Absences à venir (dans les 30 jours) des coachs chez qui le joueur s'entraîne: petit message à l'accueil."""
    from datetime import timedelta
    from ..models import TimeOff
    from ..services.common import TUNIS
    today = datetime.now(TUNIS).date()
    coach_ids = {p.coach_id for p in linked(db, player) if p.coach_id}
    out = []
    for t in db.scalars(select(TimeOff).where(TimeOff.coach_id.in_(coach_ids), TimeOff.end_date >= today,
                                              TimeOff.start_date <= today + timedelta(days=30)).order_by(TimeOff.start_date)):
        out.append({"coach_name": db.get(Coach, t.coach_id).name, "start_date": t.start_date.isoformat(), "end_date": t.end_date.isoformat(),
                    "reason": t.reason, "now": t.start_date <= today})
    return out


def _main_coach(db: Session, player: Player) -> Coach | None:
    """Coach du compte, sinon celui de sa première fiche chez un coach (compte créé par le lien public)."""
    for p in linked(db, player):
        coach = db.get(Coach, p.coach_id) if p.coach_id else None
        if coach and isolation.same_world(db, coach, player):  # jamais un coach d'un autre monde (comptes test)
            return coach
    return None


def _wallet(db: Session, p: Player) -> dict:
    net = net_balance(db, p)
    return {"coach_id": p.coach_id, "coach_name": db.get(Coach, p.coach_id).name, "credits_millimes": max(net, 0), "due_millimes": max(-net, 0)}


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
    coach = _main_coach(db, player)
    return [s.isoformat() for s in svc.free_slots(db, coach)] if coach else []


@router.get("/suggestions")
def suggestions(kinds: str = "individuel,duo,groupe", player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Séances déjà montées qui correspondent au classement et aux types de séance choisis."""
    wanted = [k for k in kinds.split(",") if k in CAPACITY] or list(CAPACITY)
    player.pref_kinds = ",".join(wanted)  # on retient les préférences du joueur (utilisées pour lui proposer des groupes)
    db.commit()
    coach = _main_coach(db, player)
    return svc.suggestions(db, coach, row_for_coach(db, player, coach, create=False) or player, wanted) if coach else []


class FavoritesIn(BaseModel):
    coach_ids: list[int] = []
    clubs: list[str] = []


@router.put("/favorites")
def set_favorites(body: FavoritesIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Coachs et clubs favoris du joueur: choisis d'office quand il ouvre Réserver."""
    player.fav_coaches = ",".join(str(i) for i in dict.fromkeys(body.coach_ids))[:120]
    player.fav_clubs = "|".join(c.replace("|", " ").strip() for c in dict.fromkeys(body.clubs) if c.strip())
    db.commit()
    return {"coach_ids": body.coach_ids, "clubs": [c for c in player.fav_clubs.split("|") if c]}


@router.get("/notifications")
def notifications(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Notifications de l'appli (messages des coachs, promotions, places libres, horaires proposés, réservations)."""
    from ..models import Notification
    rows = db.scalars(select(Notification).where(Notification.account_id == player.id).order_by(Notification.id.desc()).limit(50)).all()
    out = []
    for n in rows:
        b = db.get(Booking, n.booking_id) if n.booking_id else None
        coach = db.get(Coach, n.coach_id) if n.coach_id else None
        out.append({"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "created_at": n.created_at, "read": n.read_at is not None,
                    "coach_id": n.coach_id, "coach_name": coach.name if coach else "", "promotion_id": n.promotion_id,
                    # autre horaire proposé: encore à répondre ?
                    "proposal": {"booking_id": b.id, "start": b.proposed_start, "minutes": b.proposed_minutes, "old_start": b.start,
                                 "kind": b.kind, "open": b.status == "contre_proposition"} if b and n.kind == "contre_proposition" else None})
    return {"items": out, "unread": sum(1 for n in rows if n.read_at is None)}


@router.post("/notifications/read")
def notifications_read(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    from ..models import Notification
    now = datetime.now(timezone.utc)
    for n in db.scalars(select(Notification).where(Notification.account_id == player.id, Notification.read_at.is_(None))):
        n.read_at = now
    db.commit()
    return {"ok": True}


class AnswerIn(BaseModel):
    accept: bool


@router.post("/bookings/{booking_id}/proposal")
def answer_proposal(booking_id: int, body: AnswerIn, player: Player = Depends(current_player), db: Session = Depends(get_db),
                    sms: SmsProvider = Depends(get_sms_provider)):
    """Réponse à l'autre horaire proposé par le coach: oui = séance acceptée à ce nouvel horaire, non = demande abandonnée."""
    b = db.get(Booking, booking_id)
    if not b or b.player_id not in {p.id for p in linked(db, player)}:
        raise HTTPException(404, "Réservation introuvable")
    try:
        svc.answer_proposal(db, b, body.accept, sms)
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return {"status": b.status, "start": b.start}


class BookIn(BaseModel):
    kind: str | None = None
    start: datetime | None = None  # nouveau créneau
    coach_id: int | None = None  # coach du nouveau créneau (par défaut: le coach qui a invité le joueur)
    kinds: list[str] = []  # toutes les formules acceptées par le joueur (montrées au coach)
    minutes: int | None = None  # durée du nouveau créneau (60 ou 90)
    durations: dict[str, list[int]] | None = None  # durées acceptées par formule ({"duo": [60, 90]}; seul = toujours 60)
    session_id: int | None = None  # ou rejoindre une séance existante


@router.post("/book", status_code=201)
def book(body: BookIn, player: Player = Depends(current_player), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)):
    _require_verified(player)
    s = db.get(TrainingSession, body.session_id) if body.session_id else None
    main = _main_coach(db, player)
    coach_id = s.coach_id if s else body.coach_id or (main.id if main else None)
    if body.session_id and not s:
        raise HTTPException(404, "Séance introuvable")
    coach = db.get(Coach, coach_id) if coach_id else None
    if not coach:
        raise HTTPException(422, "Choisissez d'abord un coach.")
    if not isolation.same_world(db, coach, player):  # compte test chez un vrai coach (ou l'inverse)
        raise HTTPException(404, "Coach introuvable")
    row = row_for_coach(db, player, coach)  # fiche du joueur chez ce coach (créée au besoin)
    try:
        if s:
            b = svc.request_join(db, coach, row, s, sms, kinds=body.kinds, durations=body.durations)
        elif body.start and body.kind:
            b = svc.request_new(db, coach, row, body.kind, body.start, sms, accepted_kinds=body.kinds, minutes=body.minutes, durations=body.durations)
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
        # séance montée par le coach (pas de réservation): mêmes règles d'annulation, d'après le type de séance
        deadline = svc.cancel_deadline(b) if b else aware(s.start) - svc.CANCEL_BEFORE.get(s.kind, svc.CANCEL_BEFORE["groupe"])
        item = {
            # durée jouée à la taille actuelle (seul = 1 h); « jusqu'à » = durée gardée si d'autres joueurs le rejoignent
            "session_id": s.id, "booking_id": b.id if b else None, "start": s.start,
            "duration_min": groups.played_minutes(s) if groups.is_dynamic(s) else s.duration_min, "held_min": s.duration_min,
            "kind": s.kind, "club": s.club, "court_state": svc.court_state(db, s), "spots_left": svc.spots_left(db, s) if s.open else 0,
            "partners": _partners(db, s, ids), "status": b.status if b else "confirmee", "session_status": s.status,
            "coach_name": coach_names.get(s.coach_id, ""), "players_count": len(s.attendances), "min_needed": groups.min_needed(s),
            "booking_kind": b.kind if b else s.kind, "accepted_kinds": groups.split(b.accepted_kinds) if b else [],
            "can_cancel": svc.can_cancel(b) if b else now <= deadline, "cancel_until": deadline,
            "worked_on": [t for t in a.worked_on.split(",") if t], "note": a.note, "to_improve": a.to_improve,
        }
        (upcoming if s.status == "prevue" and aware(s.start) >= now else history).append(item)
    for b in bookings:  # demandes pas encore traitées par le coach (ou autre horaire proposé)
        if b.status in ("en_attente", "contre_proposition") and aware(b.proposed_start if b.status == "contre_proposition" else b.start) >= now:
            s = db.get(TrainingSession, b.session_id) if b.session_id else None
            upcoming.append({
                "session_id": None, "booking_id": b.id, "start": b.start, "duration_min": b.duration_min, "kind": b.kind,
                "club": s.club if s else "", "court_state": None, "spots_left": 0, "partners": _partners(db, s, ids) if s else [],
                "coach_name": coach_names.get(b.coach_id, ""), "can_cancel": True, "cancel_until": None,
                "status": b.status, "session_status": "prevue", "worked_on": [], "note": "", "to_improve": "",
                "proposed_start": b.proposed_start, "proposed_minutes": b.proposed_minutes,
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


@router.post("/sessions/{session_id}/booking")
def session_booking(session_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Séance montée par le coach: réservation créée à la demande, pour annuler ou se faire remplacer."""
    s = db.get(TrainingSession, session_id)
    ids = {p.id for p in linked(db, player)}
    a = next((x for x in s.attendances if x.player_id in ids), None) if s else None
    if not a:
        raise HTTPException(404, "Séance introuvable")
    try:
        b = svc.ensure_booking(db, s, a.player_id)
    except svc.BookingError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return {"booking_id": b.id}


@router.post("/bookings/{booking_id}/replacement")
def replacement_link(booking_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Trop tard pour annuler: lien de la séance à envoyer à un joueur qui prendra la place."""
    b = db.get(Booking, booking_id)
    if not b or b.player_id not in {p.id for p in linked(db, player)}:
        raise HTTPException(404, "Réservation introuvable")
    if b.status not in ("acceptee", "confirmee", "attente_joueurs") or not b.session_id or aware(b.start) <= datetime.now(timezone.utc):
        raise HTTPException(409, "Cette réservation ne peut plus être cédée")
    if not b.replace_token:
        b.replace_token = secrets.token_urlsafe(16)
        db.commit()
    return {"path": f"/remplacer/{b.replace_token}"}


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
        if not isolation.same_world(db, coach, player):  # comptes test à part
            continue
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
    if not isolation.same_world(db, coach, player):
        raise HTTPException(404, "Proposition introuvable")
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
    rows = db.scalars(select(CreditTx).where(CreditTx.player_id.in_(ids)).order_by(CreditTx.id.desc()).limit(60)).all()
    out = []
    for t in rows:
        s = db.get(TrainingSession, t.session_id) if t.session_id else None
        if not s and t.booking_id:  # réservation débitée à la validation: la séance de la réservation
            b = db.get(Booking, t.booking_id)
            s = db.get(TrainingSession, b.session_id) if b and b.session_id else None
        out.append({"id": t.id, "amount_millimes": t.amount_millimes, "reason": t.reason, "created_at": t.created_at,
                    "coach_id": t.coach_id, "coach_name": db.get(Coach, t.coach_id).name,
                    "session": {"start": s.start, "kind": s.kind, "duration_min": s.duration_min} if s else None})
    return out


@router.get("/progress")
def progress(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Progression du joueur, tous coachs confondus: séances de chacune de ses fiches, et la dernière note
    de chaque coup quel que soit le coach qui l'a donnée (radar visible dès la première évaluation)."""
    rows = [p for p in linked(db, player) if p.coach_id]  # sans coach: pas encore d'historique
    profiles = [build_profile(db, p.coach_id, p) for p in rows]
    stats = {k: sum(pr["stats"][k] for pr in profiles) for k in ("done_count", "cancelled_count", "upcoming_count")}
    stats["hours"] = round(sum(pr["stats"]["hours"] for pr in profiles), 1)
    stats["since"] = min((pr["stats"]["since"] for pr in profiles if pr["stats"]["since"]), default=None)
    # critères des coachs du joueur (dans l'ordre de ses fiches), sans doublon
    from ..models import Coach as _Coach
    from .profile import criteria_for
    crit: list[str] = []
    for p in rows:
        crit += [c for c in criteria_for(db.get(_Coach, p.coach_id), p) if c not in crit]
    skills = skills_of(db, [p.id for p in rows] or [player.id], crit or None)
    lasts = [pr["last_session"] for pr in profiles if pr["last_session"]]
    # Une araignée par coach (couleurs superposées) et ses notes sur le joueur
    by_coach = []
    for p in rows:
        c = db.get(_Coach, p.coach_id)
        sk = skills_of(db, [p.id], criteria_for(c, p))
        if any(x["score"] is not None for x in sk["skills"]) or p.notes:
            by_coach.append({"coach_id": c.id, "coach_name": c.name, "skills": sk["skills"], "notes": p.notes})
    return {"stats": stats, **skills, "last_session": max(lasts, key=lambda h: aware(h["start"]), default=None), "goals": player.goals,
            "by_coach": by_coach, "play": _play_time(db, player, rows)}


def _play_time(db: Session, player: Player, rows: list[Player]) -> dict:
    """Heures de padel du mois et au total: entraînements effectués, matchs amicaux, tournois."""
    from ..models import PlayerEvent
    from ..services.common import TUNIS
    month = datetime.now(TUNIS).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    now = datetime.now(timezone.utc)
    out = {k: {"month": 0.0, "total": 0.0, "count": 0} for k in ("entrainement", "match", "tournoi")}
    def add(k, start, minutes):
        out[k]["total"] += minutes / 60
        out[k]["count"] += 1
        if aware(start) >= month:
            out[k]["month"] += minutes / 60
    ids = {p.id for p in rows}
    for s in db.scalars(select(TrainingSession).join(Attendance).where(Attendance.player_id.in_(ids), TrainingSession.status == "effectuee")):
        add("entrainement", s.start, s.duration_min)
    for e in db.scalars(select(PlayerEvent).where(PlayerEvent.account_id == player.id)):
        if aware(e.start) <= now and e.kind in out:  # « autre » (kiné, physique…) n'est pas du temps de jeu
            add(e.kind, e.start, e.duration_min)
    return {k: {kk: round(v, 1) if kk != "count" else v for kk, v in d.items()} for k, d in out.items()}


# --- Prise de rendez-vous tous coachs confondus ------------------------------

@router.get("/coaches")
def coaches(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Tous les coachs de l'application (les « miens » en premier)."""
    out = [marketplace.coach_summary(db, c, player) for c in isolation.visible_coaches(db, player)]
    return sorted(out, key=lambda c: not c["mine"])


@router.get("/coaches/{coach_id}")
def coach_page(coach_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    coach = db.get(Coach, coach_id)
    if not coach or not isolation.same_world(db, coach, player):
        raise HTTPException(404, "Coach introuvable")
    row = row_for_coach(db, player, coach, create=False)
    return marketplace.coach_profile(db, coach, player) | {"credits_millimes": credit_balance(db, row.id) if row else 0}


@router.get("/clubs")
def clubs(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    return marketplace.all_clubs(db, isolation.visible_coaches(db, player))


@router.get("/offers")
def offers(day: date, kinds: str = "", kind: str = "", coach_id: int | None = None, coach_ids: str = "", club: str | None = None, clubs: str = "", period: str | None = None,
           hour: int | None = None, duo_min: str = "", groupe_min: str = "", player: Player = Depends(current_player), db: Session = Depends(get_db)):
    """Pour le jour choisi: groupes à rejoindre et créneaux à créer, selon le coach, le club et les formules acceptées
    (kinds=individuel,duo: plusieurs choix possibles)."""
    wanted = [k for k in (kinds or kind or "groupe").split(",") if k]
    if any(k not in CAPACITY for k in wanted):
        raise HTTPException(422, "Type de séance invalide")
    player.pref_kinds = ",".join(wanted)  # préférences retenues (groupes proposés par le coach)
    db.commit()
    chosen = {int(x) for x in coach_ids.split(",") if x.strip().isdigit()} or ({coach_id} if coach_id else None)  # un ou plusieurs coachs
    durations = {k: [int(x) for x in v.split(",") if x.strip().isdigit()] for k, v in (("duo", duo_min), ("groupe", groupe_min))}  # ex. duo_min=60,90
    places = [c for c in clubs.split("|") if c.strip()] or ([club] if club else [])  # clubs=La Marsa|Gammarth
    return marketplace.offers(db, player, day, wanted, chosen, places, period or None, hour, durations)
