"""Prise de rendez-vous côté joueur, tous coachs confondus:
1. filtres coach / club, 2. jour choisi (heure facultative), 3. propositions selon la façon de jouer:
   - à deux ou en groupe: groupes déjà formés à rejoindre, puis nouveaux créneaux à créer;
   - seul: d'abord les créneaux où un terrain est déjà réservé, puis les autres (terrain à confirmer).
"""
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..constants import CAPACITY, compatible
from ..models import Attendance, Availability, Booking, Club, Coach, CourtBooking, HappyHour, Player, TrainingSession, Waitlist
from . import courts
from .accounts import linked
from .isolation import visible_coaches
from . import groups as grp
from .booking import KIND_FR, _dur, vip as is_vip, player_busy, attendee_ids, edges, fits_session, free_slots, horizon, join_minutes, join_price, join_target, pending_joins, price_for, spots_left
from .common import TUNIS, aware
from .pricing import coach_durations, duration_for, grid, player_durations, quote

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
        "clubs": coach_clubs(db, coach), "prices": {k: price_for(coach, k, None, is_vip(db, coach, account)) for k in CAPACITY}, "mine": mine,
        "vip": is_vip(db, coach, account),  # le joueur est dans la liste VIP de ce coach (tarifs privilégiés)
        **_rating(db, coach.id),
        # formules, durées et prix proposés, et jusqu'où on peut réserver (jours)
        "grid": {k: {str(m): v for m, v in g.items()} for k, g in grid(coach).items()}, "horizon_days": horizon(coach),
    }


def coach_profile(db: Session, coach: Coach, account: Player) -> dict:
    windows = db.scalars(select(Availability).where(Availability.coach_id == coach.id).order_by(Availability.weekday, Availability.start_time))
    done = db.scalar(select(func.count(TrainingSession.id)).where(TrainingSession.coach_id == coach.id, TrainingSession.status == "effectuee"))
    players = db.scalar(select(func.count(func.distinct(Attendance.player_id))).join(TrainingSession, TrainingSession.id == Attendance.session_id).where(TrainingSession.coach_id == coach.id))
    return coach_summary(db, coach, account) | {
        "slot_minutes": coach.slot_minutes, "cancel_hours": coach.cancel_hours,
        "durations": {k: duration_for(coach, k) for k in CAPACITY},
        "happy_hours": [{"weekday": h.weekday, "start_time": h.start_time, "end_time": h.end_time, "discount_pct": h.discount_pct, "discount_millimes": h.discount_millimes}
                        for h in db.scalars(select(HappyHour).where(HappyHour.coach_id == coach.id).order_by(HappyHour.weekday, HappyHour.start_time))],
        "availability": [{"weekday": w.weekday, "start_time": w.start_time, "end_time": w.end_time} for w in windows],
        "stats": {"sessions_done": done or 0, "players": players or 0},
        **_extras(db, coach, account),
    }


def _rating(db: Session, coach_id: int) -> dict:
    from ..routers.community import rating_of
    return rating_of(db, coach_id)


def _extras(db: Session, coach: Coach, account: Player) -> dict:
    """Avis, possibilité de laisser le sien, et packs de crédits du coach."""
    from ..models import Review
    from ..routers.community import can_review, packs_of, reviews_of
    from .accounts import account_of
    mine = db.scalar(select(Review).where(Review.coach_id == coach.id, Review.account_id == account_of(db, account).id))
    return {"reviews": reviews_of(db, coach.id), "can_review": can_review(db, account, coach.id), "packs": packs_of(db, coach.id),
            "my_review": {"rating": mine.rating, "comment": mine.comment} if mine else None}


def _in_window(start: datetime, day: date, period: str | None) -> bool:
    local = aware(start).astimezone(TUNIS)
    if local.date() != day:
        return False
    if period in PERIODS:
        lo, hi = PERIODS[period]
        return lo <= local.hour < hi
    return True


def request_root(db: Session, b: Booking) -> Booking:
    """Première demande d'un groupe de demandes (les joueurs qui ont rejoint pointent vers elle par group_id)."""
    return db.get(Booking, b.group_id) if b.group_id and db.get(Booking, b.group_id) else b


def join_opts(db: Session, coach: Coach, root: Booking, kinds: list[str], durations: dict) -> set:
    """Formules et durées communes au joueur et à tous ceux de la demande (à deux / en groupe seulement)."""
    members = [x for x in db.scalars(select(Booking).where(Booking.group_id == root.id, Booking.status == "en_attente"))] or [root]
    mine = {(k, m) for k in kinds if k != "individuel" for m in durations.get(k, []) if m in coach_durations(coach, k)}
    for x in [root, *members]:
        mine &= grp.parse_opts(x.accepted_opts)
    return mine


def open_requests(db: Session, c: Coach, account: Player, my_ids: set, day: date, period: str | None, kinds: list[str],
                  durations: dict, who: dict) -> list[dict]:
    """Demandes en attente du coach que ce joueur peut rejoindre (même jour, niveau compatible, formules communes)."""
    me = account
    out, seen = [], set()
    for b in db.scalars(select(Booking).where(Booking.coach_id == c.id, Booking.status == "en_attente", Booking.session_id.is_(None))):
        root = request_root(db, b)
        if root.id in seen or root.group_token or not _in_window(root.start, day, period) or aware(root.start) <= datetime.now(timezone.utc):
            continue
        seen.add(root.id)
        members = [x for x in db.scalars(select(Booking).where(Booking.status == "en_attente", Booking.session_id.is_(None),
                                                               (Booking.id == root.id) | (Booking.group_id == root.id)))]
        if any(x.player_id in my_ids for x in members) or len(members) >= 4:
            continue
        players = [db.get(Player, x.player_id) for x in members]
        if not all(compatible(me.category, me.gender, p.category, p.gender) for p in players):
            continue
        opts = join_opts(db, c, root, kinds, durations)
        if not opts:
            continue
        size = len(members) + 1
        fit = sorted((o for o in opts if size in grp.SIZES[o[0]]), key=lambda o: -o[1]) or sorted(opts, key=lambda o: -o[1])
        k, m = fit[0]
        v = is_vip(db, c, account)
        q = quote(db, c, k, root.start, m, v)
        out.append({"type": "request", "booking_id": root.id, "coach": who, "start": root.start, "duration_min": m, "kind": k, "vip": v,
                    "kinds": sorted({x for x, _ in opts}, key=grp.ORDER.index), "price_millimes": q["price_millimes"],
                    "players": [{"name": p.name, "category": p.category} for p in players], "club": "",
                    "reduction_millimes": q["reduction_millimes"]})
    return out


def offers(db: Session, account: Player, day: date, kinds: list[str], coach_ids: set[int] | None = None, club: str | list[str] | None = None,
           period: str | None = None, hour: int | None = None, durations: dict | None = None,
           group: bool = False) -> dict:
    """Groupes à rejoindre et créneaux à créer pour ce jour, chez les coachs (et au club) choisis.
    kinds: formules acceptées par le joueur (une ou plusieurs parmi individuel, duo, groupe);
    durations: durées acceptées pour chacune (seul = 1 h; à deux, en groupe: 1 h, 1 h 30 ou les deux)."""
    kinds = [k for k in CAPACITY if k in kinds] or list(CAPACITY)
    durations = player_durations(durations)
    wanted_clubs = [club] if isinstance(club, str) else [c for c in club or [] if c]  # un ou plusieurs clubs (vide = tous)
    in_clubs = lambda name: not wanted_clubs or any(same_club(c, name) for c in wanted_clubs)  # noqa: E731
    my_ids = {p.id for p in linked(db, account)}
    coaches = [c for c in visible_coaches(db, account) if not coach_ids or c.id in coach_ids]  # comptes test à part; un ou plusieurs coachs
    now = datetime.now(timezone.utc)
    groups, with_court, other = [], [], []
    other_kinds: dict[str, int] = {}  # séances ouvertes ce jour-là d'une formule que le joueur n'a pas choisie
    requests: list[dict] = []  # demandes d'autres joueurs à rejoindre
    full: list[dict] = []  # séances complètes de sa formule: liste d'attente
    hints: list[str] = []  # pourquoi rien n'est proposé chez un coach (durée pas proposée, terrains trop courts)
    too_late: set[str] = set()  # formules qu'on ne peut plus ouvrir seul ce jour-là (moins de 24 h)
    # ce qui occupe déjà le joueur (tous coachs, son planning): ces créneaux ne lui sont pas proposés, et on le lui rappelle
    busy = player_busy(db, account)
    occupied = lambda st, m: any(a < aware(st) + timedelta(minutes=m) and aware(st) < b for a, b, _ in busy)  # noqa: E731
    lo_day = datetime.combine(day, datetime.min.time(), TUNIS)
    my_day = [{"label": label, "start": a, "end": b} for a, b, label in sorted(busy) if a < lo_day + timedelta(days=1) and lo_day < b]
    for c in filter(None, coaches):
        clubs = coach_clubs(db, c)
        if wanted_clubs and not any(in_clubs(n) for n in clubs):
            continue
        who = {"id": c.id, "name": c.name}
        v = is_vip(db, c, account)  # prix VIP chez ce coach
        # 0. Séances complètes de sa formule (une séance pleine se ferme d'elle-même): liste d'attente
        for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == c.id, TrainingSession.status == "prevue",
                                                          TrainingSession.kind != "individuel")):
            if (not _in_window(s.start, day, period) or aware(s.start) < now + timedelta(hours=2) or my_ids & set(attendee_ids(s))
                    or spots_left(db, s) > 0 or s.kind not in kinds or (wanted_clubs and not in_clubs(s.club))):
                continue
            if fits_session(db, account, s)[0] and not occupied(s.start, s.duration_min):
                others = [db.get(Player, i) for i in attendee_ids(s)]
                full.append({"type": "full", "session_id": s.id, "coach": who, "start": s.start, "duration_min": s.duration_min,
                             "kind": s.kind, "club": s.club, "players": [{"name": p.name, "category": p.category, "gender": p.gender} for p in others],
                             "waitlisted": bool(db.scalar(select(Waitlist.id).where(Waitlist.session_id == s.id, Waitlist.player_id.in_(my_ids))))})
        # 1. Séances à rejoindre: la taille de la séance après l'arrivée du joueur doit convenir à tous (services/groups).
        #    Jamais de groupe pour qui veut s'entraîner seul, jamais un duo pour qui cherche un groupe; on peut être le
        #    premier ou le deuxième d'un groupe s'il reste plus de 24 h pour le compléter. Les séances d'autres formules
        #    sont seulement comptées (« si vous reconsidérez votre choix »).
        for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == c.id, TrainingSession.open.is_(True), TrainingSession.status == "prevue")):
            if not _in_window(s.start, day, period) or aware(s.start) < now + timedelta(hours=2):
                continue
            if my_ids & set(attendee_ids(s)) or spots_left(db, s) <= 0 or (wanted_clubs and not in_clubs(s.club)):
                continue
            if occupied(s.start, s.duration_min):  # le joueur a déjà quelque chose à ce moment-là
                continue
            ok, gap = fits_session(db, account, s)
            if not ok:
                continue
            opts = grp.opts_of(kinds, durations, s.duration_min)
            target = join_target(db, s, kinds, opts=opts)
            # bonne formule mais autre durée (ex. 1 h au lieu d'1 h 30): montrée quand même, avec une petite note
            other_duration = target is None and join_target(db, s, kinds) is not None
            if other_duration:
                target = join_target(db, s, kinds)
            if target is None:
                alt = join_target(db, s, None)
                if alt:
                    k = grp.kind_for_size(alt)
                    other_kinds[k] = other_kinds.get(k, 0) + 1
                continue
            others = [db.get(Player, i) for i in attendee_ids(s)]
            taken = len(others) + pending_joins(db, s)
            # durée jouée s'il la rejoint: la plus longue que tous acceptent, lui compris (la plus stricte l'emporte)
            minutes = join_minutes(db, s, target, None if other_duration else opts) if grp.is_dynamic(s) else s.duration_min
            groups.append({
                "type": "group", "session_id": s.id, "coach": who, "start": s.start, "duration_min": minutes, "kind": grp.kind_for_size(target), "vip": v,
                "club": s.club, "court": courts_state(db, s),
                "price_millimes": price_for(c, grp.kind_for_size(target), minutes, v) if grp.is_dynamic(s) else join_price(c, s, target, v),
                "spots_left": spots_left(db, s), "players": [{"name": p.name, "category": p.category, "gender": p.gender} for p in others],
                "count": taken, "missing": max(0, target - taken - 1),  # joueurs qu'il manquera encore après lui
                "other_duration": other_duration, "_gap": gap + (10 if other_duration else 0),
            })
        # 1 bis. Demandes d'autres joueurs pas encore traitées par le coach, à deux ou en groupe, de niveau compatible:
        #    le joueur peut s'y joindre (le coach recevra une demande groupée). Jamais les réservations en groupe
        #    privées (montées par un joueur qui invite lui-même ses partenaires).
        if not group:
            requests += open_requests(db, c, account, my_ids, day, period, kinds, durations, who)
        # 2. Nouveaux créneaux: pour chaque durée acceptée (1 h, 1 h 30), les débuts possibles et le prix de chaque
        #    formule à cette durée. Le joueur ne choisit pas: la séance garde la plus longue possible et le prix suit
        #    la formule et la durée réellement jouées (un joueur qui n'accepte que 1 h la raccourcit)
        starts: dict[datetime, list[dict]] = {}
        pending = list(db.scalars(select(Booking).where(Booking.coach_id == c.id, Booking.status == "en_attente", Booking.session_id.is_(None),
                                                        Booking.player_id.not_in(my_ids))))
        snug = edges(db, c)  # créneaux collés à un bord de plage libre: mis en avant
        feasible: dict[datetime, set[int]] = {}
        cdur = {k: [m for m in durations[k] if m in coach_durations(c, k)] for k in kinds}  # durées que ce coach propose
        for minutes in (60, 90):
            if any(minutes in cdur[k] for k in kinds):
                for start in free_slots(db, c, minutes=minutes):
                    if _in_window(start, day, period):
                        feasible.setdefault(start, set()).add(minutes)
        for start, mins in feasible.items():
            # la séance garde la plus longue durée possible ici; les formules plus courtes acceptées (seul 1 h…)
            # restent possibles à l'intérieur: s'il reste seul, il joue 1 h
            mins = {m for m in mins if not occupied(start, m)}  # durées qui ne tombent pas sur ce qu'il a déjà
            length = max((m for k in kinds for m in cdur[k] if m in mins), default=None)
            opts = [(k, m) for k in kinds for m in cdur[k] if length and m <= length]
            if not opts:
                continue
            # réservation en groupe (group): le joueur invite lui-même ses partenaires, pas de délai de 24 h
            too_late.update(k for k, _ in opts if not group and not grp.can_open(k, start))
            if not group and not grp.can_open(opts[0][0], start):  # ouvrir un duo/groupe seul: seulement à plus de 24 h
                continue
            starts[start] = [quote(db, c, k, start, m, v) for k, m in opts]
        # rien de proposé chez ce coach ce jour-là: on explique pourquoi (au lieu d'une liste vide)
        if not starts:
            label = lambda k, ms: f"{KIND_FR[k].lower()} {' ou '.join(_dur(m) for m in ms)}"  # noqa: E731
            if not any(cdur.values()):
                offered = ", ".join(label(k, coach_durations(c, k)) for k in kinds if coach_durations(c, k))
                hints.append(f"{c.name} ne propose pas la durée choisie" + (f" (il propose : {offered})." if offered else " pour ces formules."))
            elif not too_late and c.booking_mode != "disponibilites" and any(_in_window(courts.run_span(r)[0], day, None) for r in courts.free_runs(db, c.id)):
                want = sorted({m for ms in cdur.values() for m in ms})
                hints.append(f"Les terrains libres de {c.name} ce jour-là sont trop courts pour {' ou '.join(_dur(m) for m in want)} "
                             "(une séance ne doit pas laisser un bout de terrain de moins d'1 h) : essayez une durée plus courte.")
        for start, options in sorted(starts.items()):
            held = [cb for cb in courts.held_covering(db, c, start, min(o["duration_min"] for o in options))
                    if in_clubs(db.get(Club, cb.club_id).name)]
            first = options[0]
            requested = sum(1 for b in pending if aware(b.start) < start + timedelta(minutes=max(o["duration_min"] for o in options))
                            and start < aware(b.start) + timedelta(minutes=b.duration_min))  # autres demandes du même créneau
            item = {"type": "slot", "coach": who, "start": start, "options": options, "kind": first["kind"], "requested": requested, "vip": v,
                    "duration_min": first["duration_min"], "price_millimes": first["price_millimes"],
                    "discount_pct": max(o["discount_pct"] for o in options), "reduction_millimes": max(o["reduction_millimes"] for o in options),
                    "reason": next((o["reason"] for o in options if o["reason"]), None),
                    "court": "reserve" if held else "a_confirmer",
                    "ideal": any(start in snug or start + timedelta(minutes=o["duration_min"]) in snug for o in options),
                    "club": db.get(Club, held[0].club_id).name if held else (wanted_clubs[0] if len(wanted_clubs) == 1 else (clubs[0] if len(clubs) == 1 else ""))}
            (with_court if held else other).append(item)

    def closeness(x: dict) -> float:
        if hour is None:
            return aware(x["start"]).timestamp()
        local = aware(x["start"]).astimezone(TUNIS)
        return abs(local.hour + local.minute / 60 - hour) * 1e6 + aware(x["start"]).timestamp() / 1e6

    groups.sort(key=lambda g: (g.pop("_gap"), closeness(g)))
    with_court.sort(key=lambda x: (-x["reduction_millimes"], closeness(x)))  # les réductions d'abord
    other.sort(key=closeness)
    return {"groups": groups[:10], "slots_with_court": with_court[:80], "slots_other": other[:120], "other_kinds": other_kinds, "hints": hints,
            "requests": sorted((r for r in requests if not occupied(r["start"], r["duration_min"])), key=closeness)[:10],
            "my_day": my_day,
            "full": sorted(full, key=closeness)[:10],
            "too_late": [k for k in CAPACITY if k in too_late]}


def courts_state(db: Session, s: TrainingSession) -> str:
    cb = db.scalar(select(CourtBooking).where(CourtBooking.session_id == s.id, CourtBooking.status != "annulee"))
    return "reserve" if not cb or cb.status == "confirmee" else "a_confirmer"
