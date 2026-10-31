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
