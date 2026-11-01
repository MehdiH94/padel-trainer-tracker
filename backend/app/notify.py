"""Envoi d'un message au joueur par le moyen qu'il a choisi (WhatsApp, SMS ou e-mail).

- SMS: passe par le fournisseur SMS (`FakeSmsProvider` en dev: journalise seulement).
- E-mail: envoyé par SMTP si `SMTP_HOST` est réglé, sinon journalisé seulement.
- WhatsApp: aucune passerelle branchée pour l'instant, le message est journalisé seulement.
"""
import logging
import os
import smtplib
from email.message import EmailMessage

from .models import Player
from .sms.base import SmsProvider

log = logging.getLogger("notify")


def send_email(to: str, subject: str, body: str) -> None:
    host = os.getenv("SMTP_HOST")
    if not host:
        log.info("E-mail (non envoyé, SMTP non réglé) -> %s: %s", to, body)
        return
    msg = EmailMessage()
    msg["From"] = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER", "")
    msg["To"], msg["Subject"] = to, subject
    msg.set_content(body)
    with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "587")), timeout=20) as smtp:
        smtp.starttls()
        if os.getenv("SMTP_USER"):
            smtp.login(os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD", ""))
        smtp.send_message(msg)


class Notifier:
    sent: list[tuple[str, str, str]] = []  # (moyen, destinataire, message): trace pour les tests et le dev

    def __init__(self, sms: SmsProvider):
        self.sms = sms

    def send(self, player: Player, channel: str, subject: str, body: str) -> None:
        if channel == "email":
            send_email(player.email, subject, body)
            to = player.email
        elif channel == "sms":
            self.sms.send(player.phone, body)
            to = player.phone
        else:  # whatsapp
            log.info("WhatsApp (pas de passerelle branchée) -> %s: %s", player.phone, body)
            to = player.phone
        Notifier.sent.append((channel, to, body))
