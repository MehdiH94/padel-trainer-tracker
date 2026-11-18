"""Avis sur les coachs, annuaire public des coachs, liste d'attente des séances complètes,
abonnement aux notifications du téléphone."""
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import _decode, bearer, current_coach, current_player
from ..db import get_db
from ..models import Attendance, Coach, Player, PushSubscription, Review, TrainingSession, Waitlist
from ..services import isolation, push
from ..services.accounts import account_of, linked
from ..services.common import aware

router = APIRouter(tags=["communauté"])


# --- Avis ----------------------------------------------------------------------

def rating_of(db: Session, coach_id: int) -> dict:
    avg, n = db.execute(select(func.avg(Review.rating), func.count(Review.id)).where(Review.coach_id == coach_id)).one()
    return {"rating": round(float(avg), 1) if avg else None, "reviews_count": n or 0}


def reviews_of(db: Session, coach_id: int, limit: int = 30) -> list[dict]:
    out = []
    for r in db.scalars(select(Review).where(Review.coach_id == coach_id).order_by(Review.updated_at.desc()).limit(limit)):
        p = db.get(Player, r.account_id)
        parts = (p.name if p else "Joueur").split()
        who = parts[0] + (f" {parts[-1][0]}." if len(parts) > 1 else "")  # « Sami B. »
        out.append({"id": r.id, "rating": r.rating, "comment": r.comment, "author": who, "date": r.updated_at})
    return out


def can_review(db: Session, player: Player, coach_id: int) -> bool:
    """Au moins une séance effectuée chez ce coach (hors absence remboursée)."""
    ids = {p.id for p in linked(db, player)}
    return bool(db.scalar(select(Attendance.id).join(TrainingSession, TrainingSession.id == Attendance.session_id).where(
        Attendance.player_id.in_(ids), TrainingSession.coach_id == coach_id, TrainingSession.status == "effectuee",
        Attendance.refunded.is_(False)).limit(1)))


class ReviewIn(BaseModel):
    rating: int
    comment: str = ""


@router.put("/me/coaches/{coach_id}/review")
def put_review(coach_id: int, body: ReviewIn, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    coach = db.get(Coach, coach_id)
    if not coach or not isolation.same_world(db, coach, player):
        raise HTTPException(404, "Coach introuvable")
    if not 1 <= body.rating <= 5:
        raise HTTPException(422, "Note de 1 à 5.")
    if not can_review(db, player, coach_id):
        raise HTTPException(403, "Vous pourrez laisser un avis après votre première séance avec ce coach.")
    acc = account_of(db, player)
    r = db.scalar(select(Review).where(Review.coach_id == coach_id, Review.account_id == acc.id))
    if not r:
        r = Review(coach_id=coach_id, account_id=acc.id, rating=body.rating)
        db.add(r)
    r.rating, r.comment, r.updated_at = body.rating, body.comment.strip()[:1000], datetime.now(timezone.utc)
    db.commit()
    return {"ok": True} | rating_of(db, coach_id)


@router.delete("/me/coaches/{coach_id}/review")
def delete_review(coach_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    r = db.scalar(select(Review).where(Review.coach_id == coach_id, Review.account_id == account_of(db, player).id))
    if r:
        db.delete(r)
        db.commit()
    return {"ok": True}


@router.get("/coach/reviews")
def my_reviews(coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach voit ses avis (page publique)."""
    return rating_of(db, coach.id) | {"reviews": reviews_of(db, coach.id)}


# --- Annuaire public des coachs (sans connexion) ---------------------------------

def _public(c: Coach) -> bool:
    """Coach listé publiquement: réel, confirmé, et avec au moins un tarif réglé (20 TND ou plus)."""
    from ..services.pricing import MIN_PRICE, grid
    priced = any(p >= MIN_PRICE for x in grid(c).values() for p in x.values())
    return not isolation.is_test_coach(c) and c.signup_status in (None, "validee") and priced


VIDEO_HOSTS = ("youtube.com", "youtu.be", "instagram.com", "tiktok.com", "facebook.com", "fb.watch", "vimeo.com")


def video_ok(url: str) -> bool:
    """Lien de vidéo accepté: https, chez un des grands sites de vidéo."""
    from urllib.parse import urlparse
    try:
        u = urlparse(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    return u.scheme == "https" and any(host == h or host.endswith("." + h) for h in VIDEO_HOSTS)


def youtube_id(url: str) -> str | None:
    """Identifiant d'une vidéo YouTube (lien youtu.be, watch?v=, shorts/), pour l'afficher dans la page."""
    import re
    m = re.search(r"(?:youtu\.be/|v=|/shorts/|/embed/)([A-Za-z0-9_-]{11})", url or "")
    return m.group(1) if m else None


def photo_url(c: Coach) -> str | None:
    return f"/api/public/coaches/{c.id}/photo?v={len(c.photo) % 100000}" if c.photo else None


def _public_card(db: Session, c: Coach) -> dict:
    """Juste l'essentiel: photo, nom, club(s), note."""
    from ..services.marketplace import coach_clubs
    if not c.join_token:
        c.join_token = secrets.token_urlsafe(12)
    return {"id": c.id, "name": c.name, "clubs": coach_clubs(db, c), "photo_url": photo_url(c),
            "join_path": f"/inscription/{c.join_token}"} | rating_of(db, c.id)


@router.get("/public/coaches")
def public_coaches(db: Session = Depends(get_db)):
    out = [_public_card(db, c) for c in db.scalars(select(Coach).order_by(Coach.name)) if _public(c)]
    db.commit()  # jetons d'inscription créés au besoin
    return sorted(out, key=lambda c: (-(c["rating"] or 0), -c["reviews_count"], c["name"]))


@router.get("/public/coaches/{coach_id}")
def public_coach(coach_id: int, db: Session = Depends(get_db)):
    """Page de présentation: photo, club, description, petite vidéo, avis."""
    c = db.get(Coach, coach_id)
    if not c or not _public(c):
        raise HTTPException(404, "Coach introuvable")
    out = _public_card(db, c) | {"bio": c.bio, "video_url": c.video_url or "", "youtube_id": youtube_id(c.video_url),
                                 "reviews": reviews_of(db, c.id)}
    db.commit()
    return out


@router.get("/public/coaches/{coach_id}/photo")
def coach_photo(coach_id: int, db: Session = Depends(get_db)):
    import base64
    c = db.get(Coach, coach_id)
    if not c or not c.photo or "," not in c.photo:
        raise HTTPException(404, "Pas de photo")
    head, data = c.photo.split(",", 1)
    return Response(base64.b64decode(data), media_type=head.removeprefix("data:").removesuffix(";base64"),
                    headers={"Cache-Control": "public, max-age=86400"})


# --- Liste d'attente ------------------------------------------------------------

@router.post("/me/sessions/{session_id}/waitlist")
def join_waitlist(session_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    from ..services.accounts import row_for_coach
    s = db.get(TrainingSession, session_id)
    if not s or s.status != "prevue" or aware(s.start) < datetime.now(timezone.utc):
        raise HTTPException(404, "Séance introuvable")
    coach = db.get(Coach, s.coach_id)
    row = row_for_coach(db, player, coach)
    if not db.scalar(select(Waitlist).where(Waitlist.session_id == s.id, Waitlist.player_id == row.id)):
        db.add(Waitlist(session_id=s.id, player_id=row.id))
    db.commit()
    return {"waitlisted": True}


@router.delete("/me/sessions/{session_id}/waitlist")
def leave_waitlist(session_id: int, player: Player = Depends(current_player), db: Session = Depends(get_db)):
    ids = {p.id for p in linked(db, player)}
    for w in db.scalars(select(Waitlist).where(Waitlist.session_id == session_id, Waitlist.player_id.in_(ids))):
        db.delete(w)
    db.commit()
    return {"waitlisted": False}


# --- Notifications du téléphone -------------------------------------------------

@router.get("/push/key")
def push_key(db: Session = Depends(get_db)):
    return {"key": push.keys(db)[1]}


class SubIn(BaseModel):
    endpoint: str
    keys: dict


@router.post("/push/subscribe")
def subscribe(body: SubIn, creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)):
    data = _decode(creds)
    if not push.allowed_endpoint(body.endpoint):
        raise HTTPException(422, "Adresse de notification non reconnue.")
    sub = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)) or PushSubscription(endpoint=body.endpoint)
    sub.p256dh, sub.auth = body.keys.get("p256dh", ""), body.keys.get("auth", "")
    if data.get("role") == "coach":
        sub.coach_id, sub.player_id = int(data["sub"]), None
    else:
        p = db.get(Player, int(data["sub"]))
        if not p:
            raise HTTPException(401, "Jeton invalide")
        sub.player_id, sub.coach_id = account_of(db, p).id, None
    db.add(sub)
    db.commit()
    return {"ok": True}


class UnsubIn(BaseModel):
    endpoint: str


@router.post("/push/unsubscribe")
def unsubscribe(body: UnsubIn, db: Session = Depends(get_db)):
    for s in db.scalars(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)):
        db.delete(s)
    db.commit()
    return {"ok": True}
