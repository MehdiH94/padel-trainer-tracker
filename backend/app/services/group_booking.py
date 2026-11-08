"""Réservation en groupe montée par un joueur.

L'organisateur choisit un créneau et les formules (à deux, en groupe ou les deux, jamais seul), puis invite des joueurs
(liste des élèves du coach de niveau compatible, ou lien à partager). Les invités acceptent ou refusent. Tant que le
nombre minimum de joueurs n'est pas réuni (2 à deux, 3 en groupe), le coach ne voit rien; une fois atteint, toutes les
réservations du groupe deviennent des demandes « en_attente » et le coach est prévenu (« ces N joueurs veulent
s'entraîner ensemble »); il les accepte ensemble comme d'habitude (services/booking: même créneau = une seule séance).
Les invités qui acceptent ensuite rejoignent la demande, ou la séance si le coach l'a déjà acceptée.
"""
import secrets
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..constants import compatible
from ..models import Booking, Coach, Player
from ..notify import letter
from . import booking as svc
from . import courts, groups, isolation
from .accounts import has_account, linked, row_for_coach
from .common import aware, quand

FORMING, INVITED = "en_formation", "invitation"
GONE = ("annulee", "refusee", "remplacee")
GROUP_KINDS = ("duo", "groupe")


def create(db: Session, coach: Coach, row: Player, start: datetime, kinds: list[str], durations: dict | None) -> Booking:
    """L'organisateur ouvre sa réservation en groupe (pas encore visible du coach)."""
    kinds = [k for k in GROUP_KINDS if k in kinds]
    if not kinds:
        raise svc.BookingError("Une réservation en groupe se joue à deux ou en groupe : choisissez au moins une de ces formules.")
    b = svc.request_new(db, coach, row, kinds[0], start, accepted_kinds=kinds, durations=durations, forming=True)
    b.group_id, b.group_token = b.id, secrets.token_urlsafe(12)
    db.commit()
    return b


def by_token(db: Session, token: str) -> Booking | None:
    return db.scalar(select(Booking).where(Booking.group_token == token))


def members(db: Session, org: Booking, with_invited: bool = False) -> list[Booking]:
    rows = db.scalars(select(Booking).where(Booking.group_id == org.id).order_by(Booking.id)).all()
    return [b for b in rows if b.status not in GONE and (with_invited or b.status != INVITED)]


def min_size(org: Booking) -> int:
    return min(groups.SIZES[groups.smallest(groups.split(org.accepted_kinds))])


def max_size(org: Booking) -> int:
    return max(n for k in groups.split(org.accepted_kinds) for n in groups.SIZES[k])


def formed(org: Booking) -> bool:
    return org.status not in (FORMING, *GONE)


def _fits(db: Session, p: Player, org: Booking) -> bool:
    """Niveau compatible avec tous les joueurs déjà dans le groupe (même règle que les séances)."""
    others = [db.get(Player, b.player_id) for b in members(db, org) if b.player_id != p.id]
    return all(compatible(p.category, p.gender, o.category, o.gender) for o in others)


def invitable(db: Session, org: Booking) -> list[dict]:
    """Élèves du coach (avec un compte, du même monde) de niveau compatible, pas encore dans le groupe."""
    coach = db.get(Coach, org.coach_id)
    inside = {db.get(Player, b.player_id).account_id or b.player_id for b in members(db, org, with_invited=True)}
    out = []
    for p in db.scalars(select(Player).where(Player.coach_id == coach.id).order_by(Player.name)):
        key = p.account_id or p.id
        if key in inside or not has_account(p) or not isolation.same_world(db, coach, p) or not _fits(db, p, org):
            continue
        out.append({"id": p.id, "name": p.name, "category": p.category, "gender": p.gender})
    return out


def _copy(org: Booking, row: Player, status: str) -> Booking:
    return Booking(coach_id=org.coach_id, player_id=row.id, kind=org.kind, accepted_kinds=org.accepted_kinds, accepted_opts=org.accepted_opts,
                   start=org.start, duration_min=org.duration_min, status=status, charged_millimes=0, price_millimes=org.price_millimes,
                   discount_pct=org.discount_pct, discount_millimes=org.discount_millimes, group_id=org.id)


def invite(db: Session, org: Booking, player_ids: list[int], base_url: str = "") -> int:
    """Invitations: une notification (appli + e-mail) avec le lien du groupe."""
    allowed = {p["id"] for p in invitable(db, org)}
    host = db.get(Player, org.player_id)
    coach = db.get(Coach, org.coach_id)
    sent = 0
    for pid in player_ids:
        if pid not in allowed:
            continue
        p = db.get(Player, pid)
        b = _copy(org, p, INVITED)
        db.add(b)
        db.flush()
        link = f"{base_url}/#/groupe/{org.group_token}"
        svc.notify(db, [p], f"{host.name} vous invite à un entraînement", lambda x: letter(
            x.name, f"{host.name} organise un entraînement de padel {_what(org)} avec {coach.name} et vous invite à le rejoindre :",
            [("Quand", quand(org.start, org.duration_min)), ("Coach", coach.name)],
            f"Pour accepter ou refuser, ouvrez l'application : {link}", sign=host.name), "invitation_groupe", booking_id=b.id)
        sent += 1
    db.commit()
    return sent


def _what(org: Booking) -> str:
    ks = groups.split(org.accepted_kinds)
    return "à deux ou en groupe" if len(ks) == 2 else "à deux" if ks == ["duo"] else "en groupe"


def join(db: Session, account: Player, org: Booking, sms=None) -> Booking:
    """Un invité (ou quelqu'un qui a reçu le lien) rejoint le groupe."""
    coach = db.get(Coach, org.coach_id)
    if org.status in GONE or aware(org.start) <= datetime.now(timezone.utc):
        raise svc.BookingError("Cet entraînement n'est plus d'actualité.")
    if not isolation.same_world(db, coach, account):
        raise svc.BookingError("Invitation introuvable.")
    row = row_for_coach(db, account, coach)
    mine = next((b for b in members(db, org, with_invited=True) if b.player_id in {p.id for p in linked(db, account)}), None)
    if mine and mine.status != INVITED:
        raise svc.BookingError("Vous faites déjà partie de cet entraînement.")
    if len(members(db, org)) >= max_size(org):
        raise svc.BookingError("Cet entraînement est déjà complet.")
    if not _fits(db, row, org):
        raise svc.BookingError("Votre classement n'est pas compatible avec les joueurs de cet entraînement.")
    if formed(org) and org.session_id:  # le coach a déjà accepté: il rejoint la séance (le coach a validé le groupe)
        if mine:
            mine.status = "annulee"
        s = db.get(svc.TrainingSession, org.session_id)
        b = svc.request_join(db, coach, row, s, sms, force_accept=True, kinds=groups.split(org.accepted_kinds),
                             durations={k: [m for kk, m in groups.parse_opts(org.accepted_opts) if kk == k] for k in GROUP_KINDS})
        b.group_id = org.id
        db.commit()
        return b
    if not mine:
        mine = _copy(org, row, FORMING)
        db.add(mine)
    mine.status = "en_attente" if formed(org) else FORMING
    db.flush()
    _check(db, coach, org, sms)
    db.commit()
    return mine


def decline(db: Session, account: Player, org: Booking) -> None:
    ids = {p.id for p in linked(db, account)}
    for b in members(db, org, with_invited=True):
        if b.player_id in ids and b.status in (INVITED, FORMING):
            b.status = "refusee" if b.status == INVITED else "annulee"
    db.commit()


def cancel(db: Session, org: Booking) -> None:
    """L'organisateur renonce avant que le coach ait accepté: tout le groupe est annulé, les membres prévenus."""
    if formed(org) and org.status != "en_attente":
        raise svc.BookingError("Le coach a déjà accepté cet entraînement : annulez votre place depuis votre planning.")
    host = db.get(Player, org.player_id)
    others = [db.get(Player, b.player_id) for b in members(db, org, with_invited=True) if b.id != org.id]
    for b in members(db, org, with_invited=True):
        b.status = "annulee"
    if others:
        svc.notify(db, others, "Entraînement annulé", lambda x: letter(
            x.name, f"{host.name} a annulé l'entraînement prévu {quand(org.start, org.duration_min)}.", sign=host.name), "message")
    db.commit()


def _check(db: Session, coach: Coach, org: Booking, sms=None) -> None:
    """Minimum atteint: toutes les réservations du groupe passent au coach (demandes), qui est prévenu."""
    if formed(org):
        return
    ms = members(db, org)
    if len(ms) < min_size(org):
        return
    for b in ms:
        b.status = "en_attente"
    db.flush()
    names = [db.get(Player, b.player_id).name for b in ms]
    svc.notify_coach(db, coach.id, f"Réservation en groupe : {len(ms)} joueurs veulent s'entraîner ensemble",
                     f"{', '.join(names[:-1])} et {names[-1]} veulent s'entraîner ensemble {_what(org)} :",
                     [("Quand", quand(org.start, org.duration_min))], "Acceptez-les ensemble dans l'onglet Demandes de l'application.")
    held = courts.held_covering(db, coach, org.start, org.duration_min, merge=True) if coach.auto_confirm else []
    if held:  # validation automatique: une seule séance pour tout le groupe
        svc.accept(db, coach, org, sms, court=held[0])
        for b in ms[1:]:
            svc.accept(db, coach, b, sms)


def summary(db: Session, org: Booking, account: Player | None = None) -> dict:
    coach = db.get(Coach, org.coach_id)
    ids = {p.id for p in linked(db, account)} if account else set()
    mine = next((b for b in members(db, org, with_invited=True) if b.player_id in ids), None)
    return {
        "token": org.group_token, "booking_id": org.id, "start": org.start, "duration_min": org.duration_min, "coach_id": coach.id, "coach_name": coach.name,
        "kinds": groups.split(org.accepted_kinds), "host": db.get(Player, org.player_id).name, "is_host": org.player_id in ids,
        "members": [{"name": db.get(Player, b.player_id).name, "category": db.get(Player, b.player_id).category, "status": b.status}
                    for b in members(db, org, with_invited=True)],
        "count": len(members(db, org)), "min": min_size(org), "max": max_size(org), "formed": formed(org), "status": org.status,
        "my_status": mine.status if mine else None, "my_booking_id": mine.id if mine else None, "price_millimes": org.price_millimes,
        "past": aware(org.start) <= datetime.now(timezone.utc),
    }
