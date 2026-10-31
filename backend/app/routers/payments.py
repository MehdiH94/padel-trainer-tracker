from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, Payment
from ..schemas import PaymentIn, PaymentOut
from .players import get_owned_player

router = APIRouter(tags=["payments"])


@router.post("/payments", response_model=PaymentOut, status_code=201)
def create_payment(body: PaymentIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    get_owned_player(db, coach, body.player_id)
    if body.amount_millimes <= 0 or body.method not in ("especes", "virement"):
        raise HTTPException(422, "Paiement invalide")
    p = Payment(coach_id=coach.id, **body.model_dump(exclude_none=True))
    db.add(p)
    db.commit()
    return p


@router.get("/payments", response_model=list[PaymentOut])
def list_payments(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    return db.scalars(select(Payment).where(Payment.coach_id == coach.id).order_by(Payment.paid_at.desc())).all()
