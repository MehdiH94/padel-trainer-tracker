from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, Payment, Player, TrainingSession
from ..services.common import TUNIS, aware
from ..services.finance import amounts_due, debts

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("")
def dashboard(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    from ..services.booking import complete_finished
    complete_finished(db, coach.id)  # séances terminées: effectuées automatiquement
    now = datetime.now(TUNIS)
    week = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    year = month.replace(month=1)

    sessions = db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id)).all()
    done = [s for s in sessions if s.status == "effectuee"]
    upcoming = [s for s in sessions if s.status == "prevue" and aware(s.start) >= now]

    def hours(since: datetime) -> float:
        return round(sum(s.duration_min for s in done if aware(s.start) >= since) / 60, 2)

    payments = db.scalars(select(Payment).where(Payment.coach_id == coach.id)).all()

    def revenue(since: datetime) -> int:
        return sum(p.amount_millimes for p in payments if aware(p.paid_at) >= since)

    names = {p.id: p.name for p in db.scalars(select(Player).where(Player.coach_id == coach.id))}
    debt = debts(db, coach.id)
    unpaid = [  # séances non réglées + soldes de crédits négatifs (DP-001)
        {"player_id": pid, "name": names.get(pid, "?"), "amount_millimes": amt, "negative_balance_millimes": debt.get(pid, 0)}
        for pid, amt in amounts_due(db, coach.id, sessions).items()
    ]

    return {
        "upcoming_count": len(upcoming),
        "done_count": len(done),
        "hours": {"week": hours(week), "month": hours(month), "year": hours(year)},
        "revenue_millimes": {"month": revenue(month), "year": revenue(year)},
        "unpaid": sorted(unpaid, key=lambda u: -u["amount_millimes"]),
    }
