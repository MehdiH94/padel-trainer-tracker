"""Taille des séances formées par les joueurs (seul, à deux, en groupe).

Chaque joueur accepte certaines tailles: seul = 1, à deux = 2, en groupe = 3 ou 4 joueurs.
- Une séance accepte un nouveau joueur si sa taille après l'arrivée convient à tous les participants
  (et à lui). Exemple: quelqu'un qui ne veut que seul ou à deux ferme la séance à 2 joueurs.
- Elle est confirmée quand sa taille convient à tous (taille minimale atteinte). Avant, les demandes
  acceptées par le coach restent « en attente d'autres joueurs ».
- On ne peut ouvrir ou rejoindre une séance qui n'aura pas encore assez de joueurs que si elle a lieu
  dans plus de 24 h (le temps de compléter le groupe).
- Les séances montées par le coach (participants sans formule enregistrée) suivent leur type, comme avant.
"""
from datetime import datetime, timedelta, timezone

from ..constants import CAPACITY
from ..models import Attendance, TrainingSession
from .common import aware

SIZES = {"individuel": {1}, "duo": {2}, "groupe": {3, 4}}
ORDER = list(CAPACITY)  # individuel, duo, groupe
FORM_DELAY = timedelta(hours=24)  # pour avoir le temps de compléter un groupe
REMIND_BEFORE = timedelta(hours=6)  # « reconsidérez votre choix » si la séance n'est pas complète


def sizes(kinds) -> set[int]:
    return set().union(*(SIZES[k] for k in kinds if k in SIZES)) if kinds else set()


def kind_for_size(n: int) -> str:
    return "individuel" if n <= 1 else "duo" if n == 2 else "groupe"


def split(kinds: str | None) -> list[str]:
    return [k for k in (kinds or "").split(",") if k in SIZES]


def from_kind(accepted: list[str], picked: str) -> list[str]:
    """Formules retenues pour une demande: celle choisie et les plus grandes que le joueur accepte aussi
    (choisir « à deux » = au moins 2 joueurs, au prix du duo)."""
    start = ORDER.index(picked)
    return [k for k in ORDER[start:] if k == picked or k in accepted]


def att_sizes(s: TrainingSession, a: Attendance) -> set[int]:
    """Tailles acceptées par un participant. Sans formule enregistrée (séance montée par le coach):
    de 1 joueur à la capacité du type de séance, sans minimum."""
    return sizes(split(a.accepted_kinds)) or set(range(1, CAPACITY.get(s.kind, 4) + 1))


def is_dynamic(s: TrainingSession) -> bool:
    """Séance formée par les joueurs (au moins un participant a précisé ses formules)."""
    return any(split(a.accepted_kinds) for a in s.attendances)


def allowed(s: TrainingSession, pending: list[list[str]] | None = None) -> set[int]:
    """Tailles qui conviennent à tous les participants (et aux demandes en attente)."""
    sets = [att_sizes(s, a) for a in s.attendances] + [sizes(k) for k in pending or [] if k]
    if not sets:
        return set(range(1, CAPACITY.get(s.kind, 4) + 1))
    out = sets[0]
    for x in sets[1:]:
        out = out & x
    return out


def capacity(s: TrainingSession, pending: list[list[str]] | None = None) -> int:
    a = allowed(s, pending)
    return max(a) if a else len(s.attendances)


def min_needed(s: TrainingSession) -> int:
    a = allowed(s)
    return min(a) if a else len(s.attendances)


def is_complete(s: TrainingSession) -> bool:
    return len(s.attendances) in allowed(s)


def join_target(s: TrainingSession, kinds: list[str] | None, taken: int, pending: list[list[str]] | None = None,
                now: datetime | None = None) -> int | None:
    """Taille visée si ce joueur rejoint (None = impossible). taken = participants + demandes en attente."""
    now = now or datetime.now(timezone.utc)
    ok = sorted(n for n in allowed(s, pending) & (sizes(kinds) if kinds else {1, 2, 3, 4}) if n >= taken + 1)
    if not ok:
        return None
    if ok[0] > taken + 1 and aware(s.start) - now < FORM_DELAY:
        return None  # il manquerait encore des joueurs, et plus le temps de compléter
    return ok[0]


def can_open(kind: str, start: datetime, now: datetime | None = None) -> bool:
    """Ouvrir seul une séance « à deux » ou « en groupe »: seulement à plus de 24 h."""
    return min(SIZES[kind]) == 1 or aware(start) - (now or datetime.now(timezone.utc)) >= FORM_DELAY
