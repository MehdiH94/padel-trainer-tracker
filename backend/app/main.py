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
]
with engine.begin() as conn:
    for table, column, ddl in NEW_COLUMNS:
        if column not in {c["name"] for c in inspect(engine).get_columns(table)}:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
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
for r in (admin, auth, replace, players, sessions, payments, dashboard, booking, profile, clubs, reminders, promotions, me, exercises, timeoff, finance_router):
    app.include_router(r.router)


@app.get("/health")
def health():
    return {"ok": True}
