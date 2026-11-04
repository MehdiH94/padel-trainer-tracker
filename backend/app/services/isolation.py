"""Comptes « test » (DP-004): les agents de test quotidiens (un coach test, un joueur test) utilisent l'appli
comme tout le monde, mais restent invisibles des vrais utilisateurs.

- Marquage côté serveur uniquement: e-mails listés dans TEST_ACCOUNT_EMAILS (séparés par des virgules,
  sans tenir compte des majuscules), pas modifiable depuis l'appli. Rien en base: aucune migration.
- Deux mondes étanches: un joueur test ne voit que les coachs test et ne réserve que chez eux; un vrai joueur
  ne voit jamais un coach test. Promotions, annonces et invitations d'un coach ne vont qu'aux joueurs de son monde.
- Statistiques de la plateforme: exclure les comptes pour lesquels `is_test` est vrai (champ donné par l'administration).
"""
import os

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Coach, Player
from .accounts import account_of


def listed_emails() -> set[str]:
    # relu à chaque appel, comme ADMIN_EMAILS: un changement de deploy/.env suffit après redémarrage
    return {e.strip().lower() for e in os.getenv("TEST_ACCOUNT_EMAILS", "").split(",") if e.strip()}


def is_test_email(email: str | None) -> bool:
    return bool(email) and email.strip().lower() in listed_emails()


def is_test_coach(coach: Coach) -> bool:
    return is_test_email(coach.email)


def is_test_player(db: Session, p: Player) -> bool:
    """Joueur test: l'e-mail de son compte (fiche compte) est dans la liste; vaut pour toutes ses fiches."""
    return is_test_email(account_of(db, p).email or p.email)


def same_world(db: Session, coach: Coach, p: Player) -> bool:
    """Coach et joueur tous deux « test », ou tous deux réels."""
    return is_test_coach(coach) == is_test_player(db, p)


def visible_coaches(db: Session, p: Player) -> list[Coach]:
    """Coachs que ce joueur peut voir et chez qui il peut réserver."""
    return [c for c in db.scalars(select(Coach).order_by(Coach.name)) if same_world(db, c, p)]
