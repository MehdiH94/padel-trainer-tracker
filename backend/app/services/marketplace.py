"""Prise de rendez-vous côté joueur, tous coachs confondus:
1. filtres coach / club, 2. jour choisi (heure facultative), 3. propositions selon la façon de jouer:
   - à deux ou en groupe: groupes déjà formés à rejoindre, puis nouveaux créneaux à créer;
   - seul: d'abord les créneaux où un terrain est déjà réservé, puis les autres (terrain à confirmer).
"""
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..constants import CAPACITY
from ..models import Attendance, Availability, Club, Coach, CourtBooking, Player, TrainingSession
from . import courts
from .accounts import linked
from .booking import attendee_ids, fits_session, free_slots, price_for, spots_left
from .common import TUNIS, aware

PERIODS = {"matin": (0, 12), "apres-midi": (12, 17), "soir": (17, 24)}


def same_club(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def coach_clubs(db: Session, coach: Coach) -> list[str]:
    """Clubs où le coach travaille: ses clubs enregistrés et ceux de ses séances."""
    names = list(db.scalars(select(Club.name).where(Club.coach_id == coach.id)))
    names += [c for c in db.scalars(select(TrainingSession.club).where(TrainingSession.coach_id == coach.id).distinct()) if c]
    out: list[str] = []
    for n in names:
        if not any(same_club(n, o) for o in out):
            out.append(n.strip())
    return sorted(out)


def all_clubs(db: Session) -> list[str]:
    out: list[str] = []
    for c in db.scalars(select(Coach)):
        for n in coach_clubs(db, c):
            if not any(same_club(n, o) for o in out):
                out.append(n)
    return sorted(out)


def coach_summary(db: Session, coach: Coach, account: Player | None = None) -> dict:
    mine = account is not None and any(p.coach_id == coach.id for p in linked(db, account))
    return {
        "id": coach.id, "name": coach.name, "bio": coach.bio, "specialties": [s for s in coach.specialties.split(",") if s],
        "clubs": coach_clubs(db, coach), "prices": {k: price_for(coach, k) for k in CAPACITY}, "mine": mine,
    }


def coach_profile(db: Session, coach: Coach, account: Player) -> dict:
    windows = db.scalars(select(Availability).where(Availability.coach_id == coach.id).order_by(Availability.weekday, Availability.start_time))
    done = db.scalar(select(func.count(TrainingSession.id)).where(TrainingSession.coach_id == coach.id, TrainingSession.status == "effectuee"))
    players = db.scalar(select(func.count(func.distinct(Attendance.player_id))).join(TrainingSession, TrainingSession.id == Attendance.session_id).where(TrainingSession.coach_id == coach.id))
    return coach_summary(db, coach, account) | {
        "slot_minutes": coach.slot_minutes, "cancel_hours": coach.cancel_hours,
        "availability": [{"weekday": w.weekday, "start_time": w.start_time, "end_time": w.end_time} for w in windows],
        "stats": {"sessions_done": done or 0, "players": players or 0},
    }


def _in_window(start: datetime, day: date, period: str | None) -> bool:
    local = aware(start).astimezone(TUNIS)
    if local.date() != day:
        return False
    if period in PERIODS:
        lo, hi = PERIODS[period]
        return lo <= local.hour < hi
    return True


def offers(db: Session, account: Player, day: date, kind: str, coach_id: int | None = None, club: str | None = None,
           period: str | None = None, hour: int | None = None) -> dict:
    """Groupes à rejoindre et créneaux à créer pour ce jour, chez les coachs (et au club) choisis."""
    my_ids = {p.id for p in linked(db, account)}
    coaches = [db.get(Coach, coach_id)] if coach_id else list(db.scalars(select(Coach)))
    groups, with_court, other = [], [], []
    for c in filter(None, coaches):
        clubs = coach_clubs(db, c)
        if club and not any(same_club(club, n) for n in clubs):
            continue
        who = {"id": c.id, "name": c.name}
        # 1. Groupes déjà formés (séances ouvertes du même type, compatibles avec le niveau du joueur)
        if kind != "individuel":
            for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == c.id, TrainingSession.open.is_(True), TrainingSession.status == "prevue", TrainingSession.kind == kind)):
                if not _in_window(s.start, day, period) or aware(s.start) < datetime.now(aware(s.start).tzinfo) + timedelta(hours=2):
                    continue
                if my_ids & set(attendee_ids(s)) or spots_left(db, s) <= 0 or (club and not same_club(club, s.club)):
                    continue
                ok, gap = fits_session(db, account, s)
                if not ok:
                    continue
                others = [db.get(Player, i) for i in attendee_ids(s)]
                groups.append({
                    "type": "group", "session_id": s.id, "coach": who, "start": s.start, "duration_min": s.duration_min, "kind": s.kind,
                    "club": s.club, "court": courts_state(db, s), "price_millimes": s.price_millimes or price_for(c, s.kind),
                    "spots_left": spots_left(db, s), "players": [{"name": p.name, "category": p.category, "gender": p.gender} for p in others],
                    "_gap": gap,
                })
        # 2. Nouveaux créneaux: terrain déjà réservé par le coach (au club choisi) d'abord
        for start in free_slots(db, c):
            if not _in_window(start, day, period):
                continue
            held = [cb for cb in courts.held_covering(db, c, start, c.slot_minutes) if not club or same_club(club, db.get(Club, cb.club_id).name)]
            item = {"type": "slot", "coach": who, "start": start, "duration_min": c.slot_minutes, "kind": kind,
                    "price_millimes": price_for(c, kind), "court": "reserve" if held else "a_confirmer",
                    "club": db.get(Club, held[0].club_id).name if held else (club or (clubs[0] if len(clubs) == 1 else ""))}
            (with_court if held else other).append(item)

    def closeness(x: dict) -> float:
        if hour is None:
            return aware(x["start"]).timestamp()
        local = aware(x["start"]).astimezone(TUNIS)
        return abs(local.hour + local.minute / 60 - hour) * 1e6 + aware(x["start"]).timestamp() / 1e6

    groups.sort(key=lambda g: (g.pop("_gap"), closeness(g)))
    with_court.sort(key=closeness)
    other.sort(key=closeness)
    return {"groups": groups[:10], "slots_with_court": with_court[:20], "slots_other": other[:30]}


def courts_state(db: Session, s: TrainingSession) -> str:
    cb = db.scalar(select(CourtBooking).where(CourtBooking.session_id == s.id, CourtBooking.status != "annulee"))
    return "reserve" if not cb or cb.status == "confirmee" else "a_confirmer"
