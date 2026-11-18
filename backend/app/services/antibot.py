"""Protection contre les robots, sans service externe:
- champ piège (« website ») invisible pour une personne: s'il est rempli, c'est un robot, l'inscription est refusée;
- limite de tentatives par adresse IP (inscriptions, connexions, renvoi de lien), en mémoire du serveur.
ANTIBOT=0 coupe les limites (tests). Pour aller plus loin: Cloudflare Turnstile (voir docs/anti-robots.md)."""
import os
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_hits: dict[str, deque] = defaultdict(deque)


def enabled() -> bool:
    return os.getenv("ANTIBOT", "1") != "0"


def client_ip(request: Request) -> str:
    """Adresse du visiteur (derrière Caddy: première adresse de X-Forwarded-For)."""
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else "") or (request.client.host if request.client else "?")


def limit(request: Request, action: str, count: int, seconds: int) -> None:
    """Au plus `count` fois `action` par adresse IP sur `seconds` secondes, sinon 429."""
    if not enabled():
        return
    key, now = f"{action}:{client_ip(request)}", time.monotonic()
    q = _hits[key]
    while q and now - q[0] > seconds:
        q.popleft()
    if len(q) >= count:
        raise HTTPException(429, "Trop de tentatives depuis cet appareil : réessayez dans quelques minutes.")
    q.append(now)


def honeypot(value: str | None) -> None:
    """Champ piège rempli: robot."""
    if (value or "").strip():
        raise HTTPException(400, "Inscription refusée.")


def require_terms(accepted: bool) -> None:
    if not accepted:
        raise HTTPException(422, "Pour créer votre compte, acceptez les conditions d'utilisation.")
