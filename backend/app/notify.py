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


APP_URL = os.getenv("APP_URL", "http://localhost:5173").rstrip("/")


def letter(name: str | None, *blocks, closing: str = "À bientôt,", sign: str = "Padel Coach") -> str:
    """Mise en page commune des messages (e-mail, SMS, WhatsApp):

        Bonjour Sami,

        <paragraphe>

        Quand : mercredi 4 novembre, de 12h à 13h
        Où : Padel Club La Marsa · Terrain 2

        À bientôt,
        Coach Démo

    Un bloc est soit un paragraphe (texte), soit une liste de détails [(intitulé, valeur), …] (valeurs vides ignorées)."""
    parts = [f"Bonjour {name.split()[0]}," if name else "Bonjour,"]
    for b in blocks:
        if isinstance(b, (list, tuple)):
            lines = [f"{k} : {v}" for k, v in b if v]
            if lines:
                parts.append("\n".join(lines))
        elif b:
            parts.append(str(b).strip())
    parts.append(f"{closing}\n{sign}" if closing else sign)
    return "\n\n".join(parts)


def _html(subject: str, body: str) -> str:
    """Version HTML de l'e-mail: mêmes paragraphes, intitulés des détails en gras, liens cliquables, pied de page."""
    import html
    import re
    paras = []
    label = re.compile(r"^([A-ZÀ-Ý][\w' ]{1,18}) : (.+)$")
    for block in body.split("\n\n"):
        raw = html.escape(block).split("\n")
        details = all(label.match(x) for x in raw) and not block.rstrip().endswith((".", "!", ":"))  # bloc « Quand : … / Où : … »
        lines = []
        for line in raw:
            line = re.sub(r"(https?://[^\s<]+)", r'<a href="\1" style="color:#c2410c">\1</a>', line)
            m = label.match(line) if details else None
            lines.append(f"<b>{m.group(1)}</b>&nbsp;: {m.group(2)}" if m else line)
        paras.append(f'<p style="margin:0 0 16px">{"<br>".join(lines)}</p>')
    return (
        '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="Content-Language" content="fr">'
        f"<title>{html.escape(subject)}</title></head>"
        '<body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">'
        '<div style="max-width:560px;margin:0 auto;padding:24px 16px">'
        '<div style="font-weight:bold;font-size:18px;color:#c2410c;margin-bottom:12px">Padel Coach</div>'
        f'<div style="background:#ffffff;border-radius:12px;padding:24px;font-size:16px;line-height:1.55">{"".join(paras)}</div>'
        f'<div style="font-size:12px;color:#6b7280;margin-top:12px">Message envoyé par <a href="{APP_URL}" style="color:#6b7280">Padel Coach</a>. '
        "Vos séances, rappels et crédits sont dans l'application.</div>"
        "</div></body></html>"
    )


OUTBOX: list[tuple[str, str, str]] = []  # e-mails demandés (destinataire, sujet, texte): trace pour les tests et le dev


def send_email(to: str, subject: str, body: str) -> bool:
    """Envoie un e-mail. Un échec (SMTP mal réglé, serveur injoignable) est journalisé mais ne bloque jamais
    l'action en cours (inscription, réservation…). Retourne True si l'e-mail est parti."""
    OUTBOX.append((to, subject, body))
    host = os.getenv("SMTP_HOST")
    if not host:
        log.info("E-mail (non envoyé, SMTP non réglé) -> %s: %s", to, body)
        return False
    try:
        _smtp_send(host, to, subject, body)
        return True
    except Exception:
        log.exception("E-mail non envoyé à %s (%s): vérifier SMTP_HOST, SMTP_USER, SMTP_PASSWORD", to, subject)
        return False


def _smtp_send(host: str, to: str, subject: str, body: str) -> None:
    sender = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER", "")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = sender, to, subject
    # En-têtes attendus par les filtres anti-spam
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[-1].strip("> ") or None)
    msg["Content-Language"] = "fr"  # message en français (Gmail ne propose plus de le traduire)
    msg.set_content(body)
    msg.add_alternative(_html(subject, body), subtype="html")  # même contenu, mis en page
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
