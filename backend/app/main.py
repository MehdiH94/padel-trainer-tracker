import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError

from .errors import validation_handler
from sqlalchemy import inspect, select, text

from .db import Base, SessionLocal, engine
from .constants import TIERS
from .routers import admin, auth, replace, booking, clubs, dashboard, exercises, me, payments, players, profile, promotions, reminders, sessions, timeoff
from .routers import coach_events, events
from .routers import finance as finance_router  # onglet Finance (le module services.finance garde son nom)
from .notify import Notifier
from .services import booking as booking_svc
from .services import courts, finance, planner, session_reminders
from .models import Coach, Player
from .sms import get_sms_provider

# Journal de l'application (e-mails non envoyés sans SMTP, envois ratés…) visible dans la sortie du serveur.
# Niveau réglable par LOG_LEVEL (INFO par défaut); sans handler, Python ne montrait que les avertissements.
if not logging.getLogger().handlers:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

Base.metadata.create_all(engine)

# Petites migrations pour une base déjà en service: create_all n'ajoute pas les colonnes aux tables existantes.
NEW_COLUMNS = [
    ("bookings", "cancelled_at", "DATETIME"), ("bookings", "group_id", "INTEGER"), ("bookings", "group_token", "VARCHAR(24)"),
    ("coaches", "avoid_gaps", "BOOLEAN DEFAULT 1"), ("coaches", "price_grid", "TEXT"), ("coaches", "booking_horizon_days", "INTEGER DEFAULT 14"),
    ("players", "contact_channel", "VARCHAR(10)"), ("sessions", "plan", "TEXT"), ("players", "account_id", "INTEGER"),
    ("coaches", "bio", "TEXT DEFAULT ''"), ("coaches", "specialties", "VARCHAR(255) DEFAULT ''"),
    ("coaches", "duration_duo", "INTEGER"), ("coaches", "duration_groupe", "INTEGER"), ("bookings", "accepted_kinds", "VARCHAR(40) DEFAULT ''"),
    ("bookings", "price_millimes", "INTEGER DEFAULT 0"), ("clubs", "active", "BOOLEAN DEFAULT 1"),
    ("attendances", "accepted_kinds", "VARCHAR(40) DEFAULT ''"), ("bookings", "discount_pct", "INTEGER DEFAULT 0"),
    ("court_bookings", "series_id", "VARCHAR(36)"), ("coaches", "booking_mode", "VARCHAR(16) DEFAULT 'terrains'"),
    ("credit_tx", "session_id", "INTEGER"), ("clubs", "removed", "BOOLEAN DEFAULT 0"), ("bookings", "replace_token", "VARCHAR(40)"), ("players", "signup_status", "VARCHAR(12)"), ("players", "invited_category", "VARCHAR(6)"), ("players", "signup_at", "TIMESTAMP"),
    ("players", "email_verified_at", "TIMESTAMP"), ("players", "email_token", "VARCHAR(48)"), ("players", "email_token_sent_at", "TIMESTAMP"),
    ("coaches", "phone", "VARCHAR(20) DEFAULT ''"), ("coaches", "is_admin", "BOOLEAN DEFAULT 0"), ("coaches", "signup_status", "VARCHAR(12)"),
    ("coaches", "signup_at", "TIMESTAMP"), ("coaches", "email_verified_at", "TIMESTAMP"), ("coaches", "email_token", "VARCHAR(48)"),
    ("coaches", "email_token_sent_at", "TIMESTAMP"),
    ("happy_hours", "discount_millimes", "INTEGER DEFAULT 0"), ("promotions", "discount_millimes", "INTEGER DEFAULT 0"),
    ("bookings", "discount_millimes", "INTEGER DEFAULT 0"), ("skill_ratings", "value", "INTEGER"), ("coaches", "criteria", "TEXT"), ("players", "criteria", "TEXT"),
    ("coaches", "hourly_prices", "BOOLEAN DEFAULT 0"), ("attendances", "refunded", "BOOLEAN DEFAULT 0"),
    ("player_events", "court_reserved", "BOOLEAN DEFAULT 0"), ("players", "fav_coaches", "VARCHAR(120) DEFAULT ''"),
    ("players", "fav_clubs", "TEXT DEFAULT ''"), ("bookings", "accepted_opts", "VARCHAR(120) DEFAULT ''"),
    ("attendances", "accepted_opts", "VARCHAR(120) DEFAULT ''"), ("coaches", "join_token", "VARCHAR(32)"), ("players", "open_signup", "BOOLEAN DEFAULT 0"),
    ("bookings", "proposed_start", "TIMESTAMP"), ("bookings", "proposed_minutes", "INTEGER"),
    ("coaches", "vip_price_grid", "TEXT"), ("players", "vip", "BOOLEAN DEFAULT 0"), ("attendances", "price_millimes", "INTEGER"),
    ("coaches", "terms_accepted_at", "TIMESTAMP"), ("players", "terms_accepted_at", "TIMESTAMP"),
]
def _ddl(ddl: str) -> str:
    """Types écrits pour SQLite, traduits pour PostgreSQL (sandbox et prod de l'usine)."""
    if engine.dialect.name != "postgresql":
        return ddl
    return ddl.replace("DATETIME", "TIMESTAMP").replace("BOOLEAN DEFAULT 1", "BOOLEAN DEFAULT TRUE").replace("BOOLEAN DEFAULT 0", "BOOLEAN DEFAULT FALSE")


# Colonnes existantes lues d'abord, avant toute modification: une lecture faite pendant la transaction (autre
# connexion) attendrait le verrou d'une table déjà modifiée et bloquerait le démarrage sous PostgreSQL.
_existing = {t: {c["name"] for c in inspect(engine).get_columns(t)} for t in {t for t, _, _ in NEW_COLUMNS}}
with engine.begin() as conn:
    for table, column, ddl in NEW_COLUMNS:
        if column not in _existing[table]:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {_ddl(ddl)}"))
            if column == "hourly_prices":  # prix par séance de la durée de la formule -> prix par heure (une seule fois)
                conn.execute(text("UPDATE coaches SET price_individuel = ROUND(price_individuel * 60.0 / slot_minutes) WHERE slot_minutes > 0 AND slot_minutes != 60"))
                for k in ("duo", "groupe"):
                    conn.execute(text(f"UPDATE coaches SET price_{k} = ROUND(price_{k} * 60.0 / COALESCE(duration_{k}, slot_minutes)) "
                                      f"WHERE COALESCE(duration_{k}, slot_minutes) > 0 AND COALESCE(duration_{k}, slot_minutes) != 60"))
                conn.execute(text("UPDATE coaches SET hourly_prices = :oui"), {"oui": True})
            if column == "email_verified_at":  # comptes créés avant la vérification (DP-002): considérés comme vérifiés
                conn.execute(text("UPDATE players SET email_verified_at = CURRENT_TIMESTAMP WHERE password_hash IS NOT NULL"))
    # Notes de 1 à 5 (avant) -> 0 à 100 (note sur 10 au dixième)
    conn.execute(text("UPDATE skill_ratings SET value = score * 20 WHERE value IS NULL"))
    # Classement en demi-tranches: un ancien « P100 » devient « P100- » (bas de la tranche)
    for t in TIERS:
        conn.execute(text("UPDATE players SET category = :new WHERE category = :old"), {"new": t + "-", "old": t})
        conn.execute(text("UPDATE sessions SET level = :new WHERE level = :old"), {"new": t + "-", "old": t})
def _player_coach_optional() -> None:
    """Comptes joueurs sans coach: players.coach_id devient facultatif. SQLite ne sait pas modifier une colonne:
    la table est reconstruite (une seule fois), les données recopiées telles quelles."""
    if not str(engine.url).startswith("sqlite"):
        return
    cols = inspect(engine).get_columns("players")
    if next(c for c in cols if c["name"] == "coach_id")["nullable"]:
        return
    names = ", ".join(c["name"] for c in cols)
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        conn.exec_driver_sql("PRAGMA legacy_alter_table=ON")  # les autres tables gardent leur lien vers « players »
        conn.commit()
        conn.exec_driver_sql("ALTER TABLE players RENAME TO players_old")
        for (idx,) in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='players_old' AND name NOT LIKE 'sqlite_autoindex%'").all():
            conn.exec_driver_sql(f"DROP INDEX {idx}")
        Player.__table__.create(conn)
        conn.exec_driver_sql(f"INSERT INTO players ({names}) SELECT {names} FROM players_old")
        conn.exec_driver_sql("DROP TABLE players_old")
        conn.commit()
        conn.exec_driver_sql("PRAGMA legacy_alter_table=OFF")
        conn.commit()


_player_coach_optional()
with SessionLocal() as _db:
    planner.ensure_builtin(_db)  # exercices proposés par l'application
    # Crédits restants et séances encore dues en même temps (données d'avant la règle): les crédits les règlent
    for _c in _db.scalars(select(Coach)):
        finance.settle(_db, _c.id, _db.scalars(select(Player.id).where(Player.coach_id == _c.id)).all())
    _db.commit()


async def _court_sender():
    """Toutes les 10 minutes, envoie aux clubs les demandes de terrain devenues « dues » (séance dans moins de 7 jours)."""
    while True:
        await asyncio.sleep(600)
        with SessionLocal() as db:
            courts.send_due(db, None, get_sms_provider())


async def _session_reminders():
    """Toutes les 5 minutes, envoie aux joueurs les rappels de séance (24 h et 2 h avant)."""
    while True:
        await asyncio.sleep(300)
        try:
            with SessionLocal() as db:
                session_reminders.send_due(db, Notifier(get_sms_provider()))
                booking_svc.settle_durations(db)  # moins de 24 h: durée réellement jouée (seul = 1 h)
                booking_svc.remind_incomplete(db)  # 6 h avant: séance pas encore assez remplie
                booking_svc.complete_finished(db)  # séances terminées: effectuées automatiquement
        except Exception:
            logging.getLogger("rappels").exception("Échec de l'envoi des rappels")


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [asyncio.create_task(_court_sender()), asyncio.create_task(_session_reminders())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Padel Trainer Tracker", lifespan=lifespan)
app.add_exception_handler(RequestValidationError, validation_handler)  # erreurs de formulaire expliquées en français
for r in (admin, auth, replace, players, sessions, payments, dashboard, booking, profile, clubs, reminders, promotions, me, exercises, timeoff, finance_router, events, coach_events):
    app.include_router(r.router)


@app.get("/health")
def health():
    return {"ok": True}
