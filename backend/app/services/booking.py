"""Réservations des joueurs payées avec leurs crédits: créneaux libres, suggestions de groupes, demandes."""
from datetime import datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..constants import CAPACITY, category_index, compatible
from ..models import Attendance, Availability, Booking, Club, Coach, CourtBooking, CreditTx, Player, Proposal, TrainingSession
from ..sms.base import SmsProvider
from . import courts
from .common import TUNIS, aware
from .finance import credit_balance

HORIZON_DAYS = 14
MIN_NOTICE_H = 2
ACTIVE = ("en_attente", "acceptee", "confirmee")


class BookingError(Exception):
    pass


class InsufficientCredits(BookingError):
    pass


def price_for(coach: Coach, kind: str) -> int:
    return {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}[kind]


def attendee_ids(s: TrainingSession) -> list[int]:
    return [a.player_id for a in s.attendances]


def pending_joins(db: Session, s: TrainingSession) -> int:
    return len(db.scalars(select(Booking.id).where(Booking.session_id == s.id, Booking.status == "en_attente")).all())


def spots_left(db: Session, s: TrainingSession) -> int:
    return CAPACITY[s.kind] - len(s.attendances) - pending_joins(db, s)


# --- Créneaux libres ----------------------------------------------------

def free_slots(db: Session, coach: Coach, now: datetime | None = None) -> list[datetime]:
    """Créneaux libres (UTC), triés, sur les HORIZON_DAYS prochains jours."""
    now = now or datetime.now(timezone.utc)
    earliest = now + timedelta(hours=MIN_NOTICE_H)
    windows = db.scalars(select(Availability).where(Availability.coach_id == coach.id)).all()

    busy: list[tuple[datetime, datetime]] = []
    for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status != "annulee")):
        busy.append((aware(s.start), aware(s.start) + timedelta(minutes=s.duration_min)))
    # demandes de nouvelle séance pas encore traitées: le créneau est retenu
    for b in db.scalars(select(Booking).where(Booking.coach_id == coach.id, Booking.status == "en_attente", Booking.session_id.is_(None))):
        busy.append((aware(b.start), aware(b.start) + timedelta(minutes=b.duration_min)))

    step = timedelta(minutes=coach.slot_minutes)
    out = []
    today = now.astimezone(TUNIS).date()
    for off in range(HORIZON_DAYS + 1):
        day = today + timedelta(days=off)
        for w in (w for w in windows if w.weekday == day.weekday()):
            cur = datetime.combine(day, time.fromisoformat(w.start_time), TUNIS).astimezone(timezone.utc)
            end = datetime.combine(day, time.fromisoformat(w.end_time), TUNIS).astimezone(timezone.utc)
            while cur + step <= end:
                if cur >= earliest and not any(cur < b_end and cur + step > b_start for b_start, b_end in busy):
                    out.append(cur)
                cur += step
    return sorted(set(out))


# --- Suggestions de séances existantes ----------------------------------

def court_state(db: Session, s: TrainingSession) -> str | None:
    cb = db.scalar(select(CourtBooking).where(CourtBooking.session_id == s.id, CourtBooking.status != "annulee"))
    return cb.status if cb else None


def fits_session(db: Session, player: Player, s: TrainingSession) -> tuple[bool, float]:
    """Le joueur peut-il rejoindre cette séance ? (compatible avec TOUS les joueurs déjà inscrits)
    Retourne aussi l'écart de catégorie le plus grand, pour le classement."""
    others = [db.get(Player, pid) for pid in attendee_ids(s)]
    if not others:  # séance vide: on regarde le niveau visé, s'il y en a un
        if not s.level:
            return True, 0.0
        gap = abs(category_index(player.category) - category_index(s.level))
        return gap <= 1, gap
    ok = all(compatible(player.category, player.gender, o.category, o.gender) for o in others)
    return ok, max(abs(category_index(player.category) - category_index(o.category)) for o in others)


def suggestions(db: Session, coach: Coach, player: Player, kinds: list[str]) -> list[dict]:
    """Séances déjà montées avec des places libres, classées de la plus proche de la demande à la moins proche."""
    earliest = datetime.now(timezone.utc) + timedelta(hours=MIN_NOTICE_H)
    out = []
    for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.open.is_(True), TrainingSession.status == "prevue")):
        if aware(s.start) < earliest or player.id in attendee_ids(s) or spots_left(db, s) <= 0:
            continue
        ok, gap = fits_session(db, player, s)
        if not ok:  # au plus un cran d'écart avec chaque joueur, règle particulière pour les dames
            continue
        kind_penalty = 0 if s.kind in kinds else 1.5
        days = (aware(s.start) - earliest).total_seconds() / 86400
        players = [db.get(Player, pid) for pid in attendee_ids(s)]
        out.append({
            "session_id": s.id, "start": s.start, "duration_min": s.duration_min, "kind": s.kind, "club": s.club,
            "spots_left": spots_left(db, s), "capacity": CAPACITY[s.kind], "price_millimes": s.price_millimes or price_for(coach, s.kind),
            "players": [{"name": p.name, "category": p.category, "gender": p.gender} for p in players],
            "level": s.level, "gap": round(gap, 1), "court_state": court_state(db, s),
            "match": "ideal" if kind_penalty == 0 else "proche", "_score": gap + kind_penalty + days * 0.03,
        })
    out.sort(key=lambda x: x["_score"])
    for x in out:
        x.pop("_score")
    return out[:8]


# --- Demandes -----------------------------------------------------------

def _debit(db: Session, coach: Coach, player: Player, price: int, b: Booking) -> None:
    if price and credit_balance(db, player.id) < price:
        raise InsufficientCredits("Crédits insuffisants")
    if price:
        db.add(CreditTx(coach_id=coach.id, player_id=player.id, amount_millimes=-price, reason="reservation", booking_id=b.id))


def request_join(db: Session, coach: Coach, player: Player, s: TrainingSession, sms: SmsProvider | None = None, *, force_accept: bool = False) -> Booking:
    """Le joueur demande une place dans une séance existante."""
    if not s.open or s.status != "prevue" or aware(s.start) < datetime.now(timezone.utc):
        raise BookingError("Cette séance n'est plus disponible")
    if player.id in attendee_ids(s) or db.scalar(select(Booking).where(Booking.session_id == s.id, Booking.player_id == player.id, Booking.status.in_(ACTIVE))):
        raise BookingError("Vous êtes déjà inscrit à cette séance")
    if spots_left(db, s) <= 0:
        raise BookingError("Cette séance est complète")
    if not force_accept and not fits_session(db, player, s)[0]:
        raise BookingError("Votre classement n'est pas compatible avec les joueurs de cette séance")
    price = s.price_millimes or price_for(coach, s.kind)
    b = Booking(coach_id=coach.id, player_id=player.id, kind=s.kind, start=s.start, duration_min=s.duration_min, session_id=s.id, charged_millimes=price)
    db.add(b)
    db.flush()
    _debit(db, coach, player, price, b)
    if force_accept or coach.auto_confirm:
        accept(db, coach, b, sms)
    db.commit()
    return b


def request_new(db: Session, coach: Coach, player: Player, kind: str, start: datetime, sms: SmsProvider | None = None) -> Booking:
    """Le joueur demande un nouveau créneau (séance de ce type, ouverte aux autres joueurs si duo/groupe)."""
    if kind not in CAPACITY:
        raise BookingError("Type de séance invalide")
    if aware(start) not in free_slots(db, coach):
        raise BookingError("Ce créneau n'est plus disponible")
    price = price_for(coach, kind)
    b = Booking(coach_id=coach.id, player_id=player.id, kind=kind, start=aware(start), duration_min=coach.slot_minutes, charged_millimes=price)
    db.add(b)
    db.flush()
    _debit(db, coach, player, price, b)
    held = courts.held_covering(db, coach, b.start, b.duration_min)
    if coach.auto_confirm and held:
        accept(db, coach, b, sms, court=held[0])  # terrain disponible: validation automatique
    db.commit()
    return b


def accept(db: Session, coach: Coach, b: Booking, sms: SmsProvider | None = None, *, court: CourtBooking | None = None, club: Club | None = None) -> None:
    """Le coach accepte. Avec un terrain libre (court): confirmée. Avec un club: demande de terrain envoyée, en attente.
    Sans rien: acceptée, terrain à confirmer à la main."""
    if b.status != "en_attente":
        raise BookingError("Demande déjà traitée")
    player = db.get(Player, b.player_id)
    if b.session_id:  # rejoindre une séance existante
        s = db.get(TrainingSession, b.session_id)
        if len(s.attendances) >= CAPACITY[s.kind]:
            raise BookingError("Cette séance est complète")
        s.attendances.append(Attendance(player_id=player.id, credit_paid_millimes=b.charged_millimes))
        state = court_state(db, s)
        b.status = "confirmee" if state in (None, "confirmee") else "acceptee"
        return
    s = TrainingSession(
        coach_id=coach.id, start=b.start, duration_min=b.duration_min, kind=b.kind, level=player.category,
        price_millimes=b.charged_millimes, price_mode="par_joueur", open=b.kind != "individuel",
    )
    s.attendances = [Attendance(player_id=player.id, credit_paid_millimes=b.charged_millimes)]
    db.add(s)
    db.flush()
    b.session_id = s.id
    if court:
        court.session_id, court.start, court.duration_min = s.id, b.start, b.duration_min
        s.club, s.court = db.get(Club, court.club_id).name, court.court_label
        b.status = "confirmee"
    elif club:
        cb = courts.create_for_session(db, coach, club, s)
        s.club = club.name
        db.flush()
        if sms and club.phone:
            courts.send(db, coach, cb, sms)
        b.status = "acceptee"
    else:
        b.status = "acceptee"


def _refund(db: Session, b: Booking) -> None:
    if b.charged_millimes:
        db.add(CreditTx(coach_id=b.coach_id, player_id=b.player_id, amount_millimes=b.charged_millimes, reason="remboursement", booking_id=b.id))


def refuse(db: Session, b: Booking) -> None:
    if b.status != "en_attente":
        raise BookingError("Demande déjà traitée")
    b.status = "refusee"
    _refund(db, b)


def _release(db: Session, b: Booking) -> None:
    """Retire le joueur de la séance; si elle est vide elle est annulée et le terrain redevient libre."""
    if not b.session_id:
        return
    s = db.get(TrainingSession, b.session_id)
    s.attendances = [a for a in s.attendances if a.player_id != b.player_id]
    if not s.attendances and s.status == "prevue":
        s.status = "annulee"
        for cb in db.scalars(select(CourtBooking).where(CourtBooking.session_id == s.id)):
            if cb.status == "confirmee":
                cb.session_id = None  # le terrain reste réservé: on pourra le réutiliser
            else:
                cb.status = "annulee"


def cancel_booking(db: Session, coach: Coach, b: Booking) -> bool:
    """Annulation par le joueur. Retourne True si les crédits sont remboursés."""
    if b.status not in ACTIVE:
        raise BookingError("Cette réservation ne peut plus être annulée")
    if aware(b.start) <= datetime.now(timezone.utc):
        raise BookingError("Cette séance est déjà passée")
    refund = b.status == "en_attente" or aware(b.start) - datetime.now(timezone.utc) >= timedelta(hours=coach.cancel_hours)
    was_pending = b.status == "en_attente"
    b.status = "annulee"
    if not was_pending:
        _release(db, b)
    if refund:
        _refund(db, b)
    return refund


def coach_cancel_session(db: Session, s: TrainingSession) -> None:
    """Le coach annule une séance: toutes les réservations payées avec des crédits sont remboursées."""
    for b in db.scalars(select(Booking).where(Booking.session_id == s.id, Booking.status.in_(ACTIVE))):
        b.status = "annulee"
        _refund(db, b)
    for p in db.scalars(select(Proposal).where(Proposal.session_id == s.id, Proposal.status == "proposee")):
        p.status = "refusee"


# --- Propositions du coach ---------------------------------------------

def candidates(db: Session, coach: Coach, s: TrainingSession) -> list[dict]:
    """Joueurs qui pourraient compléter la séance: compatibles avec tous les inscrits, type de séance souhaité."""
    ids = attendee_ids(s)
    asked = {p.player_id for p in db.scalars(select(Proposal).where(Proposal.session_id == s.id, Proposal.status == "proposee"))}
    out = []
    for p in db.scalars(select(Player).where(Player.coach_id == coach.id)):
        if p.id in ids or p.id in asked or s.kind not in p.pref_kinds.split(","):
            continue
        ok, gap = fits_session(db, p, s)
        if ok:
            out.append({"player_id": p.id, "name": p.name, "category": p.category, "gender": p.gender, "has_account": p.password_hash is not None, "gap": round(gap, 1)})
    return sorted(out, key=lambda x: (x["gap"], not x["has_account"]))[:6]
