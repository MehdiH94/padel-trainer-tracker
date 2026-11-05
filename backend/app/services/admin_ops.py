"""Gestion par l'administrateur: suppression complète d'un joueur ou d'un coach (avec tout son historique).

Un joueur peut avoir une fiche chez plusieurs coachs, reliées à la fiche « compte » (celle qui a le mot de passe).
Si on supprime la fiche compte, une autre fiche reliée devient le compte (e-mail et mot de passe recopiés):
le joueur garde l'accès à ses autres coachs.
"""
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..models import (PlayerEvent, Attendance, Availability, TimeOff, Booking, Club, Coach, CourtBooking, CreditTx, Exercise, HappyHour, Payment,
                      Player, Promotion, Proposal, ReminderLog, SessionReminder, SkillRating, TrainingSession)

PLAYER_TABLES = (SkillRating, Attendance, Payment, CreditTx, Booking, ReminderLog, Proposal, SessionReminder)


def _hand_over_account(db: Session, p: Player) -> None:
    """La fiche compte disparaît: la plus ancienne fiche reliée devient le compte."""
    others = list(db.scalars(select(Player).where(Player.account_id == p.id).order_by(Player.id)))
    if not others:
        return
    heir = others[0]
    heir.account_id = None
    heir.email, heir.password_hash, heir.email_verified_at = p.email, p.password_hash, p.email_verified_at
    heir.signup_status, heir.contact_channel = p.signup_status, p.contact_channel or heir.contact_channel
    p.email = p.password_hash = None  # libère l'e-mail (unique) avant de le donner à la nouvelle fiche
    db.flush()
    for o in others[1:]:
        o.account_id = heir.id
    for e in db.scalars(select(PlayerEvent).where(PlayerEvent.account_id == p.id)):  # son planning (matchs, tournois) suit le compte
        e.account_id = heir.id


def _empty_sessions(db: Session, session_ids: set[int]) -> None:
    """Séances à venir restées sans joueur: annulées, leur terrain redevient libre."""
    for s in db.scalars(select(TrainingSession).where(TrainingSession.id.in_(session_ids))):
        if s.status == "prevue" and not s.attendances:
            s.status = "annulee"
            for cb in db.scalars(select(CourtBooking).where(CourtBooking.session_id == s.id)):
                if cb.status == "confirmee":
                    cb.session_id = None
                else:
                    cb.status = "annulee"


def delete_player(db: Session, p: Player) -> None:
    """Supprime cette fiche et tout ce qui la concerne (séances suivies, paiements, crédits, réservations…)."""
    sessions = set(db.scalars(select(Attendance.session_id).where(Attendance.player_id == p.id)))
    _hand_over_account(db, p)
    for table in PLAYER_TABLES:
        db.execute(delete(table).where(table.player_id == p.id))
    db.execute(delete(PlayerEvent).where(PlayerEvent.account_id == p.id))
    db.delete(p)
    db.flush()
    db.expire_all()
    _empty_sessions(db, sessions)


def delete_coach(db: Session, coach: Coach) -> None:
    """Supprime le coach, ses élèves (fiches chez lui), séances, terrains, clubs, paiements et réglages."""
    for p in list(db.scalars(select(Player).where(Player.coach_id == coach.id))):
        delete_player(db, p)
    sessions = [s.id for s in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id))]
    db.execute(update(PlayerEvent).where(PlayerEvent.coach_id == coach.id).values(coach_id=None, coach_feedback=""))
    for table in (Payment, CreditTx, Booking, ReminderLog, Proposal, SessionReminder):  # restes liés à ses séances
        db.execute(delete(table).where(table.coach_id == coach.id))
    db.execute(delete(Attendance).where(Attendance.session_id.in_(sessions)))
    for table in (Promotion, CourtBooking, HappyHour, Availability, TimeOff, Exercise, TrainingSession, Club):
        db.execute(delete(table).where(table.coach_id == coach.id))
    db.delete(coach)
    db.flush()
