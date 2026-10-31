"""Relances: messages prêts à envoyer (liens SMS / WhatsApp / e-mail ouverts depuis le téléphone du coach)."""
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..models import Coach, ReminderLog, Player, TrainingSession
from ..services.common import TUNIS, aware
from ..services.courts import JOURS
from ..services.finance import billed_by_player, credit_balance, paid_by_player
from .players import get_owned_player

router = APIRouter(tags=["relances"])
APP_URL = os.getenv("APP_URL", "http://localhost:5173")


def tnd(m: int) -> str:
    return f"{m / 1000:.3f}".replace(".", ",") + " TND"


@router.get("/reminders")
def reminders(base: str = "", coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    base = (base or APP_URL).rstrip("/")
    players = {p.id: p for p in db.scalars(select(Player).where(Player.coach_id == coach.id))}
    sessions = db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id)).all()
    last_log: dict[tuple[int, str], ReminderLog] = {}
    for log in db.scalars(select(ReminderLog).where(ReminderLog.coach_id == coach.id).order_by(ReminderLog.sent_at)):
        last_log[(log.player_id, log.kind)] = log

    items = []

    def add(p: Player, kind: str, subject: str, message: str, extra: dict | None = None):
        log = last_log.get((p.id, kind))
        items.append({
            "key": f"{kind}-{p.id}", "player_id": p.id, "name": p.name, "phone": p.phone, "email": p.email, "kind": kind,
            "subject": subject, "message": message, "last_sent": {"channel": log.channel, "sent_at": log.sent_at} if log else None,
        } | (extra or {}))

    # 1. Impayés
    billed, paid = billed_by_player(sessions), paid_by_player(db, coach.id)
    for pid, amount in billed.items():
        due = amount - paid.get(pid, 0)
        if due > 0 and pid in players:
            p = players[pid]
            add(p, "impaye", "Rappel de paiement", f"Bonjour {p.name.split()[0]}, petit rappel : il reste {tnd(due)} à régler pour vos séances de padel. Merci ! — {coach.name}", {"amount_millimes": due})

    # 2. Séances de demain
    now = datetime.now(timezone.utc)
    tomorrow = (now.astimezone(TUNIS) + timedelta(days=1)).date()
    for s in sessions:
        if s.status != "prevue" or aware(s.start).astimezone(TUNIS).date() != tomorrow:
            continue
        t = aware(s.start).astimezone(TUNIS)
        where = f" ({s.club})" if s.club else ""
        for a in s.attendances:
            p = players.get(a.player_id)
            if p:
                add(p, "seance", "Rappel de séance", f"Bonjour {p.name.split()[0]}, rappel : séance de padel demain ({JOURS[t.weekday()]} {t:%d/%m}) à {t:%H}h{t:%M}{where}. Répondez-moi si vous avez un empêchement. — {coach.name}", {"start": s.start})

    # 3. Invitations (joueurs sans compte)
    for p in players.values():
        if p.password_hash:
            continue
        if not p.invite_token:
            p.invite_token = secrets.token_urlsafe(16)
        add(p, "invitation", "Votre compte Padel Coach", f"Bonjour {p.name.split()[0]}, créez votre compte pour réserver vos séances en ligne : {base}/invite/{p.invite_token} — {coach.name}")

    # 4. Crédits bas (joueurs avec compte dont le solde ne couvre plus une séance)
    cheapest = min((x for x in (coach.price_individuel, coach.price_duo, coach.price_groupe) if x), default=0)
    if cheapest:
        for p in players.values():
            if p.password_hash and credit_balance(db, p.id) < cheapest:
                add(p, "credits", "Recharge de crédits", f"Bonjour {p.name.split()[0]}, votre solde de crédits est de {tnd(credit_balance(db, p.id))}. Pensez à le recharger pour réserver vos prochaines séances. — {coach.name}", {"balance_millimes": credit_balance(db, p.id)})
    db.commit()
    return items


class LogIn(BaseModel):
    player_id: int
    kind: str
    channel: str


@router.post("/reminders/log", status_code=201)
def log_reminder(body: LogIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    get_owned_player(db, coach, body.player_id)
    if body.channel not in ("sms", "whatsapp", "email") or body.kind not in ("impaye", "seance", "invitation", "credits"):
        raise HTTPException(422, "Relance invalide")
    db.add(ReminderLog(coach_id=coach.id, **body.model_dump()))
    db.commit()
    return {"ok": True}
