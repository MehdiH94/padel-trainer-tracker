"""Onglet Finance du coach: impayés, crédits d'avance, ce qu'il a gagné et encaissé sur une période,
journal des versements (qui lui a donné de l'argent, quel jour)."""
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, Payment, Player, TimeOff, TrainingSession
from ..services.common import TUNIS, aware
from ..services.finance import credit_balance, net_balance, share

router = APIRouter(prefix="/finance", tags=["finance"])


def session_value(s: TrainingSession) -> dict[int, int]:
    """Ce que rapporte une séance effectuée, par joueur: sa part, qu'elle soit payée en crédits ou non."""
    return {a.player_id: a.credit_paid_millimes or share(s, i) for i, a in enumerate(s.attendances)}


def balances(db: Session, coach: Coach) -> list[dict]:
    """Un seul solde par joueur chez ce coach: négatif = il doit, positif = crédits d'avance."""
    out = []
    for p in db.scalars(select(Player).where(Player.coach_id == coach.id).order_by(Player.name)):
        net = net_balance(db, p)
        if net:
            out.append({"player_id": p.id, "name": p.name, "phone": p.phone, "email": p.email, "category": p.category,
                        "gender": p.gender, "balance_millimes": net})
    return out


def _bucket(d: date, group: str) -> str:
    if group == "month":
        return d.strftime("%Y-%m")
    if group == "week":
        return (d - timedelta(days=d.weekday())).isoformat()
    return d.isoformat()


@router.get("")
def finance(start: date | None = None, end: date | None = None, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Période en jours de Tunis, bornes incluses (par défaut: le mois en cours)."""
    from ..services.booking import complete_finished
    complete_finished(db, coach.id)
    today = datetime.now(TUNIS).date()
    start = start or today.replace(day=1)
    end = end or today
    if end < start or (end - start).days > 800:
        raise HTTPException(422, "Période invalide.")
    lo = datetime.combine(start, time.min, TUNIS)
    hi = datetime.combine(end + timedelta(days=1), time.min, TUNIS)
    days = (end - start).days + 1
    group = "day" if days <= 31 else "week" if days <= 120 else "month"

    names = {p.id: p.name for p in db.scalars(select(Player).where(Player.coach_id == coach.id))}
    earned, hours, by_player = {}, {}, {}
    sessions = db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status == "effectuee",
                                                        TrainingSession.start >= lo, TrainingSession.start < hi)).all()
    for s in sessions:
        k = _bucket(aware(s.start).astimezone(TUNIS).date(), group)
        val = session_value(s)
        earned[k] = earned.get(k, 0) + sum(val.values())
        hours[k] = hours.get(k, 0) + s.duration_min / 60
        for pid, v in val.items():
            by_player[pid] = by_player.get(pid, 0) + v
    cashed, journal = {}, []
    for pay in db.scalars(select(Payment).where(Payment.coach_id == coach.id, Payment.paid_at >= lo, Payment.paid_at < hi).order_by(Payment.paid_at.desc())):
        k = _bucket(aware(pay.paid_at).astimezone(TUNIS).date(), group)
        cashed[k] = cashed.get(k, 0) + pay.amount_millimes
        journal.append({"id": pay.id, "player_id": pay.player_id, "name": names.get(pay.player_id, "?"), "amount_millimes": pay.amount_millimes,
                        "method": pay.method, "kind": pay.kind, "paid_at": pay.paid_at})
    # toutes les cases de la période, même vides, pour le graphe
    keys, d = [], start
    while d <= end:
        k = _bucket(d, group)
        if k not in keys:
            keys.append(k)
        d += timedelta(days=1)
    bal = balances(db, coach)
    return {
        "start": start, "end": end, "group": group,
        "earned_millimes": sum(earned.values()), "cashed_millimes": sum(cashed.values()),
        "hours": round(sum(hours.values()), 1), "sessions": len(sessions),
        "series": [{"key": k, "earned_millimes": earned.get(k, 0), "cashed_millimes": cashed.get(k, 0), "hours": round(hours.get(k, 0), 1)} for k in keys],
        "unpaid": sorted([b for b in bal if b["balance_millimes"] < 0], key=lambda b: b["balance_millimes"]),
        "unpaid_total_millimes": -sum(b["balance_millimes"] for b in bal if b["balance_millimes"] < 0),
        "credits": sorted([b for b in bal if b["balance_millimes"] > 0], key=lambda b: -b["balance_millimes"]),
        "credits_total_millimes": sum(b["balance_millimes"] for b in bal if b["balance_millimes"] > 0),
        "journal": journal,
        "top_players": sorted(({"player_id": pid, "name": names.get(pid, "?"), "earned_millimes": v} for pid, v in by_player.items()),
                              key=lambda x: -x["earned_millimes"])[:5],
    }
