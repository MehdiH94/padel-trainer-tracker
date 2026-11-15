from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, Payment, Player, TrainingSession
from ..schemas import PaymentIn, PaymentOut
from .players import get_owned_player

router = APIRouter(tags=["payments"])


@router.post("/payments", response_model=PaymentOut, status_code=201)
def create_payment(body: PaymentIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    get_owned_player(db, coach, body.player_id)
    if body.amount_millimes <= 0 or body.method not in ("especes", "virement"):
        raise HTTPException(422, "Montant invalide : indiquez un montant supérieur à 0, payé en espèces ou par virement.")
    if body.session_id is not None:
        s = db.get(TrainingSession, body.session_id)
        if not s or s.coach_id != coach.id or body.player_id not in [a.player_id for a in s.attendances]:
            raise HTTPException(404, "Ce joueur n'a pas participé à cette séance")
    if body.session_id is None:
        # Paiement sans séance précise: il règle d'abord les séances effectuées encore dues; le reste (ex. une dette
        # de crédits laissée par une recharge qui a payé une séance entière) devient des crédits, qui comblent le solde
        # négatif. Ainsi « Payé » ne dépasse jamais « Facturé » et le joueur qui a tout versé est à jour.
        from ..models import CreditTx
        from ..services.finance import settle, unpaid_sessions
        player = db.get(Player, body.player_id)
        due = unpaid_sessions(db, player)
        excess = body.amount_millimes - due
        if excess > 0:
            first = None
            if due > 0:
                first = Payment(coach_id=coach.id, player_id=player.id, amount_millimes=due, method=body.method, kind="seance")
                db.add(first)
            extra = Payment(coach_id=coach.id, player_id=player.id, amount_millimes=excess, method=body.method, kind="credit")
            db.add(extra)
            db.add(CreditTx(coach_id=coach.id, player_id=player.id, amount_millimes=excess, reason="recharge"))
            db.flush()
            settle(db, coach.id, [player.id])
            db.commit()
            return first or extra
    if body.session_id is not None:
        # Paiement pour une séance: au plus ce qui reste dû pour elle; le surplus devient des crédits (jamais perdu:
        # un seul solde par coach, qui monte quand le joueur paie)
        from ..models import CreditTx
        from ..services.finance import session_payments, settle, share
        s = db.get(TrainingSession, body.session_id)
        i = [a.player_id for a in s.attendances].index(body.player_id)
        due = max(share(s, i) - session_payments(db, coach.id).get((s.id, body.player_id), 0), 0) if s.status == "effectuee" else 0
        excess = body.amount_millimes - due
        if excess > 0:
            first = None
            if due > 0:
                first = Payment(coach_id=coach.id, player_id=body.player_id, amount_millimes=due, method=body.method, kind="seance", session_id=s.id)
                db.add(first)
            extra = Payment(coach_id=coach.id, player_id=body.player_id, amount_millimes=excess, method=body.method, kind="credit")
            db.add(extra)
            db.add(CreditTx(coach_id=coach.id, player_id=body.player_id, amount_millimes=excess, reason="recharge"))
            db.flush()
            settle(db, coach.id, [body.player_id])
            db.commit()
            return first or extra
    p = Payment(coach_id=coach.id, **body.model_dump(exclude_none=True))
    db.add(p)
    db.commit()
    return p


@router.get("/payments", response_model=list[PaymentOut])
def list_payments(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    return db.scalars(select(Payment).where(Payment.coach_id == coach.id).order_by(Payment.paid_at.desc())).all()
