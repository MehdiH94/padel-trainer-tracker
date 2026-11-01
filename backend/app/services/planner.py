"""Préparation d'une séance: points faibles des joueurs, thèmes recommandés, et plan minuté d'exercices."""
import random
import unicodedata

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..constants import CAPACITY
from ..models import Attendance, Exercise, Player, SkillRating, TrainingSession
from .exercises_catalog import BUILTIN, THEMES, WORK_THEMES


def ensure_builtin(db: Session) -> None:
    """Ajoute en base les exercices de l'application qui manquent (au démarrage)."""
    have = set(db.scalars(select(Exercise.name).where(Exercise.coach_id.is_(None))))
    for name, desc, themes, mn, mx, dur in BUILTIN:
        if name not in have:
            db.add(Exercise(coach_id=None, name=name, description=desc, themes=",".join(themes), min_players=mn, max_players=mx, duration_min=dur))
    db.commit()


def themes_of(e: Exercise) -> list[str]:
    return [t for t in e.themes.split(",") if t]


def exercises_for(db: Session, coach_id: int) -> list[Exercise]:
    if not db.scalar(select(Exercise.id).where(Exercise.coach_id.is_(None)).limit(1)):
        ensure_builtin(db)  # base neuve
    return list(db.scalars(select(Exercise).where(or_(Exercise.coach_id.is_(None), Exercise.coach_id == coach_id)).order_by(Exercise.name)))


def _plain(t: str) -> str:
    return unicodedata.normalize("NFD", t).encode("ascii", "ignore").decode().lower()


def player_weaknesses(db: Session, player: Player) -> dict:
    """Dernière note de chaque coup (1 à 5) et notes « à retravailler » des dernières séances."""
    latest: dict[str, int] = {}
    for r in db.scalars(select(SkillRating).where(SkillRating.player_id == player.id).order_by(SkillRating.rated_at, SkillRating.id)):
        latest[r.stroke] = r.score
    notes = [a.to_improve for a in db.scalars(
        select(Attendance).join(TrainingSession, TrainingSession.id == Attendance.session_id)
        .where(Attendance.player_id == player.id, Attendance.to_improve != "", TrainingSession.status == "effectuee")
        .order_by(TrainingSession.start.desc()).limit(3))]
    weak = sorted(([st, sc] for st, sc in latest.items() if sc <= 2), key=lambda x: x[1])
    if not weak and latest:  # rien de faible: on montre le coup le moins bien noté s'il est moyen
        st, sc = min(latest.items(), key=lambda x: x[1])
        weak = [[st, sc]] if sc <= 3 else []
    return {"id": player.id, "name": player.name, "category": player.category, "gender": player.gender,
            "weak": [{"theme": st, "score": sc} for st, sc in weak], "to_improve": notes, "rated": bool(latest)}


def recommend(players: list[dict], limit: int = 3) -> list[str]:
    """Thèmes à travailler en priorité: coups mal notés (1 = 3 pts, 2 = 2 pts, 3 = 1 pt) + thèmes cités dans « à retravailler »."""
    weight: dict[str, float] = {}
    for p in players:
        for w in p["weak"]:
            weight[w["theme"]] = weight.get(w["theme"], 0) + {1: 3, 2: 2, 3: 1}.get(w["score"], 0)
        text = _plain(" ".join(p["to_improve"]))
        for t in WORK_THEMES:
            if _plain(t) in text:
                weight[t] = weight.get(t, 0) + 1
    ranked = sorted((t for t, w in weight.items() if w > 0), key=lambda t: (-weight[t], WORK_THEMES.index(t) if t in WORK_THEMES else 99))
    return ranked[:limit]


def _split(total: int, parts: int) -> list[int]:
    """Découpe total minutes en parts blocs, arrondis à 5 min autant que possible."""
    base = (total // parts) // 5 * 5 or total // parts
    out = [base] * parts
    left = total - base * parts
    i = 0
    while left > 0:
        add = min(5, left)
        out[i % parts] += add
        left -= add
        i += 1
    return out


def build_plan(db: Session, coach_id: int, s: TrainingSession, themes: list[str], seed: int | None = None) -> dict:
    """Plan minuté: échauffement, exercices par thème, jeu, retour au calme, selon la durée et le nombre de joueurs."""
    rng = random.Random(seed)
    themes = [t for t in themes if t in WORK_THEMES][:3]
    n = len(s.attendances) or CAPACITY.get(s.kind, 1)
    D = s.duration_min
    pool = exercises_for(db, coach_id)
    used: set[int] = set()

    def pick(theme: str, prefer: list[str] | None = None) -> Exercise | None:
        ok = [e for e in pool if theme in themes_of(e) and e.min_players <= n <= e.max_players and e.id not in used]
        ok = ok or [e for e in pool if theme in themes_of(e) and e.id not in used]  # à défaut, on adapte au nombre de joueurs
        if prefer:  # ex. pour l'échauffement: un exercice qui touche aussi un thème du jour
            best = [e for e in ok if set(prefer) & set(themes_of(e))]
            ok = best or ok
        mine = [e for e in ok if e.coach_id is not None]  # les exercices du coach d'abord
        choice = rng.choice(mine or ok) if ok else None
        if choice:
            used.add(choice.id)
        return choice

    warm = 5 if D < 45 else 10 if D < 90 else 15
    game = 0 if D < 45 else 10 if D < 75 else 15
    cool = 5 if D >= 75 else 0
    main = max(D - warm - game - cool, 10)
    blocks: list[tuple[str, str, Exercise | None, int]] = [("echauffement", "Échauffement", pick("Échauffement", themes), warm)]
    if themes:
        count = max(len(themes), min(main // 12, len(themes) * 2)) if main >= 20 else 1
        for theme, minutes in zip((themes * 3)[:count], _split(main, count)):
            blocks.append(("exercice", theme, pick(theme), minutes))
    else:
        blocks.append(("exercice", "Libre", None, main))
    if game:
        blocks.append(("jeu", "Jeu", pick("Jeu"), game))
    if cool:
        blocks.append(("retour", "Retour au calme", pick("Retour au calme"), cool))

    items, t = [], 0
    for kind, theme, ex, minutes in blocks:
        items.append({
            "kind": kind, "theme": theme, "start_min": t, "duration_min": minutes,
            "exercise_id": ex.id if ex else None,
            "name": ex.name if ex else (f"Travail libre : {theme}" if theme != "Libre" else "Travail libre"),
            "description": ex.description if ex else "Aucun exercice de la bibliothèque pour ce thème : à vous de jouer.",
            "themes": themes_of(ex) if ex else [theme],
        })
        t += minutes
    return {"themes": themes, "duration_min": D, "players": n, "items": items}


def all_themes() -> dict:
    return {"work": WORK_THEMES, "all": THEMES}
