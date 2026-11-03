"""Terrains: demandes par SMS aux clubs, terrains réservés à la main, analyse des réponses."""
import re
import unicodedata
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Booking, Club, Coach, CourtBooking, Player, TrainingSession
from ..sms.base import SmsProvider
from .common import TUNIS, aware, quand

SEND_AHEAD_DAYS = 7
DEFAULT_TEMPLATE = (
    "Bonjour, je souhaiterais réserver un terrain le {date} de {debut} à {fin} ({duree} min) "
    "pour une séance de padel avec {joueurs}. Merci de confirmer par SMS (OUI / NON). {coach}"
)
JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]


def render(db: Session, coach: Coach, club: Club, cb: CourtBooking, s: TrainingSession | None) -> str:
    start = aware(cb.start or s.start).astimezone(TUNIS)
    minutes = s.duration_min if s else cb.duration_min
    end = start + timedelta(minutes=minutes)
    names = [db.get(Player, a.player_id).name for a in s.attendances] if s else []
    values = {
        "date": f"{JOURS[start.weekday()]} {start:%d/%m}", "debut": f"{start:%H}h{start:%M}", "fin": f"{end:%H}h{end:%M}",
        "duree": minutes, "joueurs": ", ".join(names) or "mes joueurs", "coach": coach.name,
        "club": club.name, "terrain": cb.court_label or "",
    }
    try:
        return (club.sms_template or DEFAULT_TEMPLATE).format(**values)
    except (KeyError, IndexError, ValueError):  # modèle invalide: on retombe sur le modèle par défaut
        return DEFAULT_TEMPLATE.format(**values)


def create_for_session(db: Session, coach: Coach, club: Club, s: TrainingSession, *, already_booked: bool = False) -> CourtBooking:
    """Demande de terrain liée à une séance. already_booked: le coach a déjà réservé à la main, pas de SMS."""
    cb = CourtBooking(
        coach_id=coach.id, session_id=s.id, club_id=club.id, start=s.start, duration_min=s.duration_min,
        court_label=s.court, source="manuel" if already_booked else "sms", status="confirmee" if already_booked else "a_envoyer",
    )
    db.add(cb)
    return cb


def create_free_court(db: Session, coach: Coach, club: Club, start: datetime, duration_min: int, court_label: str = "") -> CourtBooking:
    """Terrain déjà réservé par le coach, pas encore attribué à une séance."""
    cb = CourtBooking(
        coach_id=coach.id, club_id=club.id, start=start, duration_min=duration_min, court_label=court_label,
        source="manuel", status="confirmee",
    )
    db.add(cb)
    return cb


def take_part(db: Session, cb: CourtBooking, s: TrainingSession) -> CourtBooking:
    """Une séance utilise une partie d'un terrain réservé (ex. 9 h-10 h dans un bloc 8 h-12 h): le terrain est
    découpé, la séance garde son heure, le temps avant et après reste libre pour d'autres séances."""
    start, end = aware(s.start), aware(s.start) + timedelta(minutes=s.duration_min)
    cb_start, cb_end = aware(cb.start), aware(cb.start) + timedelta(minutes=cb.duration_min)
    for a, b in ((cb_start, start), (end, cb_end)):
        if b > a:
            db.add(CourtBooking(coach_id=cb.coach_id, club_id=cb.club_id, start=a, duration_min=int((b - a).total_seconds() // 60),
                                court_label=cb.court_label, source=cb.source, status="confirmee", series_id=cb.series_id))
    cb.session_id, cb.start, cb.duration_min = s.id, start, s.duration_min
    return cb


def span(db: Session, cb: CourtBooking) -> tuple[datetime, datetime] | None:
    """Début et fin d'un terrain (celui d'une séance prend l'heure de la séance)."""
    s = db.get(TrainingSession, cb.session_id) if cb.session_id else None
    start = cb.start or (s.start if s else None)
    if not start:
        return None
    return aware(start), aware(start) + timedelta(minutes=(cb.duration_min or (s.duration_min if s else 60)))


def overlapping(db: Session, coach: Coach, start: datetime, duration_min: int) -> list[CourtBooking]:
    """Terrains du coach (réservés, demandés ou utilisés) qui chevauchent [start, start+durée].
    Un coach n'a qu'un terrain à la fois: on ne lui en ajoute pas un second à la même heure."""
    start, end = aware(start), aware(start) + timedelta(minutes=duration_min)
    out = []
    for cb in db.scalars(select(CourtBooking).where(CourtBooking.coach_id == coach.id, CourtBooking.status.not_in(("annulee", "refusee")))):
        sp = span(db, cb)
        s = db.get(TrainingSession, cb.session_id) if cb.session_id else None
        if sp and sp[0] < end and start < sp[1] and not (s and s.status == "annulee"):
            out.append(cb)
    return sorted(out, key=lambda c: span(db, c)[0])


def busy_message(db: Session, cb: CourtBooking) -> str:
    """« Vous avez déjà un terrain … » expliqué en clair."""
    a, b = span(db, cb)
    club = db.get(Club, cb.club_id).name
    what = "une séance sur un terrain" if cb.session_id else "un terrain"
    return (f"Vous avez déjà {what} à ce moment-là ({club}, {quand(a, int((b - a).total_seconds() // 60))}). "
            "Un coach n'a qu'un terrain à la fois : choisissez une autre heure.")


def held_covering(db: Session, coach: Coach, start: datetime, duration_min: int) -> list[CourtBooking]:
    """Terrains confirmés et libres qui couvrent entièrement [start, start+durée]."""
    start, end = aware(start), aware(start) + timedelta(minutes=duration_min)
    out = []
    for cb in db.scalars(select(CourtBooking).where(CourtBooking.coach_id == coach.id, CourtBooking.session_id.is_(None), CourtBooking.status == "confirmee")):
        if cb.start and aware(cb.start) <= start and aware(cb.start) + timedelta(minutes=cb.duration_min) >= end:
            out.append(cb)
    return sorted(out, key=lambda c: aware(c.start))


def send(db: Session, coach: Coach, cb: CourtBooking, sms: SmsProvider) -> None:
    club = db.get(Club, cb.club_id)
    s = db.get(TrainingSession, cb.session_id) if cb.session_id else None
    if not club.phone:
        raise ValueError("Ce club n'a pas de numéro de téléphone")
    cb.message = render(db, coach, club, cb, s)
    sms.send(club.phone, cb.message)
    cb.status, cb.sent_at = "en_attente", datetime.now(timezone.utc)


def send_due(db: Session, coach: Coach | None, sms: SmsProvider) -> int:
    """Envoie les demandes dont la séance a lieu dans les SEND_AHEAD_DAYS jours. Retourne le nombre envoyé."""
    horizon = datetime.now(timezone.utc) + timedelta(days=SEND_AHEAD_DAYS)
    q = select(CourtBooking).where(CourtBooking.status == "a_envoyer", CourtBooking.session_id.is_not(None))
    if coach:
        q = q.where(CourtBooking.coach_id == coach.id)
    sent = 0
    for cb in db.scalars(q):
        club, s = db.get(Club, cb.club_id), db.get(TrainingSession, cb.session_id)
        past = aware(s.start) < datetime.now(timezone.utc)
        if not (club.auto_send and club.phone) or s.status == "annulee" or past or aware(s.start) > horizon:
            continue
        send(db, db.get(Coach, cb.coach_id), cb, sms)
        sent += 1
    db.commit()
    return sent


def mark_confirmed(db: Session, cb: CourtBooking) -> None:
    """Le terrain d'une séance est confirmé: les réservations acceptées en attente passent à « confirmée »
    (le coach doit alors prévenir les joueurs)."""
    if not cb.session_id:
        return
    from .booking import announce_confirmed  # import local: booking importe ce module
    for b in db.scalars(select(Booking).where(Booking.session_id == cb.session_id, Booking.status == "acceptee")):
        b.status = "confirmee"
    db.flush()
    announce_confirmed(db, db.get(TrainingSession, cb.session_id))  # e-mail de confirmation aux joueurs


def release_or_cancel(db: Session, coach: Coach, s: TrainingSession, sms: SmsProvider | None) -> None:
    """La séance est annulée. Terrain réservé à la main: il redevient libre. Demande SMS: on prévient le club."""
    for cb in db.scalars(select(CourtBooking).where(CourtBooking.session_id == s.id)):
        club = db.get(Club, cb.club_id)
        if cb.source == "manuel":
            cb.session_id = None
            continue
        if cb.status in ("en_attente", "confirmee") and club.phone and sms:
            start = aware(s.start).astimezone(TUNIS)
            sms.send(club.phone, f"Bonjour, merci d'annuler ma réservation du {JOURS[start.weekday()]} {start:%d/%m} à {start:%H}h{start:%M}. {coach.name}")
        cb.status = "annulee"


# --- Analyse de la réponse du club -------------------------------------

POSITIVE = {"oui", "ok", "okay", "yes", "confirme", "confirmee", "confirmer", "accord", "daccord", "reserve", "reservee", "valide", "validee", "tamem", "behi", "mrigel"}
NEGATIVE = {"non", "no", "complet", "occupe", "occupee", "indisponible", "impossible", "desole", "desolee", "refuse", "pas", "malheureusement", "mouch"}


def _words(text: str) -> set[str]:
    plain = unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode()
    return set(re.findall(r"[a-z]+", plain.replace("'", "")))


def parse_reply(text: str) -> str | None:
    """'confirmee', 'refusee', ou None si le message est ambigu (le coach tranche)."""
    words = _words(text)
    pos, neg = bool(words & POSITIVE), bool(words & NEGATIVE)
    if neg:  # un refus l'emporte: « oui mais complet » reste un refus
        return "refusee"
    return "confirmee" if pos else None


def apply_reply(db: Session, cb: CourtBooking, text: str) -> str | None:
    verdict = parse_reply(text)
    cb.reply, cb.replied_at = text.strip(), datetime.now(timezone.utc)
    if verdict:
        cb.status = verdict
        if verdict == "confirmee":
            mark_confirmed(db, cb)
    return verdict


def match_inbound(db: Session, phone: str) -> CourtBooking | None:
    """Rattache un SMS entrant à la dernière demande en attente envoyée à ce numéro."""
    club_ids = [c.id for c in db.scalars(select(Club).where(Club.phone == phone))]
    if not club_ids:
        return None
    return db.scalar(
        select(CourtBooking).where(CourtBooking.club_id.in_(club_ids), CourtBooking.status == "en_attente").order_by(CourtBooking.sent_at.desc())
    )
