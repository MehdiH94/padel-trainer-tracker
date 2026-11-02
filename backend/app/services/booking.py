"""Réservations des joueurs payées avec leurs crédits: créneaux libres, suggestions de groupes, demandes."""
from datetime import datetime, time, timedelta, timezone
from math import gcd

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..constants import CAPACITY, category_index, compatible
from ..models import Attendance, Availability, Booking, Club, Coach, CourtBooking, CreditTx, Player, Proposal, TrainingSession
from ..sms.base import SmsProvider
from . import courts
from . import groups
from .common import TUNIS, aware
from .finance import credit_balance
from .pricing import duration_for, quote

HORIZON_DAYS = 14
MIN_NOTICE_H = 2
# attente_joueurs: acceptée par le coach, mais la séance n'a pas encore le nombre minimum de joueurs voulu
ACTIVE = ("en_attente", "attente_joueurs", "acceptee", "confirmee")


class BookingError(Exception):
    pass


def price_for(coach: Coach, kind: str) -> int:
    return {"individuel": coach.price_individuel, "duo": coach.price_duo, "groupe": coach.price_groupe}[kind]


def attendee_ids(s: TrainingSession) -> list[int]:
    return [a.player_id for a in s.attendances]


def pending_bookings(db: Session, s: TrainingSession) -> list[Booking]:
    return list(db.scalars(select(Booking).where(Booking.session_id == s.id, Booking.status == "en_attente")))


def pending_joins(db: Session, s: TrainingSession) -> int:
    return len(pending_bookings(db, s))


def pending_kinds(db: Session, s: TrainingSession) -> list[list[str]]:
    return [groups.split(b.accepted_kinds) for b in pending_bookings(db, s)]


def spots_left(db: Session, s: TrainingSession) -> int:
    """Places restantes: la plus grande taille qui convient à tous (groups.capacity), moins les inscrits et demandes."""
    return groups.capacity(s, pending_kinds(db, s)) - len(s.attendances) - pending_joins(db, s)


def join_target(db: Session, s: TrainingSession, kinds: list[str] | None) -> int | None:
    """Taille visée si un joueur qui accepte ces formules rejoint la séance (None = pas possible)."""
    return groups.join_target(s, kinds, len(s.attendances) + pending_joins(db, s), pending_kinds(db, s))


def join_price(coach: Coach, s: TrainingSession, target: int) -> int:
    """Séance formée par les joueurs: prix de la formule visée; séance du coach: son prix."""
    if groups.is_dynamic(s):
        return price_for(coach, groups.kind_for_size(target))
    return s.price_millimes or price_for(coach, s.kind)


# --- Créneaux libres ----------------------------------------------------

def _busy(db: Session, coach: Coach) -> list[tuple[datetime, datetime]]:
    busy = [(aware(s.start), aware(s.start) + timedelta(minutes=s.duration_min))
            for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status != "annulee"))]
    # demandes de nouvelle séance pas encore traitées: le créneau est retenu
    busy += [(aware(b.start), aware(b.start) + timedelta(minutes=b.duration_min))
             for b in db.scalars(select(Booking).where(Booking.coach_id == coach.id, Booking.status == "en_attente", Booking.session_id.is_(None)))]
    return busy


def _free_on_courts(db: Session, coach: Coach, now: datetime, earliest: datetime, minutes: int | None) -> list[datetime]:
    """Mode « terrains »: créneaux qui tiennent entièrement dans un terrain réservé encore libre (et le coach libre)."""
    busy = _busy(db, coach)
    step = timedelta(minutes=gcd(*[duration_for(coach, k) for k in CAPACITY]))
    length = timedelta(minutes=minutes or coach.slot_minutes)
    horizon = now + timedelta(days=HORIZON_DAYS + 1)
    out = set()
    for cb in db.scalars(select(CourtBooking).where(CourtBooking.coach_id == coach.id, CourtBooking.session_id.is_(None),
                                                   CourtBooking.status == "confirmee", CourtBooking.start.is_not(None))):
        cur, end = aware(cb.start), aware(cb.start) + timedelta(minutes=cb.duration_min)
        while cur + length <= end and cur < horizon:
            if cur >= earliest and not any(cur < b_end and cur + length > b_start for b_start, b_end in busy):
                out.add(cur)
            cur += step
    return sorted(out)


def free_slots(db: Session, coach: Coach, now: datetime | None = None, minutes: int | None = None) -> list[datetime]:
    """Créneaux libres (UTC), triés, sur les HORIZON_DAYS prochains jours, pour une séance de `minutes` (défaut: individuelle).
    Les débuts possibles suivent une grille commune à toutes les formules (ex. 60 et 90 min -> toutes les 30 min)."""
    now = now or datetime.now(timezone.utc)
    earliest = now + timedelta(hours=MIN_NOTICE_H)
    windows = db.scalars(select(Availability).where(Availability.coach_id == coach.id)).all()
    if coach.booking_mode != "disponibilites":
        return _free_on_courts(db, coach, now, earliest, minutes)

    busy: list[tuple[datetime, datetime]] = []
    for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status != "annulee")):
        busy.append((aware(s.start), aware(s.start) + timedelta(minutes=s.duration_min)))
    # demandes de nouvelle séance pas encore traitées: le créneau est retenu
    for b in db.scalars(select(Booking).where(Booking.coach_id == coach.id, Booking.status == "en_attente", Booking.session_id.is_(None))):
        busy.append((aware(b.start), aware(b.start) + timedelta(minutes=b.duration_min)))

    durations = [duration_for(coach, k) for k in CAPACITY]
    step = timedelta(minutes=gcd(*durations))
    length = timedelta(minutes=minutes or coach.slot_minutes)
    out = []
    today = now.astimezone(TUNIS).date()
    for off in range(HORIZON_DAYS + 1):
        day = today + timedelta(days=off)
        for w in (w for w in windows if w.weekday == day.weekday()):
            cur = datetime.combine(day, time.fromisoformat(w.start_time), TUNIS).astimezone(timezone.utc)
            end = datetime.combine(day, time.fromisoformat(w.end_time), TUNIS).astimezone(timezone.utc)
            while cur + length <= end:
                if cur >= earliest and not any(cur < b_end and cur + length > b_start for b_start, b_end in busy):
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
        if join_target(db, s, kinds) is None:  # la taille de la séance avec lui doit convenir à tous (formules choisies)
            continue
        kind_penalty = 0
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
                 kinds: list[str] | None = None) -> Booking:
    """Le joueur demande une place dans une séance existante (kinds: formules qu'il a choisies, s'il les a précisées).
    La taille de la séance après son arrivée doit convenir à tous (voir services/groups)."""
    if not s.open or s.status != "prevue" or aware(s.start) < datetime.now(timezone.utc):
        raise BookingError("Cette séance n'est plus disponible")
    if player.id in attendee_ids(s) or db.scalar(select(Booking).where(Booking.session_id == s.id, Booking.player_id == player.id, Booking.status.in_(ACTIVE))):
        raise BookingError("Vous êtes déjà inscrit à cette séance")
    if spots_left(db, s) <= 0:
        raise BookingError("Cette séance est complète")
    target = join_target(db, s, kinds)
    if target is None:
        raise BookingError("Cette séance ne correspond pas aux formules que vous avez choisies")
    if not force_accept and not fits_session(db, player, s)[0]:
        raise BookingError("Votre classement n'est pas compatible avec les joueurs de cette séance")
    price = join_price(coach, s, target)
    b = Booking(coach_id=coach.id, player_id=player.id, kind=groups.kind_for_size(target) if groups.is_dynamic(s) or kinds else s.kind,
                start=s.start, duration_min=s.duration_min, session_id=s.id, charged_millimes=0,
                price_millimes=price, accepted_kinds=",".join(k for k in groups.ORDER if k in (kinds or [])))
    db.add(b)
    db.flush()
    if force_accept or coach.auto_confirm:
        accept(db, coach, b, sms)
    db.commit()
    return b


def request_new(db: Session, coach: Coach, player: Player, kind: str, start: datetime, sms: SmsProvider | None = None,
                accepted_kinds: list[str] | None = None) -> Booking:
    """Le joueur demande un nouveau créneau (séance de ce type, ouverte aux autres joueurs si duo/groupe).
    accepted_kinds: toutes les formules qu'il accepte (seul, duo, groupe), montrées au coach."""
    if kind not in CAPACITY:
        raise BookingError("Type de séance invalide")
    accepted = [k for k in groups.ORDER if k in (accepted_kinds or []) or k == kind]
    kind = groups.smallest(accepted)  # s'il reste seul (ou au minimum voulu), c'est cette formule qui est jouée
    if not groups.can_open(kind, start):
        raise BookingError("Pour ouvrir une séance à deux ou en groupe, elle doit avoir lieu dans plus de 24 h (le temps de compléter le groupe)")
    q = quote(db, coach, kind, start)  # durée de la formule, prix avec happy hour / promotion
    if aware(start) not in free_slots(db, coach, minutes=q["duration_min"]):
        raise BookingError("Ce créneau n'est plus disponible")
    price = q["price_millimes"]
    b = Booking(coach_id=coach.id, player_id=player.id, kind=kind, start=aware(start), duration_min=q["duration_min"], charged_millimes=0,
                accepted_kinds=",".join(accepted), price_millimes=price, discount_pct=q["discount_pct"])
    db.add(b)
    db.flush()
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
        kinds = groups.split(b.accepted_kinds)
        n = len(s.attendances)
        if n + 1 > groups.capacity(s) or (kinds and not any(x >= n + 1 for x in groups.allowed(s) & groups.sizes(kinds))):
            raise BookingError("Cette séance est complète")
        _debit(db, b)
        # formules retenues: celles qui permettent sa taille actuelle ou plus
        mine = [k for k in kinds if max(groups.SIZES[k]) >= n + 1]
        s.attendances.append(Attendance(player_id=player.id, credit_paid_millimes=b.charged_millimes, accepted_kinds=",".join(mine)))
        b.status = "acceptee"
        refresh(db, s)
        return
    if not b.price_millimes:
        b.price_millimes = price_for(coach, b.kind)
    _debit(db, b)
    s = TrainingSession(
        coach_id=coach.id, start=b.start, duration_min=b.duration_min, kind=b.kind, level=player.category,
        price_millimes=b.price_millimes or b.charged_millimes or price_for(coach, b.kind), price_mode="par_joueur", open=b.kind != "individuel",
    )
    # toutes les formules cochées: la plus petite = taille minimale voulue, les autres restent possibles
    mine = groups.split(b.accepted_kinds) or [b.kind]
    s.attendances = [Attendance(player_id=player.id, credit_paid_millimes=b.charged_millimes, accepted_kinds=",".join(mine))]
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


def _when(s: TrainingSession) -> str:
    t = aware(s.start).astimezone(TUNIS)
    return f"{courts.JOURS[t.weekday()]} {t:%d/%m} à {t:%H}h{t:%M}" + (f" ({s.club})" if s.club else "")


def notify(db: Session, players: list[Player], subject: str, body_for) -> int:
    """Message à des joueurs, par le moyen qu'ils ont choisi (voir app/notify.py)."""
    from ..notify import Notifier  # import local: notify importe les modèles
    from ..sms import get_sms_provider
    from .accounts import contact_email
    notifier, sent = Notifier(get_sms_provider()), 0
    for p in players:
        channel = p.contact_channel or "sms"
        if channel == "email" and not contact_email(db, p):
            channel = "sms"
        try:
            notifier.send(p, channel, subject, body_for(p), email=contact_email(db, p))
            sent += 1
        except Exception:  # un envoi raté ne bloque pas les autres
            continue
    return sent


def refresh(db: Session, s: TrainingSession) -> None:
    """Après une arrivée ou un départ: libellé, ouverture et état des réservations de la séance.
    - pas assez de joueurs pour tous: « attente_joueurs »
    - assez de joueurs: « acceptee » (terrain à confirmer) ou « confirmee »; les joueurs qui attendaient sont prévenus."""
    db.flush()
    if groups.is_dynamic(s):
        s.kind = groups.kind_for_size(max(len(s.attendances), groups.min_needed(s)))
        s.open = groups.capacity(s) > len(s.attendances)
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
    if newly:
        others = len(s.attendances) - 1
        notify(db, [db.get(Player, b.player_id) for b in newly], "Votre séance de padel est confirmée", lambda p: (
            f"Bonne nouvelle {p.name.split()[0]} ! {others} joueur{'s ont' if others > 1 else ' a'} rejoint votre séance de padel du {_when(s)} : "
            f"elle est confirmée{'' if state in (None, 'confirmee') else ' (terrain en cours de réservation)'}. — {coach.name}"))


def _reprice(db: Session, coach: Coach, s: TrainingSession, b: Booking) -> None:
    """Prix de la formule réellement jouée (taille de la séance), avec la remise obtenue à la réservation.
    Déjà débité: la différence est rendue ou débitée (« ajustement »)."""
    price = round(price_for(coach, s.kind) * (100 - (b.discount_pct or 0)) / 100)
    b.kind = s.kind
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
        old = a.accepted_kinds
        a.accepted_kinds = ",".join(mine)
        if len(s.attendances) > groups.capacity(s):
            a.accepted_kinds = old
            raise BookingError("Cette formule n'est pas compatible avec les autres joueurs de la séance")
    b.accepted_kinds = ",".join(mine)
    if s and b.status != "en_attente":
        refresh(db, s)
    else:  # pas encore validée par le coach: formule de départ et prix mis à jour
        b.kind = groups.smallest(mine)
        b.price_millimes = round(price_for(coach, b.kind) * (100 - (b.discount_pct or 0)) / 100)


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
        body = (f"Bonjour {p.name.split()[0]}, votre séance de padel du {_when(s)} n'a pas encore assez de joueurs "
                f"({len(s.attendances)}/{groups.min_needed(s)}). Ouvrez l'appli pour changer de formule (par exemple passer en solo) "
                f"ou annuler votre demande (remboursée). — {coach.name}")
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
    b.status = "annulee"
    if not was_pending:
        _release(db, b)
    _refund(db, b)
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
                 session_id=b.session_id, accepted_kinds=b.accepted_kinds, price_millimes=b.price_millimes, discount_pct=b.discount_pct,
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
    notify(db, [leaving], "Vous avez été remplacé", lambda p: f"Bonjour {p.name.split()[0]}, {newcomer.name} a pris votre place à la séance du {_when(s)}. "
           f"{'Vos crédits vous ont été rendus.' if b.charged_millimes else ''}".strip())
    return nb


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
            out.append({"player_id": p.id, "name": p.name, "category": p.category, "gender": p.gender, "has_account": p.password_hash is not None or p.account_id is not None, "gap": round(gap, 1)})
    return sorted(out, key=lambda x: (x["gap"], not x["has_account"]))[:6]
