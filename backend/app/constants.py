"""Constantes métier partagées."""

# Classement par catégories, du niveau d'entrée (P50) au plus fort (P1000).
CATEGORIES = ["P50", "P100", "P250", "P500", "P1000"]
GENDERS = ["M", "F"]

# Nombre de places par type de séance (groupe = 3 ou 4 joueurs)
CAPACITY = {"individuel": 1, "duo": 2, "groupe": 4}
KINDS = list(CAPACITY)


def category_index(code: str | None, default: float = 1.0) -> float:
    return float(CATEGORIES.index(code)) if code in CATEGORIES else default


def compatible(cat_a: str, gender_a: str, cat_b: str, gender_b: str) -> bool:
    """Deux joueurs peuvent s'entraîner ensemble si leurs catégories diffèrent d'un cran au plus.
    Exception: une joueuse ne s'entraîne pas avec un homme de catégorie supérieure à la sienne
    (une P1000 dame peut jouer avec un P500 homme, pas l'inverse)."""
    ia, ib = category_index(cat_a), category_index(cat_b)
    if abs(ia - ib) > 1:
        return False
    if gender_a == "F" and gender_b == "M" and ib > ia:
        return False
    if gender_b == "F" and gender_a == "M" and ia > ib:
        return False
    return True
