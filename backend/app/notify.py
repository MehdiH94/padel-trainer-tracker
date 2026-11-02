"""Envoi d'un message au joueur par le moyen qu'il a choisi (WhatsApp, SMS ou e-mail).

Version bêta: tous les messages aux joueurs partent par e-mail (`NOTIFY_EMAIL_ONLY`, activé par défaut;
mettre 0 pour revenir au choix du joueur quand WhatsApp et SMS seront branchés).

- SMS: passe par le fournisseur SMS (`FakeSmsProvider` en dev: journalise seulement).
- E-mail: envoyé par SMTP si `SMTP_HOST` est réglé, sinon journalisé seulement.
- WhatsApp: aucune passerelle branchée pour l'instant, le message est journalisé seulement.
"""
import logging
import os
import smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from .models import Player
from .sms.base import SmsProvider

log = logging.getLogger("notify")


EMAIL_ONLY = os.getenv("NOTIFY_EMAIL_ONLY", "1") != "0"


def channel_for(player: Player, email: str | None) -> str:
    """Moyen utilisé pour ce joueur: e-mail en version bêta, sinon celui qu'il a choisi (SMS par défaut)."""
    if EMAIL_ONLY:
        return "email"
    channel = player.contact_channel or "sms"
    return "sms" if channel == "email" and not email else channel


OUTBOX: list[tuple[str, str, str]] = []  # e-mails demandés (destinataire, sujet, texte): trace pour les tests et le dev


def send_email(to: str, subject: str, body: str) -> None:
    OUTBOX.append((to, subject, body))
    host = os.getenv("SMTP_HOST")
    if not host:
        log.info("E-mail (non envoyé, SMTP non réglé) -> %s: %s", to, body)
        return
    sender = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER", "")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = sender, to, subject
    # En-têtes attendus par les filtres anti-spam
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[-1].strip("> ") or None)
    msg.set_content(body)
    port = int(os.getenv("SMTP_PORT", "587"))
    smtp_cls = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP  # 465: TLS direct, sinon STARTTLS
    with smtp_cls(host, port, timeout=20) as smtp:
        if port != 465:
            smtp.starttls()
        if os.getenv("SMTP_USER"):
            smtp.login(os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD", ""))
        smtp.send_message(msg)


class Notifier:
    sent: list[tuple[str, str, str]] = []  # (moyen, destinataire, message): trace pour les tests et le dev

    def __init__(self, sms: SmsProvider):
        self.sms = sms

    def send(self, player: Player, channel: str, subject: str, body: str, email: str | None = None) -> None:
        channel = "email" if EMAIL_ONLY else channel
        if channel == "email":
            to = email or player.email
            if not to:  # joueur sans compte (pas d'e-mail): rien à envoyer, le coach le prévient lui-même
                log.info("Pas d'e-mail pour le joueur %s: message non envoyé: %s", player.id, body)
                Notifier.sent.append(("aucun", player.phone, body))
                return
            send_email(to, subject, body)
        elif channel == "sms":
            self.sms.send(player.phone, body)
            to = player.phone
        else:  # whatsapp
            log.info("WhatsApp (pas de passerelle branchée) -> %s: %s", player.phone, body)
            to = player.phone
        Notifier.sent.append((channel, to, body))
