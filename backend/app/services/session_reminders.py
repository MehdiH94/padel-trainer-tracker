"""Rappels automatiques de séance: 24 h avant puis 2 h avant, par le moyen choisi par le joueur."""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, Player, SessionReminder, TrainingSession
from ..notify import Notifier, channel_for, letter
from .common import TUNIS, aware
from .accounts import contact_email
from .courts import JOURS

log = logging.getLogger("rappels")

# (type de rappel, délai avant la séance). Une séance créée à moins de 2 h ne reçoit que le rappel « 2h ».
STEPS = [("2h", timedelta(hours=2)), ("24h", timedelta(hours=24))]


def reminder_text(coach: Coach, player: Player, s: TrainingSession, kind: str, now: datetime) -> str:
    from .booking import _details  # import local: booking importe beaucoup de services
    t = aware(s.start).astimezone(TUNIS)
    details = _details(s)
    if kind == "2h":
        return letter(player.name, "Votre séance de padel commence bientôt :", details, closing="À tout à l'heure,", sign=coach.name)
    day = "demain" if t.date() == (now.astimezone(TUNIS) + timedelta(days=1)).date() else "aujourd'hui" if t.date() == now.astimezone(TUNIS).date() else ""
    return letter(player.name, f"Petit rappel : vous avez une séance de padel {day or 'bientôt'}.", details,
                  "En cas d'empêchement, prévenez-moi au plus vite depuis l'application.", sign=coach.name)


def send_due(db: Session, notifier: Notifier, now: datetime | None = None) -> int:
    """Envoie les rappels arrivés à échéance (séances prévues dans les 24 h). Retourne le nombre envoyé."""
    now = now or datetime.now(timezone.utc)
    done = {(r.session_id, r.player_id, r.kind) for r in db.scalars(select(SessionReminder).where(SessionReminder.sent_at >= now - timedelta(days=2)))}
    q = select(TrainingSession).where(
        TrainingSession.status == "prevue", TrainingSession.start > now, TrainingSession.start <= now + timedelta(hours=24)
    )
    count = 0
    for s in db.scalars(q):
        left = aware(s.start) - now
        kind = next(k for k, delay in STEPS if left <= delay)  # rappel le plus proche de l'échéance
        coach = db.get(Coach, s.coach_id)
        for a in s.attendances:
            if (s.id, a.player_id, kind) in done:
                continue
            p = db.get(Player, a.player_id)
            channel = channel_for(p, contact_email(db, p))  # e-mail en version bêta
            body = reminder_text(coach, p, s, kind, now)
            try:
                notifier.send(p, channel, "Rappel de séance de padel", body, email=contact_email(db, p))
            except Exception:  # un envoi raté ne bloque pas les autres; on réessaiera au prochain passage
                log.exception("Rappel non envoyé au joueur %s", p.id)
                continue
            db.add(SessionReminder(coach_id=s.coach_id, session_id=s.id, player_id=p.id, kind=kind, channel=channel, message=body))
            count += 1
    db.commit()
    return count
