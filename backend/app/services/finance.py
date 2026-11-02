from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import CreditTx, Payment, TrainingSession


def share(s: TrainingSession, index: int) -> int:
    """Part due par le joueur n°index (0-based) d'une séance, en millimes."""
    if s.attendances[index].credit_paid_millimes > 0:  # déjà payé avec les crédits
        return 0
    if s.price_mode == "groupe":
        n = len(s.attendances) or 1
        # prix total partagé; le reste de la division va aux premiers joueurs
        return s.price_millimes // n + (1 if index < s.price_millimes % n else 0)
    return s.price_millimes


def billed_by_player(sessions: list[TrainingSession]) -> dict[int, int]:
    """Montant facturé par joueur (séances effectuées, hors séances prépayées)."""
    out: dict[int, int] = {}
    for s in sessions:
        if s.status != "effectuee":
            continue
        for i, a in enumerate(s.attendances):
            out[a.player_id] = out.get(a.player_id, 0) + share(s, i)
    return out


def paid_by_player(db: Session, coach_id: int) -> dict[int, int]:
    """Paiements de séances. Les recharges de crédits sont exclues: elles servent aux réservations."""
    out: dict[int, int] = {}
    for p in db.scalars(select(Payment).where(Payment.coach_id == coach_id, Payment.kind == "seance")):
        out[p.player_id] = out.get(p.player_id, 0) + p.amount_millimes
    return out


def credit_balance(db: Session, player_id: int) -> int:
    return db.scalar(select(func.coalesce(func.sum(CreditTx.amount_millimes), 0)).where(CreditTx.player_id == player_id))


def debts(db: Session, coach_id: int) -> dict[int, int]:
    """Soldes de crédits négatifs (séances validées au-delà de ce qui a été prépayé): ce que le joueur doit au coach.
    Ces séances sont marquées payées en crédits, elles ne comptent donc pas aussi dans billed_by_player."""
    rows = db.execute(select(CreditTx.player_id, func.sum(CreditTx.amount_millimes)).where(CreditTx.coach_id == coach_id).group_by(CreditTx.player_id))
    return {pid: -total for pid, total in rows if total < 0}


def amounts_due(db: Session, coach_id: int, sessions: list[TrainingSession]) -> dict[int, int]:
    """Total dû par joueur: séances facturées non réglées + solde de crédits négatif."""
    billed, paid = billed_by_player(sessions), paid_by_player(db, coach_id)
    out = {pid: amt - paid.get(pid, 0) for pid, amt in billed.items() if amt - paid.get(pid, 0) > 0}
    for pid, debt in debts(db, coach_id).items():
        out[pid] = out.get(pid, 0) + debt
    return out


def player_due(db: Session, p) -> int:
    """Ce que ce joueur (fiche chez un coach) doit à ce coach: séances effectuées non réglées + crédits négatifs."""
    from ..models import Attendance
    sessions = db.scalars(select(TrainingSession).join(Attendance).where(
        TrainingSession.coach_id == p.coach_id, TrainingSession.status == "effectuee", Attendance.player_id == p.id)).unique().all()
    billed = billed_by_player(list(sessions)).get(p.id, 0)
    paid = db.scalar(select(func.coalesce(func.sum(Payment.amount_millimes), 0)).where(
        Payment.coach_id == p.coach_id, Payment.player_id == p.id, Payment.kind == "seance"))
    return max(billed - paid, 0) + max(-credit_balance(db, p.id), 0)
