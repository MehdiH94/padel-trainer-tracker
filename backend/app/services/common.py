from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TUNIS = ZoneInfo("Africa/Tunis")


def aware(dt: datetime) -> datetime:
    # SQLite renvoie des datetimes naïfs: on les réinterprète en UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


JOURS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]


def heure(t: datetime) -> str:
    return f"{t:%H}h{t:%M}".replace("h00", "h")


def quand(start: datetime, minutes: int | None = None) -> str:
    """Date lisible à Tunis, pour les messages: « mercredi 4 novembre, de 12h à 13h » (ou « à 12h »)."""
    t = aware(start).astimezone(TUNIS)
    day = f"{JOURS_FR[t.weekday()]} {t.day} {MOIS_FR[t.month - 1]}"
    if minutes:
        from datetime import timedelta
        return f"{day}, de {heure(t)} à {heure(t + timedelta(minutes=minutes))}"
    return f"{day} à {heure(t)}"
