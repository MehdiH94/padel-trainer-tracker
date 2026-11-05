"""Planning padel du joueur: ses matchs amicaux et tournois (en plus des entraînements réservés),
résultat et auto-évaluation après coup, coach présent; le coach concerné ajoute son retour."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach, current_player
from ..db import get_db
from ..models import Coach, Player, PlayerEvent
from ..services.accounts import account_of, linked
from ..services.common import aware

router = APIRouter(tags=["planning joueur"])
KINDS = ("match", "tournoi")


def out(db: Session, e: PlayerEvent) -> dict:
    coach = db.get(Coach, e.coach_id) if e.coach_id else None
    return {"id": e.id, "kind": e.kind, "title": e.title, "start": e.start, "duration_min": e.duration_min, "place": e.place,
            "result": e.result, "score": e.score, "rating": e.rating / 10 if e.rating is not None else None, "comment": e.comment,
            "coach_id": e.coach_id, "coach_name": coach.name if coach else "", "coach_feedback": e.coach_feedback,
            "feedback_at": e.feedback_at, "player_name": db.get(Player, e.account_id).name}


class EventIn(BaseModel):
    kind: str = "match"
    title: str = ""
    start: datetime
    duration_min: int = 90
    place: str = ""
    result: str = ""
    score: str = ""
    rating: float | None = None  # 0 à 10
    comment: str = ""
    coach_id: int | None = None  # coaché par ce coach (un de ses coachs)


def _check(db: Session, player: Player, body: EventIn) -> None:
    if body.kind not in KINDS or body.result not in ("", "victoire", "defaite"):
        raise HTTPException(422, "Type ou résultat invalide.")
    if not 15 <= body.duration_min <= 720:
        raise HTTPException(422, "Durée invalide.")
    if body.rating is not None and not 0 <= body.rating <= 10:
        raise HTTPException(422, "Note de 0 à 10.")
    if body.coach_id and body.coach_id not in {p.coach_id for p in linked(db, player)}:
        raise HTTPException(422, "Choisissez un de vos coachs.")


def _fill(e: PlayerEvent, body: EventIn) -> None:
    e.kind, e.title, e.duration_min, e.place = body.kind, body.title.strip()[:120], body.duration_min, body.place.strip()[:120]
    e.start = body.start if body.start.tzinfo else body.start.replace(tzinfo=timezone.utc)
    e.result, e.score, e.comment = body.result, body.score.strip()[:60], body.comment.strip()[:2000]
    e.rating = round(body.rating * 10) if body.rating is not None else None
    e.coach_id = body.coach_id or None


@router.get("/me/events")
def my_events(player: Player = Depends(current_player), db: Session = Depends(get_db)):
    return [out(db, e) for e in db.scalars(select(PlayerEvent).where(PlayerEvent.account_id == player.id).order_by(PlayerEvent.start))]


@router.post("/me/events", status_code=201)
def add_event(body: EventIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    _check(db, player, body)
    e = PlayerEvent(account_id=player.id)
    _fill(e, body)
    db.add(e)
    db.commit()
    return out(db, e)


def _own(db: Session, player: Player, event_id: int) -> PlayerEvent:
    e = db.get(PlayerEvent, event_id)
    if not e or e.account_id != player.id:
        raise HTTPException(404, "Événement introuvable")
    return e


@router.put("/me/events/{event_id}")
def edit_event(event_id: int, body: EventIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    e = _own(db, player, event_id)
    _check(db, player, body)
    if e.coach_id and e.coach_id != body.coach_id:
        e.coach_feedback, e.feedback_at = "", None  # autre coach: l'ancien retour ne le concerne plus
    _fill(e, body)
    db.commit()
    return out(db, e)


@router.delete("/me/events/{event_id}")
def remove_event(event_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    db.delete(_own(db, player, event_id))
    db.commit()
    return {"ok": True}


# --- Côté coach: les matchs où il a coaché ce joueur --------------------------------------

@router.get("/players/{player_id}/matches")
def coached_matches(player_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    from .players import get_owned_player
    p = get_owned_player(db, coach, player_id)
    acc = account_of(db, p)
    q = select(PlayerEvent).where(PlayerEvent.account_id == acc.id, PlayerEvent.coach_id == coach.id).order_by(PlayerEvent.start.desc())
    return [out(db, e) for e in db.scalars(q)]


class FeedbackIn(BaseModel):
    feedback: str


@router.put("/matches/{event_id}/feedback")
def match_feedback(event_id: int, body: FeedbackIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Retour du coach sur un match où le joueur l'a indiqué comme coach."""
    e = db.get(PlayerEvent, event_id)
    if not e or e.coach_id != coach.id:
        raise HTTPException(404, "Match introuvable")
    e.coach_feedback, e.feedback_at = body.feedback.strip()[:3000], datetime.now(timezone.utc)
    db.commit()
    return out(db, e)
