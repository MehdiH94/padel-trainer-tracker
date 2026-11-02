"""Constantes métier partagées."""

# Classement: tranches principales, du niveau d'entrée (P25) au plus fort (P1000)...
TIERS = ["P25", "P50", "P100", "P250", "P500", "P1000"]
# ...chacune coupée en deux (bas « - » / haut « + »): P25-, P25+, P50-, … P1000+. Même échelle pour hommes et femmes.
CATEGORIES = [t + s for t in TIERS for s in ("-", "+")]
GENDERS = ["M", "F"]

# Nombre de places par type de séance (groupe = 3 ou 4 joueurs)
CAPACITY = {"individuel": 1, "duo": 2, "groupe": 4}
KINDS = list(CAPACITY)


def normalize_category(code: str | None) -> str | None:
    """Ancien code sans +/- (ex. « P100 ») -> bas de la tranche (« P100- »)."""
    return code + "-" if code in TIERS else code


def tier(code: str | None) -> str | None:
    return (code or "").rstrip("+-") or None


def category_index(code: str | None, default: float = 1.0) -> float:
    """Position sur l'échelle, en crans de tranche principale: P100- = 2.0, P100+ = 2.5."""
    code = normalize_category(code)
    if code not in CATEGORIES:
        return default
    return CATEGORIES.index(code) / 2


def step(code: str | None) -> int:
    """Position en crans (demi-tranches): P25- = 0, P25+ = 1, P50- = 2 … P1000+ = 11."""
    code = normalize_category(code)
    return CATEGORIES.index(code) if code in CATEGORIES else CATEGORIES.index("P100-")


def compatible(cat_a: str, gender_a: str, cat_b: str, gender_b: str) -> bool:
    """Deux joueurs peuvent s'entraîner ensemble (crans = demi-tranches, P250- → P250+ = 1 cran):
    - même sexe: au plus un cran d'écart (un P250- joue avec P100+, P250- et P250+);
    - une joueuse et un homme: l'homme a un, deux ou trois crans de moins qu'elle
      (une P1000+ joue avec un P1000-, P500+ ou P500-; une P250+ avec un P250-, P100+ ou P100-; pas plus bas, ni plus haut)."""
    a, b = step(cat_a), step(cat_b)
    if gender_a == gender_b:
        return abs(a - b) <= 1
    woman, man = (a, b) if gender_a == "F" else (b, a)
    return woman - 3 <= man <= woman - 1
