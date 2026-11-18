"""Notifications du téléphone (Web Push), sans App Store ni Google Play: Android (Chrome, appli installée ou non) et
iPhone (iOS 16.4+, seulement avec l'appli ajoutée à l'écran d'accueil). Le joueur ou le coach accepte une fois.
Clés VAPID créées une fois au premier besoin et gardées en base (AppSetting). Envoi en arrière-plan: une
notification ratée ne bloque jamais l'action; un abonnement expiré (404/410) est supprimé."""
import base64
import json
import logging
import os
import threading

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AppSetting, PushSubscription

log = logging.getLogger(__name__)
CONTACT = "mailto:noreply@padel-boost.net"
# Services de notification des navigateurs: le serveur ne contacte jamais une autre adresse
PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com")
PUSH_SUFFIXES = (".push.apple.com", ".notify.windows.com")


def allowed_endpoint(endpoint: str) -> bool:
    from urllib.parse import urlparse
    try:
        u = urlparse(endpoint)
    except ValueError:
        return False
    host = (u.hostname or "").lower().rstrip(".")
    return u.scheme == "https" and (host in PUSH_HOSTS or any(host.endswith(s) for s in PUSH_SUFFIXES))


def keys(db: Session) -> tuple[str, str]:
    """(clé privée PEM, clé publique pour le navigateur en base64url)."""
    row = db.get(AppSetting, "vapid_private")
    if not row:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        pk = ec.generate_private_key(ec.SECP256R1())
        pem = pk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        row = AppSetting(key="vapid_private", value=pem)
        db.add(row)
        db.commit()
    from cryptography.hazmat.primitives import serialization
    pk = serialization.load_pem_private_key(row.value.encode(), password=None)
    raw = pk.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return row.value, base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def send(db: Session, title: str, body: str, url: str = "/", player_ids=None, coach_id: int | None = None) -> int:
    """Notification aux appareils abonnés de ces joueurs (fiches compte) ou de ce coach. Retourne le nombre d'appareils."""
    q = select(PushSubscription)
    if coach_id is not None:
        q = q.where(PushSubscription.coach_id == coach_id)
    else:
        q = q.where(PushSubscription.player_id.in_(list(player_ids or [])))
    subs = [(s.endpoint, s.p256dh, s.auth) for s in db.scalars(q) if allowed_endpoint(s.endpoint)]
    if not subs or os.getenv("PUSH_DISABLED") == "1":
        return 0
    pem, _ = keys(db)
    data = json.dumps({"title": title[:120], "body": body[:240], "url": url})

    def run():
        from pywebpush import WebPushException, webpush
        from ..db import SessionLocal
        gone = []
        for endpoint, p256dh, auth in subs:
            try:
                webpush({"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}, data,
                        vapid_private_key=pem, vapid_claims={"sub": CONTACT}, timeout=10)
            except WebPushException as e:
                if getattr(e, "response", None) is not None and e.response.status_code in (404, 410):
                    gone.append(endpoint)
                else:
                    log.warning("Notification non envoyée: %s", e)
            except Exception:  # réseau, clé…: jamais bloquant
                log.exception("Notification non envoyée")
        if gone:
            with SessionLocal() as s:
                for x in s.scalars(select(PushSubscription).where(PushSubscription.endpoint.in_(gone))):
                    s.delete(x)
                s.commit()

    threading.Thread(target=run, daemon=True).start()
    return len(subs)
