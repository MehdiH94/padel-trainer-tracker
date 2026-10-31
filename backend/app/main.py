import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import Base, SessionLocal, engine
from .routers import auth, booking, clubs, dashboard, me, payments, players, profile, reminders, sessions
from .services import courts
from .sms import get_sms_provider

Base.metadata.create_all(engine)


async def _court_sender():
    """Toutes les 10 minutes, envoie aux clubs les demandes de terrain devenues « dues » (séance dans moins de 7 jours)."""
    while True:
        await asyncio.sleep(600)
        with SessionLocal() as db:
            courts.send_due(db, None, get_sms_provider())


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_court_sender())
    yield
    task.cancel()


app = FastAPI(title="Padel Trainer Tracker", lifespan=lifespan)
for r in (auth, players, sessions, payments, dashboard, booking, profile, clubs, reminders, me):
    app.include_router(r.router)


@app.get("/health")
def health():
    return {"ok": True}
