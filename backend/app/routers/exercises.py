"""Bibliothèque d'exercices (ceux de l'application + ceux du coach) et préparation des séances."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, Exercise, Player
from ..services import planner
from ..services.exercises_catalog import THEMES
from .sessions import get_owned_session

router = APIRouter(tags=["exercices"])


class ExerciseIn(BaseModel):
    name: str
    description: str = ""
    themes: list[str]
    min_players: int = 1
    max_players: int = 4
    duration_min: int = 15

    @field_validator("themes")
    @classmethod
    def _themes(cls, v: list[str]) -> list[str]:
        v = [t for t in dict.fromkeys(v) if t]
        if not v or any(t not in THEMES for t in v):
            raise ValueError("Choisissez au moins un thème valide")
        return v


def ex_out(e: Exercise) -> dict:
    return {"id": e.id, "name": e.name, "description": e.description, "themes": planner.themes_of(e), "min_players": e.min_players,
            "max_players": e.max_players, "duration_min": e.duration_min, "mine": e.coach_id is not None}


def _check(body: ExerciseIn) -> None:
    if not body.name.strip() or not 1 <= body.min_players <= body.max_players <= 4 or not 5 <= body.duration_min <= 90:
        raise HTTPException(422, "Exercice invalide (nom, 1 à 4 joueurs, 5 à 90 min)")


def _own(db: Session, coach: Coach, exercise_id: int) -> Exercise:
    e = db.get(Exercise, exercise_id)
    if not e or e.coach_id != coach.id:
        raise HTTPException(404, "Exercice introuvable (les exercices de l'application ne sont pas modifiables)")
    return e


@router.get("/exercise-themes")
def exercise_themes():
    return planner.all_themes()


@router.get("/exercises")
def list_exercises(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    return [ex_out(e) for e in planner.exercises_for(db, coach.id)]


@router.post("/exercises", status_code=201)
def create_exercise(body: ExerciseIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    _check(body)
    e = Exercise(coach_id=coach.id, **body.model_dump(exclude={"themes"}), themes=",".join(body.themes))
    db.add(e)
    db.commit()
    return ex_out(e)


@router.put("/exercises/{exercise_id}")
def update_exercise(exercise_id: int, body: ExerciseIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    _check(body)
    e = _own(db, coach, exercise_id)
    for k, v in body.model_dump(exclude={"themes"}).items():
        setattr(e, k, v)
    e.themes = ",".join(body.themes)
    db.commit()
    return ex_out(e)


@router.delete("/exercises/{exercise_id}")
def delete_exercise(exercise_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    db.delete(_own(db, coach, exercise_id))
    db.commit()
    return {"ok": True}


# --- Préparation d'une séance -------------------------------------------

@router.get("/sessions/{session_id}/plan")
def session_plan(session_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Points faibles des joueurs, thèmes recommandés et plan enregistré (s'il y en a un)."""
    s = get_owned_session(db, coach, session_id)
    players = [planner.player_weaknesses(db, db.get(Player, a.player_id)) for a in s.attendances]
    return {
        "session": {"id": s.id, "start": s.start, "duration_min": s.duration_min, "kind": s.kind, "club": s.club, "status": s.status},
        "players": players, "recommended": planner.recommend(players), "themes": planner.all_themes()["work"],
        "plan": json.loads(s.plan) if s.plan else None,
    }


class GenerateIn(BaseModel):
    themes: list[str]
    seed: int | None = None  # autre valeur = autre proposition


@router.post("/sessions/{session_id}/plan/generate")
def generate_plan(session_id: int, body: GenerateIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    s = get_owned_session(db, coach, session_id)
    return planner.build_plan(db, coach.id, s, body.themes, body.seed)


class PlanIn(BaseModel):
    themes: list[str] = []
    duration_min: int
    players: int
    items: list[dict]


@router.put("/sessions/{session_id}/plan")
def save_plan(session_id: int, body: PlanIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    s = get_owned_session(db, coach, session_id)
    s.plan = json.dumps(body.model_dump(), ensure_ascii=False)
    db.commit()
    return {"ok": True}


@router.delete("/sessions/{session_id}/plan")
def delete_plan(session_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    get_owned_session(db, coach, session_id).plan = None
    db.commit()
    return {"ok": True}
