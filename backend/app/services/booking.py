"""Réservations des joueurs payées avec leurs crédits: créneaux libres, suggestions de groupes, demandes."""
from datetime import datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..constants import CAPACITY, category_index, compatible
from ..models import Attendance, Availability, Booking, Club, Coach, CourtBooking, CreditTx, Player, Proposal, TrainingSession
from ..sms.base import SmsProvider
from . import courts
from . import groups
from ..notify import letter
from .common import TUNIS, aware, quand
from .finance import credit_balance
from .pricing import coach_durations, duration_for, quote, reduced

HORIZON_DAYS = 14  # par défaut: le coach règle sa limite (Coach.booking_horizon_days, 7 à 90 jours)


def horizon_label(days: int) -> str:
    return {7: "1 semaine", 14: "2 semaines", 21: "3 semaines", 30: "1 mois", 60: "2 mois", 90: "3 mois"}.get(days, f"{days} jours")


def horizon(coach: Coach) -> int:
    """Nombre de jours à l'avance où ses joueurs peuvent réserver."""
    return coach.booking_horizon_days or HORIZON_DAYS
MIN_NOTICE_H = 2
# attente_joueurs: acceptée par le coach, mais la séance n'a pas encore le nombre minimum de joueurs voulu
ACTIVE = ("en_attente", "contre_proposition", "attente_joueurs", "acceptee", "confirmee")  # contre_proposition: le coach propose un autre horaire


class BookingError(Exception):
    pass


def price_for(coach: Coach, kind: str, minutes: int | None = None, vip: bool = False) -> int:
    """Prix par joueur de la formule et de la durée (prix VIP pour un joueur de la liste VIP du coach)."""
    from .pricing import base_price
    return base_price(coach, kind, minutes, vip)


def vip(db: Session, coach: Coach, player) -> bool:
    from .pricing import is_vip
    return is_vip(db, coach, player if isinstance(player, Player) or player is None else db.get(Player, player))


def player_busy(db: Session, player: Player) -> list[tuple[datetime, datetime, str]]:
    """Ce qui occupe déjà le joueur, chez tous ses coachs: séances où il est inscrit, demandes en cours, et son propre
    planning (match, tournoi, kiné…). (début, fin, libellé)."""
    from ..models import PlayerEvent
    from .accounts import account_of, linked
    ids = {p.id for p in linked(db, player)}
    names = {c.id: c.name for c in db.scalars(select(Coach))}
    out = []
    for s in db.scalars(select(TrainingSession).join(Attendance, Attendance.session_id == TrainingSession.id)
                        .where(Attendance.player_id.in_(ids), TrainingSession.status != "annulee")):
        out.append((aware(s.start), aware(s.start) + timedelta(minutes=s.duration_min), f"une séance avec {names.get(s.coach_id, 'un coach')}"))
    for b in db.scalars(select(Booking).where(Booking.player_id.in_(ids), Booking.session_id.is_(None),
                                              Booking.status.in_(ACTIVE + ("en_formation",)))):
        out.append((aware(b.start), aware(b.start) + timedelta(minutes=b.duration_min), f"une demande de séance avec {names.get(b.coach_id, 'un coach')}"))
    EV = {"match": "un match", "tournoi": "un tournoi"}
    for e in db.scalars(select(PlayerEvent).where(PlayerEvent.account_id == account_of(db, player).id)):
        out.append((aware(e.start), aware(e.start) + timedelta(minutes=e.duration_min), f"« {e.title} »" if e.title else EV.get(e.kind, "autre chose")))
    return out


def player_clash(db: Session, player: Player, start: datetime, minutes: int, ignore_session: int | None = None) -> str | None:
    """Message si le joueur a déjà quelque chose qui chevauche ce créneau (None = libre)."""
    lo, hi = aware(start), aware(start) + timedelta(minutes=minutes)
    skip = None
    if ignore_session:
        s = db.get(TrainingSession, ignore_session)
        skip = (aware(s.start), aware(s.start) + timedelta(minutes=s.duration_min)) if s else None
    for a, b, label in player_busy(db, player):
        if a < hi and lo < b and (a, b) != skip:
            return f"Vous avez déjà {label} {quand(a, int((b - a).total_seconds() // 60))} : impossible de réserver à ce moment-là."
    return None


def attendee_ids(s: TrainingSession) -> list[int]:
    return [a.player_id for a in s.attendances]


def pending_bookings(db: Session, s: TrainingSession) -> list[Booking]:
    return list(db.scalars(select(Booking).where(Booking.session_id == s.id, Booking.status == "en_attente")))


def pending_joins(db: Session, s: TrainingSession) -> int:
    return len(pending_bookings(db, s))


def booking_pairs(b: Booking, s: TrainingSession) -> set[tuple[int, int]]:
    """(taille, durée) acceptées par une demande (anciennes données: ses formules, à la durée de la séance)."""
    return groups.pairs_of(groups.parse_opts(b.accepted_opts)) or groups.pairs_of({(k, s.duration_min) for k in groups.split(b.accepted_kinds)})


def pending_kinds(db: Session, s: TrainingSession) -> list:
    return [booking_pairs(b, s) for b in pending_bookings(db, s)]


def spots_left(db: Session, s: TrainingSession) -> int:
    """Places restantes: la plus grande taille qui convient à tous (groups.capacity), moins les inscrits et demandes."""
    return groups.capacity(s, pending_kinds(db, s)) - len(s.attendances) - pending_joins(db, s)


def join_target(db: Session, s: TrainingSession, kinds: list[str] | None, durations: dict | None = None, opts=None) -> int | None:
    """Taille visée si un joueur qui accepte ces formules (et ces durées) rejoint la séance (None = pas possible)."""
    mine = groups.pairs_of(opts) if opts else groups.pairs_of(groups.opts_of(kinds, durations, s.duration_min)) if kinds else None
    return groups.join_target(s, mine, len(s.attendances) + pending_joins(db, s), pending_kinds(db, s))


def join_minutes(db: Session, s: TrainingSession, target: int, opts) -> int:
    """Durée jouée si ce joueur rejoint à cette taille: la plus longue que tous acceptent (lui compris)."""
    pairs = groups.allowed_pairs(s, pending_kinds(db, s)) & (groups.pairs_of(opts) if opts else groups.allowed_pairs(s))
    return max([m for n, m in pairs if n == target] or [s.duration_min])


def join_price(coach: Coach, s: TrainingSession, target: int, vip: bool = False) -> int:
    """Séance formée par les joueurs: prix de la formule visée; séance du coach: son prix (VIP: jamais plus que son
    prix VIP de la formule et de la durée)."""
    if groups.is_dynamic(s):
        return price_for(coach, groups.kind_for_size(target), s.duration_min, vip)
    price = s.price_millimes or price_for(coach, s.kind, s.duration_min)
    return min(price, price_for(coach, s.kind, s.duration_min, True)) if vip and s.price_mode == "par_joueur" else price


# --- Créneaux libres ----------------------------------------------------

def _busy(db: Session, coach: Coach) -> list[tuple[datetime, datetime]]:
    """Périodes déjà prises chez ce coach: ses séances (durée la plus longue encore possible) et ses autres événements."""
    from ..models import CoachEvent
    busy = [(aware(s.start), aware(s.start) + timedelta(minutes=s.duration_min))
            for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status != "annulee"))]
    # autres choses sur son planning (rendez-vous, tournoi…): créneau bloqué aussi
    busy += [(aware(e.start), aware(e.start) + timedelta(minutes=e.duration_min))
             for e in db.scalars(select(CoachEvent).where(CoachEvent.coach_id == coach.id))]
    return busy  # les demandes pas encore traitées ne bloquent pas: le coach voit ensemble celles d'un même créneau


def _fits(cur: datetime, length: timedelta, lo: datetime, hi: datetime, busy, shortest: timedelta) -> bool:
    """Le créneau [cur, cur+length] tient dans [lo, hi] sans chevaucher une séance, et ne laisse pas de « trou » inutilisable:
    avant comme après, soit il touche la séance voisine (ou le bord du terrain / de la disponibilité), soit il reste
    au moins la durée de la plus courte séance."""
    end = cur + length
    if cur < lo or end > hi or any(cur < b_end and end > b_start for b_start, b_end in busy):
        return False
    before = max([lo] + [b_end for _, b_end in busy if lo <= b_end <= cur])
    after = min([hi] + [b_start for b_start, _ in busy if end <= b_start <= hi])
    return all(gap == timedelta(0) or gap >= shortest for gap in (cur - before, after - end))


def _grid(coach: Coach) -> tuple[timedelta, timedelta]:
    """Débuts toutes les 30 min (séances d'1 h ou d'1 h 30); pas de trou de moins d'1 h entre deux séances, sauf si le
    coach a choisi de ne pas éviter les trous (Réglages: tout début possible, il est prévenu du temps perdu)."""
    return timedelta(minutes=30), timedelta(minutes=60 if coach.avoid_gaps is not False else 0)


def gap_left(db: Session, coach: Coach, start: datetime, minutes: int) -> int:
    """Minutes de terrain (ou de disponibilité) inutilisables qu'une séance à cet horaire laisserait juste avant ou
    juste après elle (un bout de moins d'1 h, ni collé à une séance ni au bord). 0 = aucun trou."""
    start, end = aware(start), aware(start) + timedelta(minutes=minutes)
    busy = _busy(db, coach)
    if coach.booking_mode == "disponibilites":
        local = start.astimezone(TUNIS)
        spans = [(datetime.combine(local.date(), time.fromisoformat(w.start_time), TUNIS).astimezone(timezone.utc),
                  datetime.combine(local.date(), time.fromisoformat(w.end_time), TUNIS).astimezone(timezone.utc))
                 for w in db.scalars(select(Availability).where(Availability.coach_id == coach.id, Availability.weekday == local.weekday()))]
    else:
        spans = [courts.run_span(r) for r in courts.free_runs(db, coach.id)]
    for lo, hi in spans:
        if lo <= start and end <= hi:
            before = start - max([lo] + [e for _, e in busy if lo <= e <= start])
            after = min([hi] + [s for s, _ in busy if end <= s <= hi]) - end
            return int(sum(g.total_seconds() // 60 for g in (before, after) if timedelta(0) < g < timedelta(minutes=60)))
    return 0


def _free_on_courts(db: Session, coach: Coach, now: datetime, earliest: datetime, minutes: int | None) -> list[datetime]:
    """Mode « terrains »: créneaux qui tiennent entièrement dans un terrain réservé encore libre (et le coach libre)."""
    busy = _busy(db, coach)
    step, shortest = _grid(coach)
    length = timedelta(minutes=minutes or 60)
    until = now + timedelta(days=horizon(coach) + 1)
    out = set()
    for run in courts.free_runs(db, coach.id):  # morceaux qui se suivent = une seule plage libre
        lo, hi = courts.run_span(run)
        cur = lo
        while cur + length <= hi and cur < until:
            # n'importe quel début toutes les 30 min, tant qu'il ne laisse pas de bout de terrain inutilisable
            # (moins d'1 h) avant ou après: 8 h-12 h libre = 8 h, 9 h, 9 h 30, 10 h, 11 h pour 1 h (jamais 8 h 30)
            if cur >= earliest and _fits(cur, length, lo, hi, busy, shortest):
                out.add(cur)
            cur += step
    return sorted(out)


def edges(db: Session, coach: Coach) -> set[datetime]:
    """Bords des plages libres (début / fin des terrains libres, des disponibilités et des séances): un créneau qui
    en touche un ne coupe pas la plage en deux, c'est celui qu'on met en avant (« idéal »)."""
    out = set()
    for s, e in _busy(db, coach):
        out.update((s, e))
    for run in courts.free_runs(db, coach.id):
        out.update(courts.run_span(run))
    if coach.booking_mode == "disponibilites":
        today = datetime.now(TUNIS).date()
        for w in db.scalars(select(Availability).where(Availability.coach_id == coach.id)):
            for off in range(horizon(coach) + 1):
                day = today + timedelta(days=off)
                if day.weekday() == w.weekday:
                    out.add(datetime.combine(day, time.fromisoformat(w.start_time), TUNIS).astimezone(timezone.utc))
                    out.add(datetime.combine(day, time.fromisoformat(w.end_time), TUNIS).astimezone(timezone.utc))
    return out


def days_off(db: Session, coach: Coach) -> list[tuple]:
    """Absences du coach (vacances…): (premier jour, dernier jour) en dates de Tunis."""
    from ..models import TimeOff
    return [(t.start_date, t.end_date) for t in db.scalars(select(TimeOff).where(TimeOff.coach_id == coach.id))]


def is_day_off(offs: list[tuple], when: datetime) -> bool:
    d = aware(when).astimezone(TUNIS).date()
    return any(a <= d <= b for a, b in offs)


def day_states(db: Session, coach: Coach, days: list, now: datetime | None = None) -> dict:
    """Jours où ce coach n'a plus rien à proposer: « absent » (absence déclarée) ou « complet »: dans ses horaires de
    travail (Réglages › Disponibilités) de ce jour-là, plus aucun trou d'au moins 1 h une fois retirées ses séances et
    ses autres événements (terrains et mode de réservation ne comptent pas). Un jour sans horaires de travail est
    complet; un coach qui n'a déclaré aucun horaire n'est jamais complet. Les autres jours ne sont pas dans le résultat."""
    now = now or datetime.now(timezone.utc)
    offs = days_off(db, coach)
    windows = list(db.scalars(select(Availability).where(Availability.coach_id == coach.id)))
    busy = _busy(db, coach)
    hour = timedelta(hours=1)

    def at(d, hm: str) -> datetime:
        h, m = (int(x) for x in hm.split(":"))
        return datetime.combine(d, time(h, m), TUNIS).astimezone(timezone.utc)

    def has_hour(d) -> bool:
        for w in (w for w in windows if w.weekday == d.weekday()):
            lo, hi = max(at(d, w.start_time), now), at(d, w.end_time)
            cur = lo
            for b0, b1 in sorted((b0, b1) for b0, b1 in busy if b0 < hi and b1 > lo):
                if b0 - cur >= hour:
                    return True
                cur = max(cur, b1)
            if hi - cur >= hour:
                return True
        return False

    out = {}
    for d in days:
        if any(a <= d <= b for a, b in offs):
            out[d] = "absent"
        elif windows and not has_hour(d):
            out[d] = "complet"
    return out


def free_slots(db: Session, coach: Coach, now: datetime | None = None, minutes: int | None = None) -> list[datetime]:
    """Créneaux libres, sauf les jours d'absence du coach."""
    offs = days_off(db, coach)
    last = (now or datetime.now(timezone.utc)).astimezone(TUNIS).date() + timedelta(days=horizon(coach))  # limite du coach
    return [s for s in _free_slots(db, coach, now, minutes) if not is_day_off(offs, s) and s.astimezone(TUNIS).date() <= last]


def _free_slots(db: Session, coach: Coach, now: datetime | None = None, minutes: int | None = None) -> list[datetime]:
    """Créneaux libres (UTC), triés, sur les HORIZON_DAYS prochains jours, pour une séance de `minutes` (défaut: individuelle).
    Les débuts possibles suivent une grille commune à toutes les formules (ex. 60 et 90 min -> toutes les 30 min),
    sans chevaucher une séance déjà ouverte et sans laisser de trou trop court entre deux séances."""
    now = now or datetime.now(timezone.utc)
    earliest = now + timedelta(hours=MIN_NOTICE_H)
    if coach.booking_mode != "disponibilites":
        return _free_on_courts(db, coach, now, earliest, minutes)
    windows = db.scalars(select(Availability).where(Availability.coach_id == coach.id)).all()
    busy = _busy(db, coach)
    step, shortest = _grid(coach)
    length = timedelta(minutes=minutes or 60)
    out = []
    today = now.astimezone(TUNIS).date()
    for off in range(horizon(coach) + 1):
        day = today + timedelta(days=off)
        for w in (w for w in windows if w.weekday == day.weekday()):
            lo = datetime.combine(day, time.fromisoformat(w.start_time), TUNIS).astimezone(timezone.utc)
            hi = datetime.combine(day, time.fromisoformat(w.end_time), TUNIS).astimezone(timezone.utc)
            cur = lo
            while cur + length <= hi:
                if cur >= earliest and _fits(cur, length, lo, hi, busy, shortest):
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
        return gap <= 0.5, gap  # au plus un cran (demi-tranche) d'écart avec le niveau visé
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
        if join_target(db, s, kinds) is None:  # la taille de la séance avec lui doit convenir à tous (formules choisies)
            continue
        kind_penalty = 0
        days = (aware(s.start) - earliest).total_seconds() / 86400
        players = [db.get(Player, pid) for pid in attendee_ids(s)]
        out.append({
            "session_id": s.id, "start": s.start, "duration_min": s.duration_min, "kind": s.kind, "club": s.club,
            "spots_left": spots_left(db, s), "capacity": CAPACITY[s.kind], "price_millimes": s.price_millimes or price_for(coach, s.kind, s.duration_min),
            "players": [{"name": p.name, "category": p.category, "gender": p.gender} for p in players],
            "level": s.level, "gap": round(gap, 1), "court_state": court_state(db, s),
            "match": "ideal" if kind_penalty == 0 else "proche", "_score": gap + kind_penalty + days * 0.03,
        })
    out.sort(key=lambda x: x["_score"])
    for x in out:
        x.pop("_score")
    return out[:8]


# --- Demandes -----------------------------------------------------------

def _debit(db: Session, b: Booking) -> None:
    """À la validation par le coach, le prix est débité des crédits du joueur chez ce coach, même si le solde
    ne suffit pas: un solde négatif est ce que le joueur doit au coach (DP-001). Rien n'est débité à la demande."""
    if b.charged_millimes:  # ancienne réservation déjà débitée au moment de la demande: pas deux fois
        return
    price = b.price_millimes
    if price:
        db.add(CreditTx(coach_id=b.coach_id, player_id=b.player_id, amount_millimes=-price, reason="reservation", booking_id=b.id))
        b.charged_millimes = price


def request_join(db: Session, coach: Coach, player: Player, s: TrainingSession, sms: SmsProvider | None = None, *, force_accept: bool = False,
                 kinds: list[str] | None = None, durations: dict | None = None) -> Booking:
    """Le joueur demande une place dans une séance existante (kinds: formules qu'il a choisies, s'il les a précisées;
    durations: durées acceptées par formule). La taille et la durée de la séance après son arrivée doivent convenir
    à tous (voir services/groups); la durée la plus courte demandée l'emporte."""
    if not s.open or s.status != "prevue" or aware(s.start) < datetime.now(timezone.utc):
        raise BookingError("Cette séance n'est plus disponible")
    if player.id in attendee_ids(s) or db.scalar(select(Booking).where(Booking.session_id == s.id, Booking.player_id == player.id, Booking.status.in_(ACTIVE))):
        raise BookingError("Vous êtes déjà inscrit à cette séance")
    if spots_left(db, s) <= 0:
        raise BookingError("Cette séance est complète")
    clash = player_clash(db, player, s.start, s.duration_min)  # déjà pris ailleurs (autre coach, kiné…)
    if clash:
        raise BookingError(clash)
    dynamic = groups.is_dynamic(s)
    if dynamic and not kinds:
        # invité par le coach (sans formule précisée): il accepte toutes les tailles que la séance permet encore,
        # pour ne pas fermer une séance que les autres acceptent de compléter
        n = len(s.attendances) + 1
        kinds = [k for k in groups.ORDER if any(groups.kind_for_size(x) == k for x, _ in groups.allowed_pairs(s) if x >= n)] or None
        opts = {(groups.kind_for_size(x), m) for x, m in groups.allowed_pairs(s) if x >= n} or None
    else:
        opts = groups.opts_of(kinds, durations, s.duration_min) if kinds else None
    target = join_target(db, s, kinds, opts=opts)
    if target is None:
        if kinds and durations is not None and join_target(db, s, kinds) is not None:
            raise BookingError(f"Cette séance dure {s.duration_min} min : ce n'est pas la durée que vous avez choisie")
        raise BookingError("Cette séance ne correspond pas aux formules que vous avez choisies")
    if not force_accept and not fits_session(db, player, s)[0]:
        raise BookingError("Votre classement n'est pas compatible avec les joueurs de cette séance")
    minutes = join_minutes(db, s, target, opts) if dynamic else s.duration_min
    v = vip(db, coach, player)
    price = price_for(coach, groups.kind_for_size(target), minutes, v) if dynamic else join_price(coach, s, target, v)
    b = Booking(coach_id=coach.id, player_id=player.id, kind=groups.kind_for_size(target) if dynamic or kinds else s.kind,
                start=s.start, duration_min=minutes, session_id=s.id, charged_millimes=0, price_millimes=price,
                accepted_kinds=",".join(k for k in groups.ORDER if k in (kinds or [])), accepted_opts=groups.dump_opts(opts or []))
    db.add(b)
    db.flush()
    if force_accept or coach.auto_confirm:
        accept(db, coach, b, sms)
    _tell_coach_new(db, coach, player, b)
    db.commit()
    return b


def request_new(db: Session, coach: Coach, player: Player, kind: str, start: datetime, sms: SmsProvider | None = None,
                accepted_kinds: list[str] | None = None, minutes: int | None = None, durations: dict | None = None,
                forming: bool = False, partner: Booking | None = None) -> Booking:
    """Le joueur demande un nouveau créneau (séance ouverte aux autres joueurs si duo/groupe).
    accepted_kinds: formules qu'il accepte (seul, duo, groupe); durations: durées acceptées pour chacune (seul = 1 h).
    Il ne choisit pas la durée: la séance retient la plus longue possible à ce début, et raccourcit si un joueur qui
    la rejoint n'accepte que 1 h (la condition la plus stricte l'emporte). minutes: durée imposée (facultatif)."""
    if kind not in CAPACITY:
        raise BookingError("Type de séance invalide")
    wanted = [k for k in groups.ORDER if k in (accepted_kinds or []) or k == kind]
    if aware(start).astimezone(TUNIS).date() > datetime.now(TUNIS).date() + timedelta(days=horizon(coach)):
        raise BookingError(f"{coach.name} ouvre ses réservations {horizon_label(horizon(coach))} à l'avance au plus : choisissez une date plus proche.")
    shortest = min([m for m in (60, 90) if minutes in (None, m)] or [60])
    clash = player_clash(db, player, start, shortest)  # le joueur est déjà pris (autre coach, kiné…)
    if clash:
        raise BookingError(clash)
    feasible = [m for m in (60, 90) if minutes in (None, m) and aware(start) in free_slots(db, coach, minutes=m)]
    # sans durées précisées (anciens appels): 1 h, ou la durée imposée
    every = {(k, m) for k, m in (groups.opts_of(wanted, durations, 60) if durations is not None else groups.opts_of(wanted, None, minutes or 60))
             if m in coach_durations(coach, k)}  # seulement les formules et durées que ce coach propose
    # la séance retient la plus longue durée possible à ce début; les formules plus courtes cochées restent
    # possibles à l'intérieur (seul 1 h dans un terrain d'1 h 30: s'il reste seul, il joue 1 h)
    length = max((m for _, m in every if m in feasible), default=None)
    opts = {(k, m) for k, m in every if length and m <= length}
    if not opts:
        if not feasible:
            raise BookingError("Ce créneau n'est plus disponible")
        offered = ", ".join(f"{KIND_FR[k].lower()} {' ou '.join(_dur(m) for m in coach_durations(coach, k))}" for k in wanted if coach_durations(coach, k))
        raise BookingError(f"{coach.name} ne propose pas ces durées" + (f" (il propose : {offered})" if offered else " pour ces formules") + ".")
    accepted = [k for k in groups.ORDER if any(o[0] == k for o in opts)]
    kind = groups.smallest(accepted)  # s'il reste seul (ou au minimum voulu), c'est cette formule qui est jouée
    if not forming and not partner and not groups.can_open(kind, start):  # partner: il rejoint la demande d'un autre joueur  # groupe monté par un joueur: il invite lui-même ses partenaires
        raise BookingError("Pour ouvrir une séance à deux ou en groupe, elle doit avoir lieu dans plus de 24 h (le temps de compléter le groupe)")
    length = max(m for k, m in opts if k == kind)  # durée jouée s'il reste à la taille minimale voulue
    q = quote(db, coach, kind, start, length, vip(db, coach, player))  # prix (VIP), heures creuses / promotion
    b = Booking(coach_id=coach.id, player_id=player.id, kind=kind, start=aware(start), duration_min=max(m for _, m in opts), charged_millimes=0,
                accepted_kinds=",".join(accepted), accepted_opts=groups.dump_opts(opts), price_millimes=q["price_millimes"],
                discount_pct=q["discount_pct"], discount_millimes=q["discount_millimes"])
    if partner:  # demande groupée: le coach la voit avec celle de l'autre joueur (même créneau) et les accepte ensemble
        partner.group_id = partner.group_id or partner.id
        b.group_id = partner.group_id
    if forming:  # réservation en groupe: le coach ne la voit qu'une fois le minimum de joueurs réuni (services/group_booking)
        b.status = "en_formation"
        db.add(b)
        db.flush()
        return b
    db.add(b)
    db.flush()
    held = courts.held_covering(db, coach, b.start, b.duration_min, merge=True) if coach.auto_confirm and not same_slot(db, b) else []
    if held:
        accept(db, coach, b, sms, court=held[0])  # terrain disponible: validation automatique
    _tell_coach_new(db, coach, player, b)
    db.commit()
    return b


def _dur(m: int) -> str:
    return "1 h 30" if m == 90 else f"{m // 60} h" if m % 60 == 0 else f"{m} min"


def _fit_minutes(coach: Coach, kind: str, minutes: int) -> int:
    """Durée pour une formule ajoutée en cours de route: celle de la séance si le coach la propose, sinon la plus
    longue qu'il propose sans dépasser la séance (seul 1 h dans une séance d'1 h 30)."""
    ds = coach_durations(coach, kind)
    return minutes if minutes in ds or not ds else max([m for m in ds if m <= minutes] or [min(ds)])


def same_slot(db: Session, b: Booking) -> list[Booking]:
    """Autres demandes de nouvelle séance pas encore traitées qui chevauchent celle-ci (même créneau)."""
    end = aware(b.start) + timedelta(minutes=b.duration_min)
    return [x for x in db.scalars(select(Booking).where(Booking.coach_id == b.coach_id, Booking.status == "en_attente",
                                                       Booking.session_id.is_(None), Booking.id != b.id))
            if aware(x.start) < end and aware(b.start) < aware(x.start) + timedelta(minutes=x.duration_min)]


def _tell_coach_new(db: Session, coach: Coach, player: Player, b: Booking) -> None:
    details = [("Quand", quand(b.start, b.duration_min)), ("Formule", KIND_FR.get(b.kind, "")),
               ("Formules acceptées", ", ".join(KIND_FR[k].lower() for k in groups.split(b.accepted_kinds)))]
    gap = gap_left(db, coach, b.start, b.duration_min) if not b.session_id else 0
    warn = [f"Attention : à cet horaire, {gap} min de terrain resteront inutilisables (trop court pour une autre séance)."] if gap else []
    if b.status == "en_attente":
        notify_coach(db, coach.id, f"Nouvelle demande de {player.name}", f"{player.name} ({player.category}) demande une séance :", details,
                     *warn, "Acceptez-la ou refusez-la dans l'onglet Demandes de l'application.")
    else:
        notify_coach(db, coach.id, f"Nouvelle réservation de {player.name}", f"{player.name} ({player.category}) a réservé une séance, validée automatiquement :", details)


def accept(db: Session, coach: Coach, b: Booking, sms: SmsProvider | None = None, *, court: CourtBooking | None = None, club: Club | None = None,
           minutes: int | None = None) -> None:
    """Le coach accepte. Avec un terrain libre (court): confirmée. Avec un club: demande de terrain envoyée, en attente.
    Sans rien: acceptée, terrain à confirmer à la main."""
    if b.status != "en_attente":
        raise BookingError("Demande déjà traitée")
    player = db.get(Player, b.player_id)
    if minutes and not b.session_id and minutes != b.duration_min:
        # le coach choisit la durée parmi celles que le joueur accepte (1 h 30 par défaut, ou 1 h)
        opts = groups.parse_opts(b.accepted_opts)
        if not any(m == minutes for _, m in opts):
            raise BookingError("Le joueur n'a pas accepté cette durée.")
        b.duration_min = minutes
        b.accepted_opts = groups.dump_opts({o for o in opts if o[1] <= minutes})
    if not b.session_id:
        # même créneau qu'une séance déjà acceptée (plusieurs joueurs ont demandé le même): compatible = il la rejoint
        other = same_time_session(db, coach, b)
        if other:
            b.session_id = other.id
            b.start, b.duration_min = other.start, other.duration_min
    if b.session_id:  # rejoindre une séance existante
        s = db.get(TrainingSession, b.session_id)
        kinds = groups.split(b.accepted_kinds)
        n = len(s.attendances)
        pairs = booking_pairs(b, s) if kinds else None
        if n + 1 > groups.capacity(s) or (pairs and not any(x >= n + 1 for x, _ in groups.allowed_pairs(s) & pairs)):
            raise BookingError("Cette séance est complète")
        _debit(db, b)
        # formules retenues: celles qui permettent sa taille actuelle ou plus
        mine = [k for k in kinds if max(groups.SIZES[k]) >= n + 1]
        opts = {(k, m) for k, m in groups.parse_opts(b.accepted_opts) if k in mine}
        s.attendances.append(Attendance(player_id=player.id, credit_paid_millimes=b.charged_millimes, accepted_kinds=",".join(mine),
                                        accepted_opts=groups.dump_opts(opts)))
        b.status = "acceptee"
        refresh(db, s)
        _announce_accepted(db, coach, b, s)
        return
    if court and not (aware(court.start) <= aware(b.start) and aware(court.start) + timedelta(minutes=court.duration_min)
                      >= aware(b.start) + timedelta(minutes=b.duration_min)):
        court = None  # morceau d'une plage libre plus grande: on prend la plage entière ci-dessous
    if not court:  # un coach n'a qu'un terrain à la fois: son terrain libre à cette heure est forcément celui de la séance
        held = courts.held_covering(db, coach, b.start, b.duration_min, merge=True)
        if held:
            court, club = held[0], None
        elif club and courts.overlapping(db, coach, b.start, b.duration_min):
            raise BookingError(courts.busy_message(db, courts.overlapping(db, coach, b.start, b.duration_min)[0]))
    if not b.price_millimes:
        b.price_millimes = price_for(coach, b.kind, b.duration_min, vip(db, coach, b.player_id))
    _debit(db, b)
    s = TrainingSession(
        coach_id=coach.id, start=b.start, duration_min=b.duration_min, kind=b.kind, level=player.category,
        price_millimes=b.price_millimes or b.charged_millimes or price_for(coach, b.kind, b.duration_min), price_mode="par_joueur", open=b.kind != "individuel",
    )
    # toutes les formules cochées: la plus petite = taille minimale voulue, les autres restent possibles
    mine = groups.split(b.accepted_kinds) or [b.kind]
    s.attendances = [Attendance(player_id=player.id, credit_paid_millimes=b.charged_millimes, accepted_kinds=",".join(mine),
                                accepted_opts=b.accepted_opts or "")]
    db.add(s)
    db.flush()
    b.session_id = s.id
    if court:
        courts.take_part(db, court, s)  # le reste du bloc réservé reste libre
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
    refresh(db, s)  # pas encore assez de joueurs: « en attente d'autres joueurs »
    _announce_accepted(db, coach, b, s)


def same_time_session(db: Session, coach: Coach, b: Booking) -> TrainingSession | None:
    """Demande d'un nouveau créneau alors qu'une séance du coach le chevauche déjà (souvent: une autre demande du même
    créneau, acceptée juste avant). Même début, formules, durées et niveaux compatibles: la séance qu'il peut rejoindre.
    Sinon, refus expliqué: le coach n'est jamais à deux séances en même temps."""
    end = aware(b.start) + timedelta(minutes=b.duration_min)
    clash = [s for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status == "prevue"))
             if aware(s.start) < end and aware(b.start) < aware(s.start) + timedelta(minutes=s.duration_min)]
    if not clash:
        return None
    player = db.get(Player, b.player_id)
    for s in clash:
        if aware(s.start) == aware(b.start) and s.open and groups.is_dynamic(s) and fits_session(db, player, s)[0] \
                and groups.join_target(s, booking_pairs(b, s), len(s.attendances) + pending_joins(db, s), pending_kinds(db, s)) is not None:
            return s
    s = clash[0]
    names = ", ".join(db.get(Player, a.player_id).name.split()[0] for a in s.attendances) or "sans joueur"
    raise BookingError(f"Ce créneau est déjà pris par une autre séance ({quand(s.start, s.duration_min)}, {names}) qui ne lui convient pas : "
                       "refusez cette demande ou proposez-lui un autre horaire.")


def _announce_accepted(db: Session, coach: Coach, b: Booking, s: TrainingSession) -> None:
    """Demande acceptée mais pas encore confirmée (terrain à réserver, ou groupe à compléter): le joueur est prévenu."""
    if b.status == "acceptee":
        why = "Le terrain est en cours de réservation : vous recevrez un e-mail dès que la séance sera confirmée."
    elif b.status == "attente_joueurs":
        why = f"Elle sera confirmée dès que le groupe sera complet ({len(s.attendances)}/{groups.min_needed(s)} joueurs pour l'instant)."
    else:
        return
    notify(db, [db.get(Player, b.player_id)], "Votre demande de séance est acceptée", lambda p: letter(
        p.name, f"{coach.name} a accepté votre demande de séance de padel.", _details(s), why, sign=coach.name))


KIND_FR = {"individuel": "Seul", "duo": "À deux", "groupe": "En groupe"}


def _details(s: TrainingSession, coach: Coach | None = None) -> list[tuple[str, str]]:
    """Détails d'une séance dans les messages: quand, où, formule, coach."""
    return [("Quand", quand(s.start, s.duration_min)), ("Où", " · ".join(x for x in (s.club, s.court) if x)),
            ("Formule", KIND_FR.get(s.kind, "")), ("Coach", coach.name if coach else "")]


def _when(s: TrainingSession) -> str:
    t = aware(s.start).astimezone(TUNIS)
    return f"{courts.JOURS[t.weekday()]} {t:%d/%m} à {t:%H}h{t:%M}" + (f" ({s.club})" if s.club else "")


def short_text(text: str) -> str:
    """Message pour l'appli: sans la formule de politesse du début ni la signature."""
    lines = text.strip().splitlines()
    if lines and lines[0].startswith("Bonjour"):
        lines = lines[1:]
    for i, line in enumerate(lines):
        if line.strip() in ("À bientôt,", "À très vite,"):
            lines = lines[:i]
            break
    return "\n".join(lines).strip()


def app_notify(db: Session, p: Player, title: str, body: str, kind: str = "message", **refs) -> None:
    """Notification dans l'appli du joueur (sur sa fiche compte), s'il a un compte."""
    from ..models import Notification
    from .accounts import account_of
    acc = account_of(db, p)
    if acc.password_hash:
        db.add(Notification(account_id=acc.id, coach_id=p.coach_id, kind=kind, title=title[:160], body=short_text(body)[:2000], **refs))


def notify(db: Session, players: list[Player], subject: str, body_for, kind: str = "message", **refs) -> int:
    """Message à des joueurs, par le moyen qu'ils ont choisi (voir app/notify.py), et dans leur appli."""
    from ..notify import Notifier  # import local: notify importe les modèles
    from ..sms import get_sms_provider
    from .accounts import contact_email
    notifier, sent = Notifier(get_sms_provider()), 0
    from ..notify import channel_for
    for p in players:
        channel = channel_for(p, contact_email(db, p))  # e-mail en version bêta
        app_notify(db, p, subject, body_for(p), kind, **refs)
        try:
            notifier.send(p, channel, subject, body_for(p), email=contact_email(db, p))
            sent += 1
        except Exception:  # un envoi raté ne bloque pas les autres
            continue
    return sent


def _court_txt(s: TrainingSession) -> str:
    return f" · {s.court}" if s.court else ""


def notify_coach(db: Session, coach_id: int, subject: str, *blocks) -> None:
    """Message au coach (e-mail de son compte), même mise en page que pour les joueurs."""
    from ..notify import send_email
    coach = db.get(Coach, coach_id)
    try:
        send_email(coach.email, subject, letter(coach.name, *blocks))
    except Exception:  # un envoi raté ne bloque jamais l'action
        pass


def announce_confirmed(db: Session, s: TrainingSession) -> None:
    """Réservations confirmées pas encore annoncées au joueur: e-mail de confirmation, puis marquées « prévenu »."""
    db.flush()  # statuts qui viennent de changer
    todo = list(db.scalars(select(Booking).where(Booking.session_id == s.id, Booking.status == "confirmee", Booking.notified_at.is_(None))))
    if not todo:
        return
    coach = db.get(Coach, s.coach_id)
    notify(db, [db.get(Player, b.player_id) for b in todo], "Votre séance de padel est confirmée", lambda p: letter(
        p.name, "Bonne nouvelle : votre séance de padel est confirmée.", _details(s, coach),
        "Pensez à arriver quelques minutes en avance. En cas d'empêchement, gérez votre réservation dans l'application.", sign=coach.name))
    for b in todo:
        b.notified_at = datetime.now(timezone.utc)


def refresh(db: Session, s: TrainingSession) -> None:
    """Après une arrivée ou un départ: libellé, ouverture et état des réservations de la séance.
    - pas assez de joueurs pour tous: « attente_joueurs »
    - assez de joueurs: « acceptee » (terrain à confirmer) ou « confirmee »; les joueurs qui attendaient sont prévenus."""
    db.flush()
    if groups.is_dynamic(s):
        s.kind = groups.kind_for_size(max(len(s.attendances), groups.min_needed(s)))
        s.open = groups.capacity(s) > len(s.attendances)
        # durée: la plus longue que tous acceptent (un joueur qui ne veut que 1 h raccourcit la séance de 1 h 30)
        s.duration_min = min(s.duration_min, groups.best_minutes(s))
        # moins de 24 h avant (plus le temps de former un groupe): la séance prend la durée réellement jouée
        # (seul = 1 h), le reste du terrain redevient libre
        if aware(s.start) - datetime.now(timezone.utc) < groups.FORM_DELAY:
            s.duration_min = min(s.duration_min, groups.played_minutes(s))
        courts.fit_session(db, s)
    complete, state = groups.is_complete(s), court_state(db, s)
    coach = db.get(Coach, s.coach_id)
    if groups.is_dynamic(s):
        for b in db.scalars(select(Booking).where(Booking.session_id == s.id, Booking.status.in_(("attente_joueurs", "acceptee", "confirmee")))):
            _reprice(db, coach, s, b)
    newly = []
    for b in db.scalars(select(Booking).where(Booking.session_id == s.id, Booking.status.in_(("attente_joueurs", "acceptee", "confirmee")))):
        new = "attente_joueurs" if not complete else "acceptee" if state not in (None, "confirmee") else "confirmee"
        if b.status == "attente_joueurs" and new != "attente_joueurs":
            newly.append(b)
            b.notified_at = datetime.now(timezone.utc)  # prévenu automatiquement ci-dessous
        b.status = new
    announce_confirmed(db, s)
    if newly:
        others = len(s.attendances) - 1
        notify(db, [db.get(Player, b.player_id) for b in newly], "Votre séance de padel est confirmée", lambda p: letter(
            p.name, f"Bonne nouvelle : {others} joueur{'s ont' if others > 1 else ' a'} rejoint votre séance de padel, "
            f"elle est confirmée{'' if state in (None, 'confirmee') else ' (le terrain est en cours de réservation)'}.", _details(s, coach),
            sign=coach.name))


def _reprice(db: Session, coach: Coach, s: TrainingSession, b: Booking) -> None:
    """Prix de la formule réellement jouée (taille de la séance), avec la remise obtenue à la réservation.
    Déjà débité: la différence est rendue ou débitée (« ajustement »)."""
    played = groups.played_minutes(s)  # seul: 1 h, même si le terrain reste gardé 1 h 30 pour un groupe
    price = reduced(price_for(coach, s.kind, played, vip(db, coach, b.player_id)), b.discount_pct, b.discount_millimes)
    b.kind, b.duration_min = s.kind, played
    if price == b.price_millimes:
        return
    b.price_millimes = price
    if b.charged_millimes and price != b.charged_millimes:
        db.add(CreditTx(coach_id=b.coach_id, player_id=b.player_id, amount_millimes=b.charged_millimes - price, reason="ajustement", booking_id=b.id))
        b.charged_millimes = price
        for a in s.attendances:
            if a.player_id == b.player_id:
                a.credit_paid_millimes = price


def reconsider(db: Session, coach: Coach, b: Booking, kind: str) -> None:
    """Le joueur accepte une formule de plus (ex. « seul » alors qu'il attendait un partenaire): la séance est
    recalculée (confirmée s'il le faut) et son prix suit la formule réellement jouée."""
    if kind not in CAPACITY:
        raise BookingError("Formule invalide")
    if b.status not in ACTIVE or aware(b.start) <= datetime.now(timezone.utc):
        raise BookingError("Cette réservation ne peut plus être modifiée")
    s = db.get(TrainingSession, b.session_id) if b.session_id else None
    mine = [k for k in groups.ORDER if k in set(groups.split(b.accepted_kinds)) | {kind}]
    if s and b.status != "en_attente":
        a = next(x for x in s.attendances if x.player_id == b.player_id)
        old = a.accepted_kinds, a.accepted_opts
        a.accepted_kinds = ",".join(mine)
        if a.accepted_opts:  # nouvelle formule acceptée à la durée de la séance (seul: toujours 1 h)
            a.accepted_opts = groups.dump_opts(groups.parse_opts(a.accepted_opts) | {(kind, _fit_minutes(coach, kind, s.duration_min))})
        if len(s.attendances) > groups.capacity(s):
            a.accepted_kinds, a.accepted_opts = old
            raise BookingError("Cette formule n'est pas compatible avec les autres joueurs de la séance")
    b.accepted_kinds = ",".join(mine)
    if b.accepted_opts:
        b.accepted_opts = groups.dump_opts(groups.parse_opts(b.accepted_opts) | {(kind, _fit_minutes(coach, kind, s.duration_min if s else b.duration_min))})
    if s and b.status != "en_attente":
        refresh(db, s)
    else:  # pas encore validée par le coach: formule de départ et prix mis à jour
        b.kind = groups.smallest(mine)
        b.price_millimes = reduced(price_for(coach, b.kind, b.duration_min, vip(db, coach, b.player_id)), b.discount_pct, b.discount_millimes)


def settle_durations(db: Session, now: datetime | None = None) -> int:
    """Séances formées par les joueurs à moins de 24 h: durée réellement jouée (seul = 1 h), terrain libéré."""
    now = now or datetime.now(timezone.utc)
    count = 0
    for s in db.scalars(select(TrainingSession).where(TrainingSession.status == "prevue", TrainingSession.start > now,
                                                     TrainingSession.start <= now + groups.FORM_DELAY)):
        if groups.is_dynamic(s) and groups.played_minutes(s) < s.duration_min:
            refresh(db, s)
            count += 1
    if count:
        db.commit()
    return count


def remind_incomplete(db: Session, now: datetime | None = None) -> int:
    """6 h avant: séance toujours sans le nombre minimum de joueurs -> les joueurs qui attendent sont invités
    à reconsidérer leur choix (passer à une autre formule) ou à annuler. Une seule fois par joueur."""
    from ..models import SessionReminder
    now = now or datetime.now(timezone.utc)
    done = {(r.session_id, r.player_id) for r in db.scalars(select(SessionReminder).where(SessionReminder.kind == "min"))}
    count = 0
    for b in db.scalars(select(Booking).where(Booking.status == "attente_joueurs")):
        if not (now < aware(b.start) <= now + groups.REMIND_BEFORE) or (b.session_id, b.player_id) in done:
            continue
        s, p, coach = db.get(TrainingSession, b.session_id), db.get(Player, b.player_id), db.get(Coach, b.coach_id)
        body = letter(p.name, f"Votre séance de padel n'a pas encore assez de joueurs ({len(s.attendances)}/{groups.min_needed(s)}) :",
                      _details(s, coach),
                      "Ouvrez l'application pour changer de formule (par exemple passer en solo), ou annuler votre demande : elle vous sera remboursée.",
                      sign=coach.name)
        notify(db, [p], "Votre séance de padel n'est pas encore complète", lambda _p: body)
        db.add(SessionReminder(coach_id=b.coach_id, session_id=s.id, player_id=p.id, kind="min", channel=p.contact_channel or "sms", message=body))
        count += 1
    db.commit()
    return count


def _refund(db: Session, b: Booking) -> None:
    if b.charged_millimes:
        db.add(CreditTx(coach_id=b.coach_id, player_id=b.player_id, amount_millimes=b.charged_millimes, reason="remboursement", booking_id=b.id))


def refuse(db: Session, b: Booking) -> None:
    if b.status != "en_attente":
        raise BookingError("Demande déjà traitée")
    b.status = "refusee"
    _refund(db, b)
    coach = db.get(Coach, b.coach_id)
    notify(db, [db.get(Player, b.player_id)], "Votre demande de séance n'a pas pu être acceptée", lambda p: letter(
        p.name, f"{coach.name} ne peut malheureusement pas assurer la séance demandée :", [("Quand", quand(b.start, b.duration_min))],
        f"{'Vos crédits vous ont été rendus. ' if b.charged_millimes else ''}Vous pouvez choisir un autre créneau dans l'application.",
        sign=coach.name))


def _release(db: Session, b: Booking) -> None:
    """Retire le joueur de la séance; si elle est vide elle est annulée et le terrain redevient libre."""
    if not b.session_id:
        return
    s = db.get(TrainingSession, b.session_id)
    s.attendances = [a for a in s.attendances if a.player_id != b.player_id]
    if s.attendances and s.status == "prevue":
        refresh(db, s)  # les autres repassent éventuellement en « attente d'autres joueurs »
    if not s.attendances and s.status == "prevue":
        s.status = "annulee"
        for cb in db.scalars(select(CourtBooking).where(CourtBooking.session_id == s.id)):
            if cb.status == "confirmee":
                cb.session_id = None  # le terrain reste réservé: on pourra le réutiliser
            else:
                cb.status = "annulee"


# Annulation par le joueur: jusqu'à 24 h avant pour une séance seul, 48 h avant à deux ou en groupe.
# Après ce délai, il ne peut plus annuler: il envoie un lien pour se faire remplacer (`replace`).
CANCEL_BEFORE = {"individuel": timedelta(hours=24), "duo": timedelta(hours=48), "groupe": timedelta(hours=48)}


def cancel_deadline(b: Booking) -> datetime:
    return aware(b.start) - CANCEL_BEFORE.get(b.kind, timedelta(hours=48))


def can_cancel(b: Booking, now: datetime | None = None) -> bool:
    """Demande pas encore acceptée ou groupe pas encore formé: toujours annulable (et remboursé)."""
    now = now or datetime.now(timezone.utc)
    return b.status in ("en_attente", "attente_joueurs") or now <= cancel_deadline(b)


def ensure_booking(db: Session, s: TrainingSession, player_id: int) -> Booking:
    """Séance montée par le coach (joueur inscrit sans réservation): on crée la réservation correspondante pour
    que le joueur puisse annuler ou se faire remplacer avec les mêmes règles que pour une réservation faite en ligne."""
    b = db.scalar(select(Booking).where(Booking.session_id == s.id, Booking.player_id == player_id, Booking.status.in_(ACTIVE)))
    if b:
        return b
    a = next((x for x in s.attendances if x.player_id == player_id), None)
    if not a or s.status != "prevue":
        raise BookingError("Séance introuvable")
    n = len(s.attendances) or 1
    price = s.price_millimes // n if s.price_mode == "groupe" else s.price_millimes  # part de ce joueur
    b = Booking(coach_id=s.coach_id, player_id=player_id, kind=s.kind, start=s.start, duration_min=s.duration_min, status="confirmee",
                session_id=s.id, accepted_kinds="", price_millimes=price, charged_millimes=a.credit_paid_millimes,
                notified_at=datetime.now(timezone.utc))
    db.add(b)
    db.flush()
    return b


def cancel_booking(db: Session, coach: Coach, b: Booking) -> bool:
    """Annulation par le joueur, dans les délais: les crédits sont remboursés. Retourne True (remboursé)."""
    if b.status not in ACTIVE:
        raise BookingError("Cette réservation ne peut plus être annulée")
    if aware(b.start) <= datetime.now(timezone.utc):
        raise BookingError("Cette séance est déjà passée")
    if not can_cancel(b):
        h = int(CANCEL_BEFORE.get(b.kind, timedelta(hours=48)).total_seconds() // 3600)
        raise BookingError(f"Trop tard pour annuler (au plus tard {h} h avant). Envoyez le lien de la séance à un joueur qui peut vous remplacer.")
    was_pending = b.status == "en_attente"
    b.status, b.cancelled_at = "annulee", datetime.now(timezone.utc)
    if not was_pending:
        _release(db, b)
    _refund(db, b)
    t = aware(b.start).astimezone(TUNIS)
    who = db.get(Player, b.player_id).name
    notify_coach(db, b.coach_id, f"{who} a annulé", f"{who} a annulé {'sa demande pour ' if was_pending else ''}cette séance :",
                 [("Quand", quand(b.start, b.duration_min)), ("Formule", KIND_FR.get(b.kind, ""))])
    return True


def replace(db: Session, b: Booking, newcomer: Player) -> Booking:
    """Un autre joueur prend la place: il reprend la réservation (même formule, même prix) et paie avec ses
    crédits chez ce coach (solde négatif possible = impayé); celui qui part récupère ses crédits."""
    from .accounts import account_of
    if b.status not in ("acceptee", "confirmee", "attente_joueurs") or not b.session_id:
        raise BookingError("Cette place n'est plus disponible")
    if aware(b.start) <= datetime.now(timezone.utc):
        raise BookingError("Cette séance a déjà commencé")
    if account_of(db, newcomer).id == account_of(db, db.get(Player, b.player_id)).id:
        raise BookingError("C'est votre propre réservation")
    s = db.get(TrainingSession, b.session_id)
    if newcomer.id in attendee_ids(s):
        raise BookingError("Vous êtes déjà inscrit à cette séance")
    others = [db.get(Player, i) for i in attendee_ids(s) if i != b.player_id]
    if others and not all(compatible(newcomer.category, newcomer.gender, o.category, o.gender) for o in others):
        raise BookingError("Votre niveau n'est pas compatible avec celui des autres joueurs de cette séance")
    nb = Booking(coach_id=b.coach_id, player_id=newcomer.id, kind=b.kind, start=b.start, duration_min=b.duration_min, status=b.status,
                 session_id=b.session_id, accepted_kinds=b.accepted_kinds, price_millimes=b.price_millimes, discount_pct=b.discount_pct, discount_millimes=b.discount_millimes,
                 charged_millimes=0, notified_at=b.notified_at)
    db.add(nb)
    db.flush()
    if b.charged_millimes:
        db.add(CreditTx(coach_id=b.coach_id, player_id=newcomer.id, amount_millimes=-b.charged_millimes, reason="reservation", booking_id=nb.id))
        nb.charged_millimes = b.charged_millimes
    for a in s.attendances:
        if a.player_id == b.player_id:
            a.player_id = newcomer.id  # même place, mêmes formules acceptées
            a.credit_paid_millimes = nb.charged_millimes
    _refund(db, b)
    b.status, b.replace_token = "remplacee", None
    leaving = db.get(Player, b.player_id)
    notify_coach(db, b.coach_id, f"{newcomer.name} remplace {leaving.name}",
                 f"{newcomer.name} ({newcomer.category}) a pris la place de {leaving.name} à cette séance :", _details(s))
    notify(db, [leaving], "Vous avez été remplacé", lambda p: letter(
        p.name, f"{newcomer.name} a pris votre place à cette séance :", _details(s),
        "Vos crédits vous ont été rendus." if b.charged_millimes else "", "Merci d'avoir trouvé un remplaçant !"))
    return nb


def complete_finished(db: Session, coach_id: int | None = None, now: datetime | None = None) -> int:
    """Une séance prévue dont l'heure de fin est passée devient « effectuée » toute seule (les crédits la paient):
    le coach n'a plus à la valider. Pas les séances sans joueur, ni celles dont le groupe n'a jamais été formé
    (réservations encore en attente de joueurs ou du coach)."""
    from . import finance
    now = now or datetime.now(timezone.utc)
    q = select(TrainingSession).where(TrainingSession.status == "prevue", TrainingSession.start < now)
    if coach_id:
        q = q.where(TrainingSession.coach_id == coach_id)
    done = 0
    for s in db.scalars(q):
        if aware(s.start) + timedelta(minutes=s.duration_min) > now or not s.attendances:
            continue
        if db.scalar(select(Booking.id).where(Booking.session_id == s.id, Booking.status.in_(("en_attente", "attente_joueurs"))).limit(1)):
            continue
        s.status = "effectuee"
        db.flush()
        finance.settle(db, s.coach_id, [a.player_id for a in s.attendances])
        done += 1
    if done:
        db.commit()
    return done


def coach_cancel_session(db: Session, s: TrainingSession, tell: bool = True) -> None:
    """Le coach annule une séance: toutes les réservations payées avec des crédits sont remboursées,
    les joueurs sont prévenus (pas pour une séance déjà passée, annulée après coup)."""
    coach = db.get(Coach, s.coach_id)
    if tell:
        notify(db, [db.get(Player, a.player_id) for a in s.attendances], "Séance de padel annulée", lambda p: letter(
            p.name, f"{coach.name} a dû annuler cette séance :", _details(s),
            "Si vous l'aviez payée avec vos crédits, ils vous ont été rendus. Vous pouvez réserver un autre créneau dans l'application.",
            sign=coach.name))
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
            out.append({"player_id": p.id, "name": p.name, "category": p.category, "gender": p.gender, "has_account": p.password_hash is not None or p.account_id is not None, "gap": round(gap, 1)})
    return sorted(out, key=lambda x: (x["gap"], not x["has_account"]))[:6]


# --- Autre horaire proposé par le coach (comme une réunion: accepter, refuser ou proposer un autre horaire) ---

def counter_propose(db: Session, coach: Coach, b: Booking, start: datetime, minutes: int) -> None:
    """Le coach veut bien entraîner ce joueur, mais pas à cette heure: il propose un autre horaire. Le joueur est
    prévenu (appli + e-mail) et accepte (la séance est alors acceptée d'office) ou refuse."""
    if b.status != "en_attente" or b.session_id:
        raise BookingError("Seule une demande de nouvelle séance pas encore traitée peut recevoir un autre horaire.")
    start = aware(start)
    if start <= datetime.now(timezone.utc):
        raise BookingError("Proposez un horaire à venir.")
    if not 30 <= minutes <= 240:
        raise BookingError("Durée invalide.")
    end = start + timedelta(minutes=minutes)
    clash = next((s for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status == "prevue"))
                  if aware(s.start) < end and start < aware(s.start) + timedelta(minutes=s.duration_min)), None)
    if clash:
        raise BookingError(f"Vous avez déjà une séance à ce moment-là ({quand(clash.start, clash.duration_min)}).")
    b.proposed_start, b.proposed_minutes, b.status = start, minutes, "contre_proposition"
    p = db.get(Player, b.player_id)
    notify(db, [p], f"{coach.name} vous propose un autre horaire", lambda x: letter(
        x.name, f"{coach.name} ne peut pas vous entraîner {quand(b.start, b.duration_min)}, mais vous propose :",
        [("Quand", quand(start, minutes)), ("Formule", KIND_FR.get(b.kind, ""))],
        "Acceptez ou refusez dans l'application (onglet Accueil ou notifications).", sign=coach.name),
        kind="contre_proposition", booking_id=b.id)


def answer_proposal(db: Session, b: Booking, yes: bool, sms: SmsProvider | None = None) -> None:
    """Réponse du joueur à l'autre horaire proposé: oui = la séance est acceptée à ce nouvel horaire (le coach l'a
    proposé), non = la demande est abandonnée (rien n'avait été débité)."""
    if b.status != "contre_proposition":
        raise BookingError("Cette proposition n'est plus d'actualité.")
    coach = db.get(Coach, b.coach_id)
    p = db.get(Player, b.player_id)
    old = quand(b.start, b.duration_min)
    if not yes:
        b.status = "annulee"
        notify_coach(db, coach.id, f"{p.name} décline l'horaire proposé", f"{p.name} ne peut pas {quand(b.proposed_start, b.proposed_minutes)} (demande initiale : {old}).")
        return
    b.start, b.duration_min, b.status = b.proposed_start, b.proposed_minutes, "en_attente"
    q = quote(db, coach, b.kind, b.start, b.duration_min, vip(db, coach, b.player_id))
    b.price_millimes, b.discount_pct, b.discount_millimes = q["price_millimes"], q["discount_pct"], q["discount_millimes"]
    opts = groups.parse_opts(b.accepted_opts)
    if opts:  # nouvelle durée: celle proposée par le coach
        b.accepted_opts = groups.dump_opts({(k, b.duration_min) for k, _ in opts if b.duration_min in coach_durations(coach, k)} or {(b.kind, b.duration_min)})
    accept(db, coach, b, sms)
    notify_coach(db, coach.id, f"{p.name} accepte l'horaire proposé", f"Séance acceptée {quand(b.start, b.duration_min)} (demande initiale : {old}).")
