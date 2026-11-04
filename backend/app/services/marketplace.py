"""Prise de rendez-vous côté joueur, tous coachs confondus:
1. filtres coach / club, 2. jour choisi (heure facultative), 3. propositions selon la façon de jouer:
   - à deux ou en groupe: groupes déjà formés à rejoindre, puis nouveaux créneaux à créer;
   - seul: d'abord les créneaux où un terrain est déjà réservé, puis les autres (terrain à confirmer).
"""
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..constants import CAPACITY
from ..models import Attendance, Availability, Club, Coach, CourtBooking, HappyHour, Player, TrainingSession
from . import courts
from .accounts import linked
from .isolation import visible_coaches
from . import groups as grp
from .booking import attendee_ids, fits_session, free_slots, join_price, join_target, pending_joins, price_for, spots_left
from .common import TUNIS, aware
from .pricing import duration_for, quote

PERIODS = {"matin": (0, 12), "apres-midi": (12, 17), "soir": (17, 24)}


def same_club(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def coach_clubs(db: Session, coach: Coach) -> list[str]:
    """Clubs où le coach entraîne (choisis dans Réglages › Mes clubs)."""
    out: list[str] = []
    for n in db.scalars(select(Club.name).where(Club.coach_id == coach.id, Club.active.is_(True))):
        if not any(same_club(n, o) for o in out):
            out.append(n.strip())
    return sorted(out)


def all_clubs(db: Session, coaches: list[Coach]) -> list[str]:
    """Clubs des coachs donnés (ceux que le joueur peut voir)."""
    out: list[str] = []
    for c in coaches:
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
        "durations": {k: duration_for(coach, k) for k in CAPACITY},
        "happy_hours": [{"weekday": h.weekday, "start_time": h.start_time, "end_time": h.end_time, "discount_pct": h.discount_pct}
                        for h in db.scalars(select(HappyHour).where(HappyHour.coach_id == coach.id).order_by(HappyHour.weekday, HappyHour.start_time))],
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


def offers(db: Session, account: Player, day: date, kinds: list[str], coach_id: int | None = None, club: str | None = None,
           period: str | None = None, hour: int | None = None) -> dict:
    """Groupes à rejoindre et créneaux à créer pour ce jour, chez les coachs (et au club) choisis.
    kinds: formules acceptées par le joueur (une ou plusieurs parmi individuel, duo, groupe)."""
    kinds = [k for k in CAPACITY if k in kinds] or list(CAPACITY)
    my_ids = {p.id for p in linked(db, account)}
    coaches = [c for c in visible_coaches(db, account) if not coach_id or c.id == coach_id]  # comptes test à part
    now = datetime.now(timezone.utc)
    groups, with_court, other = [], [], []
    other_kinds: dict[str, int] = {}  # séances ouvertes ce jour-là d'une formule que le joueur n'a pas choisie
    too_late: set[str] = set()  # formules qu'on ne peut plus ouvrir seul ce jour-là (moins de 24 h)
    for c in filter(None, coaches):
        clubs = coach_clubs(db, c)
        if club and not any(same_club(club, n) for n in clubs):
            continue
        who = {"id": c.id, "name": c.name}
        # 1. Séances à rejoindre: la taille de la séance après l'arrivée du joueur doit convenir à tous (services/groups).
        #    Jamais de groupe pour qui veut s'entraîner seul, jamais un duo pour qui cherche un groupe; on peut être le
        #    premier ou le deuxième d'un groupe s'il reste plus de 24 h pour le compléter. Les séances d'autres formules
        #    sont seulement comptées (« si vous reconsidérez votre choix »).
        for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == c.id, TrainingSession.open.is_(True), TrainingSession.status == "prevue")):
            if not _in_window(s.start, day, period) or aware(s.start) < now + timedelta(hours=2):
                continue
            if my_ids & set(attendee_ids(s)) or spots_left(db, s) <= 0 or (club and not same_club(club, s.club)):
                continue
            ok, gap = fits_session(db, account, s)
            if not ok:
                continue
            target = join_target(db, s, kinds)
            if target is None:
                alt = join_target(db, s, None)
                if alt:
                    k = grp.kind_for_size(alt)
                    other_kinds[k] = other_kinds.get(k, 0) + 1
                continue
            others = [db.get(Player, i) for i in attendee_ids(s)]
            taken = len(others) + pending_joins(db, s)
            groups.append({
                "type": "group", "session_id": s.id, "coach": who, "start": s.start, "duration_min": s.duration_min, "kind": grp.kind_for_size(target),
                "club": s.club, "court": courts_state(db, s), "price_millimes": join_price(c, s, target),
                "spots_left": spots_left(db, s), "players": [{"name": p.name, "category": p.category, "gender": p.gender} for p in others],
                "count": taken, "missing": max(0, target - taken - 1),  # joueurs qu'il manquera encore après lui
                "_gap": gap,
            })
        # 2. Nouveaux créneaux: pour chaque début possible, les formules qui y tiennent (durée propre à chacune)
        starts: dict[datetime, list[dict]] = {}
        for k in kinds:
            minutes = duration_for(c, k)
            for start in free_slots(db, c, minutes=minutes):
                if not _in_window(start, day, period):
                    continue
                if not grp.can_open(k, start):  # ouvrir un duo/groupe seul: seulement à plus de 24 h
                    too_late.add(k)
                    continue
                starts.setdefault(start, []).append(quote(db, c, k, start))
        for start, options in sorted(starts.items()):
            held = [cb for cb in courts.held_covering(db, c, start, min(o["duration_min"] for o in options))
                    if not club or same_club(club, db.get(Club, cb.club_id).name)]
            first = options[0]
            item = {"type": "slot", "coach": who, "start": start, "options": options, "kind": first["kind"],
                    "duration_min": first["duration_min"], "price_millimes": first["price_millimes"],
                    "discount_pct": max(o["discount_pct"] for o in options), "reason": next((o["reason"] for o in options if o["reason"]), None),
                    "court": "reserve" if held else "a_confirmer",
                    "club": db.get(Club, held[0].club_id).name if held else (club or (clubs[0] if len(clubs) == 1 else ""))}
            (with_court if held else other).append(item)

    def closeness(x: dict) -> float:
        if hour is None:
            return aware(x["start"]).timestamp()
        local = aware(x["start"]).astimezone(TUNIS)
        return abs(local.hour + local.minute / 60 - hour) * 1e6 + aware(x["start"]).timestamp() / 1e6

    groups.sort(key=lambda g: (g.pop("_gap"), closeness(g)))
    with_court.sort(key=lambda x: (-x["discount_pct"], closeness(x)))  # les promotions d'abord
    other.sort(key=closeness)
    return {"groups": groups[:10], "slots_with_court": with_court[:20], "slots_other": other[:30], "other_kinds": other_kinds,
            "too_late": [k for k in CAPACITY if k in too_late]}


def courts_state(db: Session, s: TrainingSession) -> str:
    cb = db.scalar(select(CourtBooking).where(CourtBooking.session_id == s.id, CourtBooking.status != "annulee"))
    return "reserve" if not cb or cb.status == "confirmee" else "a_confirmer"
