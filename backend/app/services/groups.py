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


def smallest(kinds: list[str]) -> str:
    """Plus petite formule acceptée = taille minimale voulue (et formule de départ s'il reste seul)."""
    return next(k for k in ORDER if k in kinds)


def parse_opts(raw: str | None) -> set[tuple[str, int]]:
    """« duo:60,duo:90,groupe:90 » -> {("duo", 60), ("duo", 90), ("groupe", 90)}: formules et durées acceptées."""
    out = set()
    for x in (raw or "").split(","):
        k, _, m = x.partition(":")
        if k in SIZES and m.isdigit():
            out.add((k, int(m)))
    return out


def dump_opts(opts) -> str:
    return ",".join(f"{k}:{m}" for k, m in sorted(opts, key=lambda x: (ORDER.index(x[0]), x[1])))


def opts_of(kinds, durations: dict | None, fallback: int) -> set[tuple[str, int]]:
    """Formules et durées acceptées par un joueur. Sans durées précisées: la durée de la séance (fallback);
    seul = toujours 1 h quand le joueur précise ses durées."""
    if durations is None:
        return {(k, fallback) for k in kinds if k in SIZES}
    from .pricing import player_durations
    d = player_durations(durations)
    return {(k, m) for k in kinds if k in SIZES for m in d[k]}


def pairs_of(opts) -> set[tuple[int, int]]:
    """(taille, durée) possibles: à deux = 2 joueurs, en groupe = 3 ou 4."""
    return {(n, m) for k, m in opts for n in SIZES[k]}


def att_pairs(s: TrainingSession, a: Attendance) -> set[tuple[int, int]]:
    """(taille, durée) acceptées par un participant. Sans formule enregistrée (séance montée par le coach):
    de 1 joueur à la capacité du type de séance, à la durée de la séance."""
    opts = parse_opts(getattr(a, "accepted_opts", None))
    if opts:
        return pairs_of(opts)
    kinds = split(a.accepted_kinds)
    if kinds:
        return pairs_of({(k, s.duration_min) for k in kinds})
    return {(n, s.duration_min) for n in range(1, CAPACITY.get(s.kind, 4) + 1)}


def att_sizes(s: TrainingSession, a: Attendance) -> set[int]:
    return {n for n, _ in att_pairs(s, a)}


def is_dynamic(s: TrainingSession) -> bool:
    """Séance formée par les joueurs (au moins un participant a précisé ses formules)."""
    return any(split(a.accepted_kinds) for a in s.attendances)


def _as_pairs(s: TrainingSession, p) -> set[tuple[int, int]]:
    """Demande en attente: ses (taille, durée), ou d'anciennes données (liste de formules) à la durée de la séance."""
    if isinstance(p, set):
        return p
    return pairs_of({(k, s.duration_min) for k in p})


def allowed_pairs(s: TrainingSession, pending: list | None = None) -> set[tuple[int, int]]:
    """(taille, durée) qui conviennent à tous les participants (et aux demandes en attente). La durée ne fait que
    raccourcir (celui qui a la condition la plus stricte l'emporte): jamais plus que la durée actuelle de la séance."""
    sets = [att_pairs(s, a) for a in s.attendances] + [_as_pairs(s, p) for p in pending or [] if p]
    if not sets:
        return {(n, s.duration_min) for n in range(1, CAPACITY.get(s.kind, 4) + 1)}
    out = sets[0]
    for x in sets[1:]:
        out = out & x
    return {(n, m) for n, m in out if m <= s.duration_min}


def allowed(s: TrainingSession, pending: list | None = None) -> set[int]:
    """Tailles qui conviennent à tous les participants (et aux demandes en attente)."""
    return {n for n, _ in allowed_pairs(s, pending)}


def best_minutes(s: TrainingSession) -> int:
    """Durée de la séance d'après ce que tous acceptent: la plus longue encore possible pour sa taille (ou plus)."""
    n0 = len(s.attendances)
    cand = [m for n, m in allowed_pairs(s) if n >= n0]
    return max(cand) if cand else s.duration_min


def played_minutes(s: TrainingSession) -> int:
    """Durée réellement jouée à la taille actuelle (ou minimale voulue): seul = 1 h même si la séance garde 1 h 30
    pour un groupe qui pourrait encore se former."""
    n = max(len(s.attendances), min_needed(s))
    cand = [m for k, m in allowed_pairs(s) if k == n]
    return max(cand) if cand else s.duration_min


def capacity(s: TrainingSession, pending: list | None = None) -> int:
    a = allowed(s, pending)
    return max(a) if a else len(s.attendances)


def min_needed(s: TrainingSession) -> int:
    a = allowed(s)
    return min(a) if a else len(s.attendances)


def is_complete(s: TrainingSession) -> bool:
    return len(s.attendances) in allowed(s)


def join_target(s: TrainingSession, mine, taken: int, pending: list | None = None,
                now: datetime | None = None) -> int | None:
    """Taille visée si ce joueur rejoint (None = impossible). mine: ses (taille, durée) acceptées (ou d'anciennes
    données: liste de formules, à la durée de la séance). taken = participants + demandes en attente."""
    now = now or datetime.now(timezone.utc)
    pairs = allowed_pairs(s, pending)
    if mine:
        pairs &= _as_pairs(s, mine)
    ok = sorted({n for n, _ in pairs if n >= taken + 1})
    if not ok:
        return None
    if ok[0] > taken + 1 and aware(s.start) - now < FORM_DELAY:
        return None  # il manquerait encore des joueurs, et plus le temps de compléter
    return ok[0]


def can_open(kind: str, start: datetime, now: datetime | None = None) -> bool:
    """Ouvrir seul une séance « à deux » ou « en groupe »: seulement à plus de 24 h."""
    return min(SIZES[kind]) == 1 or aware(start) - (now or datetime.now(timezone.utc)) >= FORM_DELAY
