import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import inspect, text

from .db import Base, SessionLocal, engine
from .constants import TIERS
from .routers import auth, booking, clubs, dashboard, exercises, me, payments, players, profile, reminders, sessions
from .notify import Notifier
from .services import courts, planner, session_reminders
from .sms import get_sms_provider

Base.metadata.create_all(engine)

# Petites migrations pour une base déjà en service: create_all n'ajoute pas les colonnes aux tables existantes.
NEW_COLUMNS = [("players", "contact_channel", "VARCHAR(10)"), ("sessions", "plan", "TEXT")]
with engine.begin() as conn:
    for table, column, ddl in NEW_COLUMNS:
        if column not in {c["name"] for c in inspect(engine).get_columns(table)}:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
    # Classement en demi-tranches: un ancien « P100 » devient « P100- » (bas de la tranche)
    for t in TIERS:
        conn.execute(text("UPDATE players SET category = :new WHERE category = :old"), {"new": t + "-", "old": t})
        conn.execute(text("UPDATE sessions SET level = :new WHERE level = :old"), {"new": t + "-", "old": t})
with SessionLocal() as _db:
    planner.ensure_builtin(_db)  # exercices proposés par l'application


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
        except Exception:
            logging.getLogger("rappels").exception("Échec de l'envoi des rappels")


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [asyncio.create_task(_court_sender()), asyncio.create_task(_session_reminders())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Padel Trainer Tracker", lifespan=lifespan)
for r in (auth, players, sessions, payments, dashboard, booking, profile, clubs, reminders, me, exercises):
    app.include_router(r.router)


@app.get("/health")
def health():
    return {"ok": True}
