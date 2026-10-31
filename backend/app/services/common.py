from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TUNIS = ZoneInfo("Africa/Tunis")


def aware(dt: datetime) -> datetime:
    # SQLite renvoie des datetimes naïfs: on les réinterprète en UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
