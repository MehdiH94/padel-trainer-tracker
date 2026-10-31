from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Attendance, Coach, Payment, Player, SkillRating, TrainingSession
from ..services.common import aware
from ..services.finance import credit_balance, share
from .players import get_owned_player, player_out

router = APIRouter(tags=["profile"])

STROKES = ["Service", "Retour de service", "Volée", "Bandeja", "Víbora", "Sortie de vitre", "Smash", "Lob", "Défense fond de court"]


class SkillIn(BaseModel):
    stroke: str
    score: int


class FeedbackIn(BaseModel):
    worked_on: list[str] = []
    note: str = ""
    to_improve: str = ""


def tags(a: Attendance) -> list[str]:
    return [t for t in a.worked_on.split(",") if t]


@router.get("/strokes")
def strokes():
    return STROKES


@router.post("/players/{player_id}/skills", status_code=201)
def rate_skill(player_id: int, body: SkillIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    get_owned_player(db, coach, player_id)
    if body.stroke not in STROKES or not 1 <= body.score <= 5:
        raise HTTPException(422, "Coup ou note invalide")
    db.add(SkillRating(player_id=player_id, stroke=body.stroke, score=body.score))
    db.commit()
    return {"ok": True}


@router.put("/sessions/{session_id}/feedback/{player_id}")
def set_feedback(session_id: int, player_id: int, body: FeedbackIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    s = db.get(TrainingSession, session_id)
    if not s or s.coach_id != coach.id:
        raise HTTPException(404, "Séance introuvable")
    a = db.scalar(select(Attendance).where(Attendance.session_id == session_id, Attendance.player_id == player_id))
    if not a:
        raise HTTPException(404, "Ce joueur n'est pas dans cette séance")
    a.worked_on = ",".join(t.replace(",", " ").strip() for t in body.worked_on if t.strip())
    a.note, a.to_improve = body.note.strip(), body.to_improve.strip()
    db.commit()
    return {"ok": True}


@router.get("/sessions/{session_id}/feedback")
def session_feedback(session_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Retours du coach pour chaque joueur d'une séance."""
    s = db.get(TrainingSession, session_id)
    if not s or s.coach_id != coach.id:
        raise HTTPException(404, "Séance introuvable")
    return [
        {"player_id": a.player_id, "name": db.get(Player, a.player_id).name, "session_id": s.id,
         "worked_on": tags(a), "note": a.note, "to_improve": a.to_improve}
        for a in s.attendances
    ]


def build_profile(db: Session, coach_id: int, player: Player) -> dict:
    rows = db.execute(
        select(TrainingSession, Attendance)
        .join(Attendance, Attendance.session_id == TrainingSession.id)
        .where(Attendance.player_id == player.id, TrainingSession.coach_id == coach_id)
        .order_by(TrainingSession.start.desc())
    ).all()

    history, billed = [], 0
    for s, a in rows:
        idx = [x.player_id for x in s.attendances].index(player.id)
        amount = share(s, idx)
        if s.status == "effectuee":
            billed += amount
        history.append({
            "session_id": s.id, "start": s.start, "kind": s.kind, "club": s.club, "status": s.status,
            "duration_min": s.duration_min, "share_millimes": amount, "prepaid": a.credit_paid_millimes > 0,
            "worked_on": tags(a), "note": a.note, "to_improve": a.to_improve,
        })

    now = datetime.now(timezone.utc)
    upcoming = sorted([h for h in history if h["status"] == "prevue" and aware(h["start"]) >= now], key=lambda h: h["start"])
    done = [h for h in history if h["status"] == "effectuee"]

    pays = db.scalars(select(Payment).where(Payment.player_id == player.id).order_by(Payment.paid_at.desc())).all()
    paid = sum(p.amount_millimes for p in pays if p.kind == "seance")  # les recharges servent aux réservations

    ratings = db.scalars(select(SkillRating).where(SkillRating.player_id == player.id).order_by(SkillRating.rated_at, SkillRating.id)).all()
    by_stroke: dict[str, list[int]] = {}
    for r in ratings:
        by_stroke.setdefault(r.stroke, []).append(r.score)
    skills = [
        {"stroke": st, "score": by_stroke[st][-1] if st in by_stroke else None,
         "previous": by_stroke[st][-2] if st in by_stroke and len(by_stroke[st]) > 1 else None}
        for st in STROKES
    ]
    rated = [s for s in skills if s["score"] is not None]
    strengths = [s["stroke"] for s in sorted(rated, key=lambda s: -s["score"]) if s["score"] >= 4][:3]
    weaknesses = [s["stroke"] for s in sorted(rated, key=lambda s: s["score"]) if s["score"] <= 2][:3]

    last = next((h for h in done if h["worked_on"] or h["note"] or h["to_improve"]), None)
    return {
        "finance": {
            "billed_millimes": billed, "paid_millimes": paid, "due_millimes": max(billed - paid, 0),
            "credit_millimes": max(paid - billed, 0), "credits_balance_millimes": credit_balance(db, player.id),
            "payments": [{"id": p.id, "amount_millimes": p.amount_millimes, "method": p.method, "kind": p.kind, "paid_at": p.paid_at} for p in pays[:20]],
        },
        "stats": {
            "done_count": len(done), "hours": round(sum(h["duration_min"] for h in done) / 60, 1),
            "cancelled_count": sum(1 for h in history if h["status"] == "annulee"),
            "upcoming_count": len(upcoming), "since": done[-1]["start"] if done else None,
        },
        "skills": skills, "strengths": strengths, "weaknesses": weaknesses,
        "last_session": last, "upcoming": upcoming[:3], "history": history[:30],
    }


@router.get("/players/{player_id}/profile")
def profile(player_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    player = get_owned_player(db, coach, player_id)
    return {"player": player_out(player, credit_balance(db, player.id))} | build_profile(db, coach.id, player)
