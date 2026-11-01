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


def compatible(cat_a: str, gender_a: str, cat_b: str, gender_b: str) -> bool:
    """Deux joueurs peuvent s'entraîner ensemble si leurs tranches principales diffèrent d'un cran au plus
    (le +/- ne compte pas ici: P100+ joue avec P50- comme avec P250+).
    Exception: une joueuse ne s'entraîne pas avec un homme d'une tranche supérieure à la sienne
    (une P1000 dame peut jouer avec un P500 homme, pas l'inverse)."""
    ia, ib = TIERS.index(tier(cat_a)) if tier(cat_a) in TIERS else 1, TIERS.index(tier(cat_b)) if tier(cat_b) in TIERS else 1
    if abs(ia - ib) > 1:
        return False
    if gender_a == "F" and gender_b == "M" and ib > ia:
        return False
    if gender_b == "F" and gender_a == "M" and ia > ib:
        return False
    return True
