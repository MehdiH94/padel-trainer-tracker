import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_coach
from ..db import get_db
from ..constants import CAPACITY
from ..models import Attendance, Club, Coach, CoachEvent, CourtBooking, CourtExpense, Payment, Player, Proposal, TrainingSession
from ..schemas import PlayerPaymentOut, SessionIn, SessionOut, SessionPatch
from ..notify import letter
from ..services import booking as booking_svc
from ..services import courts
from ..services.accounts import has_account
from ..services import groups, isolation
from ..services import finance
from ..services.finance import session_payments, share
from ..services.pricing import MIN_PRICE, SESSION_DURATIONS, grid_price, is_vip
from ..services.common import aware, dinars, quand
from ..sms import get_sms_provider
from ..sms.base import SmsProvider
from .players import get_owned_player

router = APIRouter(prefix="/sessions", tags=["sessions"])


def invited_of(db: Session, s: TrainingSession) -> list[dict]:
    """Joueurs prévenus de cette séance qui n'y sont pas (encore): pas répondu (proposee) ou refusé."""
    inside = {a.player_id for a in s.attendances}
    out = []
    for p in db.scalars(select(Proposal).where(Proposal.session_id == s.id, Proposal.status.in_(("proposee", "refusee"))).order_by(Proposal.id)):
        if p.player_id not in inside:
            pl = db.get(Player, p.player_id)
            out.append({"player_id": p.player_id, "name": pl.name if pl else "?", "status": p.status})
    return out


def to_out(s: TrainingSession, court_status: str | None = None, paid: dict[tuple[int, int], int] | None = None,
           db: Session | None = None) -> SessionOut:
    out = SessionOut.model_validate(s)
    if db is not None and s.status == "prevue":
        out.invited = invited_of(db, s)
    out.player_ids = [a.player_id for a in s.attendances]
    out.court_status = court_status
    out.has_plan = bool(s.plan)
    out.min_players, out.max_players = groups.min_needed(s) if s.attendances else 1, groups.capacity(s)
    out.played_min = groups.played_minutes(s) if groups.is_dynamic(s) else s.duration_min
    out.feedback_missing = s.status == "effectuee" and any(not (a.worked_on or a.note or a.to_improve) for a in s.attendances)
    if s.status == "effectuee":  # ce que chaque joueur a réglé pour cette séance
        paid = paid or {}
        out.payments = [
            PlayerPaymentOut(
                player_id=a.player_id, due_millimes=share(s, i), credit_millimes=a.credit_paid_millimes,
                paid_millimes=paid.get((s.id, a.player_id), 0), refunded=bool(a.refunded),
            )
            for i, a in enumerate(s.attendances)
        ]
    return out


def get_owned_session(db: Session, coach: Coach, session_id: int) -> TrainingSession:
    s = db.get(TrainingSession, session_id)
    if not s or s.coach_id != coach.id:
        raise HTTPException(404, "Séance introuvable")
    return s


@router.get("", response_model=list[SessionOut])
def list_sessions(
    start: datetime | None = None,
    end: datetime | None = None,
    coach: Coach = Depends(current_coach),
    db: Session = Depends(get_db),
):
    booking_svc.complete_finished(db, coach.id)  # séances terminées: effectuées automatiquement
    q = select(TrainingSession).where(TrainingSession.coach_id == coach.id)
    if start:
        q = q.where(TrainingSession.start >= start)
    if end:
        q = q.where(TrainingSession.start < end)
    court = {cb.session_id: cb for cb in db.scalars(select(CourtBooking).where(CourtBooking.coach_id == coach.id, CourtBooking.session_id.is_not(None)))}
    paid = session_payments(db, coach.id)
    out = []
    for s in db.scalars(q.order_by(TrainingSession.start)):
        cb = court.get(s.id)
        o = to_out(s, cb.status if cb else None, paid, db)
        o.court = o.court or (cb.court_label if cb else "")  # terrain affiché sur le planning et l'accueil
        out.append(o)
    return out


@router.post("", response_model=list[SessionOut], status_code=201)
def create_sessions(
    body: SessionIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db), sms: SmsProvider = Depends(get_sms_provider)
):
    if body.price_mode not in ("par_joueur", "groupe"):
        raise HTTPException(422, "price_mode doit être par_joueur ou groupe")
    max_players = CAPACITY.get(body.kind)
    if body.kind not in ("individuel", "duo", "groupe"):
        raise HTTPException(422, "Type de séance invalide")
    if max_players and len(body.player_ids) > max_players:
        raise HTTPException(422, f"Une séance {body.kind} accepte {max_players} joueur(s) maximum")
    if not 1 <= body.repeat_weeks <= 52:
        raise HTTPException(422, "repeat_weeks doit être entre 1 et 52")
    if body.duration_min not in SESSION_DURATIONS:
        raise HTTPException(422, "Durée de la séance : 1 h ou 1 h 30.")
    for pid in body.player_ids:
        get_owned_player(db, coach, pid)
    invite_ids = [pid for pid in dict.fromkeys(body.invite_ids) if pid not in body.player_ids]
    for pid in invite_ids:
        get_owned_player(db, coach, pid)
    if invite_ids and body.repeat_weeks > 1:
        raise HTTPException(422, "Pour prévenir des joueurs, créez une seule séance (sans répétition).")
    if invite_ids and len(body.player_ids) >= (max_players or 4):
        raise HTTPException(422, "La séance est déjà complète : il n'y a plus de place pour les joueurs prévenus.")
    club = None
    if body.club_id:
        club = db.get(Club, body.club_id)
        if not club or club.coach_id != coach.id:
            raise HTTPException(404, "Club introuvable")
    rec = str(uuid.uuid4()) if body.repeat_weeks > 1 else None
    data = body.model_dump(exclude={"player_ids", "repeat_weeks", "start", "court_booked", "discount_pct", "discount_millimes"})
    if body.court_cost_millimes < 0:
        raise HTTPException(422, "Prix du terrain invalide.")
    data.pop("court_cost_millimes", None)
    data.pop("invite_message", None)
    data.pop("invite_ids", None)
    vip_price = None  # prix des joueurs VIP de la liste du coach (même réduction)
    if body.discount_millimes is not None or body.discount_pct is not None:
        # prix par joueur fixé dans Réglages › Formules pour cette formule et cette durée, tel quel (pas de prorata)
        grid = grid_price(coach, body.kind, body.duration_min)
        vgrid = grid_price(coach, body.kind, body.duration_min, vip=True)
        if grid is None:
            label = {"individuel": "seul", "duo": "à deux", "groupe": "en groupe"}[body.kind]
            raise HTTPException(422, f"Vous n'avez pas fixé le prix d'une séance {label} de {'1 h 30' if body.duration_min == 90 else '1 h'} : "
                                     "Réglages › Formules.")
        if body.discount_millimes is not None:  # moins une réduction en dinars
            if body.discount_millimes < 0:
                raise HTTPException(422, "Réduction invalide.")
            data["price_millimes"] = max(grid - body.discount_millimes, 0)
            vip_price = max((vgrid or grid) - body.discount_millimes, 0)
        else:  # ancien fonctionnement: promotion en %
            if not 0 <= body.discount_pct <= 90:
                raise HTTPException(422, "Promotion : entre 0 et 90 %.")
            data["price_millimes"] = round(grid * (100 - body.discount_pct) / 100)
            vip_price = round((vgrid or grid) * (100 - body.discount_pct) / 100)
        data["price_mode"] = "par_joueur"
    if "price_millimes" in data and data.get("price_mode") == "par_joueur" and (body.discount_millimes is not None or body.discount_pct is not None) \
            and data["price_millimes"] < MIN_PRICE:
        raise HTTPException(422, "Le prix d'une séance ne peut pas être inférieur à 20 TND : choisissez une réduction plus petite.")
    if invite_ids:
        data["open"] = True  # les joueurs prévenus pourront accepter la proposition
    if club:
        data["club"] = club.name
    # Le coach ne peut pas être à deux séances en même temps (ni un joueur)
    taken = [x for x in db.scalars(select(TrainingSession).where(TrainingSession.coach_id == coach.id, TrainingSession.status != "annulee"))]
    for i in range(body.repeat_weeks):
        start = aware(body.start) + timedelta(weeks=i)
        end = start + timedelta(minutes=body.duration_min)
        clash = next((x for x in taken if aware(x.start) < end and start < aware(x.start) + timedelta(minutes=x.duration_min)), None)
        if clash:
            who = [db.get(Player, a.player_id).name for a in clash.attendances]
            raise HTTPException(409, f"Vous avez déjà une séance à ce moment-là ({quand(clash.start, clash.duration_min)}"
                                     f"{', avec ' + ', '.join(who) if who else ''}). Choisissez une autre heure.")
        event = next((e for e in db.scalars(select(CoachEvent).where(CoachEvent.coach_id == coach.id))
                      if aware(e.start) < end and start < aware(e.start) + timedelta(minutes=e.duration_min)), None)
        if event:
            raise HTTPException(409, f"Vous avez « {event.title} » à ce moment-là ({quand(event.start, event.duration_min)}). Choisissez une autre heure.")
    created = []
    for i in range(body.repeat_weeks):
        s = TrainingSession(
            coach_id=coach.id, start=body.start + timedelta(weeks=i), recurrence_id=rec, **data
        )
        s.attendances = [Attendance(player_id=pid, price_millimes=vip_price if vip_price is not None and vip_price < s.price_millimes
                                    and is_vip(db, coach, db.get(Player, pid)) else None) for pid in body.player_ids]
        db.add(s)
        created.append(s)
    db.flush()
    # Un coach n'a qu'un terrain à la fois: si un de ses terrains libres couvre le créneau, la séance a lieu là
    # (même si un autre club était choisi); sinon on ne demande pas un second terrain à la même heure.
    for s in created:
        held = courts.held_covering(db, coach, s.start, s.duration_min, merge=True)
        if held:
            cb = next((c for c in held if club and c.club_id == club.id), held[0])
            courts.take_part(db, cb, s)
            s.club, s.club_id = db.get(Club, cb.club_id).name, cb.club_id
            s.court = s.court or cb.court_label
        elif club:
            busy = courts.overlapping(db, coach, s.start, s.duration_min)
            if busy:
                raise HTTPException(409, courts.busy_message(db, busy[0]))
            courts.create_for_session(db, coach, club, s, already_booked=body.court_booked)
            if body.court_booked and body.court_cost_millimes:  # prix payé au club: déduit des revenus (Finance)
                db.add(CourtExpense(coach_id=coach.id, club_id=club.id, start=s.start, duration_min=s.duration_min,
                                    amount_millimes=body.court_cost_millimes, series_id=rec))
    if invite_ids:  # joueurs prévenus: proposition dans leur appli + e-mail; la séance montre qui n'a pas répondu
        s = created[0]
        chosen = [db.get(Player, pid) for pid in invite_ids]
        db.add_all(Proposal(coach_id=coach.id, session_id=s.id, player_id=p.id) for p in chosen)
        message = body.invite_message.strip() or new_session_invite(coach, s)
        booking_svc.notify(db, chosen, "Une séance de padel pour vous", lambda _p: message, "invitation")
    db.commit()
    if club:
        courts.send_due(db, coach, sms)  # envoie tout de suite celles qui ont lieu dans les 7 jours
    court = {cb.session_id: cb.status for cb in db.scalars(select(CourtBooking).where(CourtBooking.coach_id == coach.id))}
    return [to_out(s, court.get(s.id), None, db) for s in created]


@router.patch("/{session_id}", response_model=SessionOut)
def patch_session(
    session_id: int, body: SessionPatch, coach: Coach = Depends(current_coach), db: Session = Depends(get_db),
    sms: SmsProvider = Depends(get_sms_provider),
):
    s = get_owned_session(db, coach, session_id)
    if body.status is not None:
        if body.status not in ("prevue", "effectuee", "annulee"):
            raise HTTPException(422, "Statut invalide")
        past = aware(s.start) + timedelta(minutes=s.duration_min) <= datetime.now(timezone.utc)
        if s.status == "effectuee" and body.status != "effectuee":
            # Séance passée finalement pas faite (effectuée automatiquement): on peut l'annuler, crédits rendus,
            # tant qu'aucun paiement n'a été encaissé pour elle
            if db.scalar(select(Payment.id).where(Payment.session_id == s.id).limit(1)):
                raise HTTPException(409, "Un paiement a été encaissé pour cette séance : elle ne peut plus être annulée.")
            finance.unsettle(db, s)  # crédits débités pour cette séance rendus
        if body.status == "annulee" and s.status != "annulee":
            booking_svc.coach_cancel_session(db, s, tell=not past)  # réservations payées en crédits: remboursement
            if not past:
                courts.release_or_cancel(db, coach, s, sms)  # terrain manuel libéré, club prévenu sinon
        was = s.status
        s.status = body.status
        if body.status == "effectuee" and was != "effectuee":
            db.flush()
            finance.settle(db, coach.id, [a.player_id for a in s.attendances])  # payée avec les crédits disponibles
    if body.start is not None:  # report
        s.start = body.start
    db.commit()
    cb = db.scalar(select(CourtBooking).where(CourtBooking.session_id == s.id))
    return to_out(s, cb.status if cb else None, session_payments(db, coach.id), db)


class AddPlayerIn(BaseModel):
    player_id: int


@router.post("/{session_id}/players", response_model=SessionOut)
def add_player(session_id: int, body: AddPlayerIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Le coach ajoute un joueur à une séance prévue (depuis la fiche du joueur)."""
    s = get_owned_session(db, coach, session_id)
    get_owned_player(db, coach, body.player_id)
    if s.status != "prevue":
        raise HTTPException(409, "On ne peut ajouter un joueur qu'à une séance prévue")
    if body.player_id in [a.player_id for a in s.attendances]:
        raise HTTPException(409, "Ce joueur participe déjà à cette séance")
    if len(s.attendances) >= groups.capacity(s):
        raise HTTPException(409, "Cette séance est complète")
    p = db.get(Player, body.player_id)
    own = None
    if s.price_mode == "par_joueur" and is_vip(db, coach, p):  # joueur VIP: jamais plus que son prix VIP
        v = grid_price(coach, s.kind, s.duration_min, vip=True)
        own = v if v is not None and v < s.price_millimes else None
    s.attendances.append(Attendance(player_id=body.player_id, price_millimes=own))
    db.commit()
    cb = db.scalar(select(CourtBooking).where(CourtBooking.session_id == s.id))
    return to_out(s, cb.status if cb else None, session_payments(db, coach.id), db)


# --- Le coach invite ses joueurs à rejoindre une séance -------------------------

@router.get("/{session_id}/invitable")
def invitable(session_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Joueurs du coach de niveau compatible avec tous les inscrits (ceux déjà entraînés chez lui en premier)."""
    s = get_owned_session(db, coach, session_id)
    trained = set(db.scalars(select(Attendance.player_id).join(TrainingSession, TrainingSession.id == Attendance.session_id)
                             .where(TrainingSession.coach_id == coach.id, TrainingSession.status == "effectuee")))
    inside = {a.player_id for a in s.attendances}
    out = []
    for p in db.scalars(select(Player).where(Player.coach_id == coach.id).order_by(Player.name)):
        if p.id not in inside and isolation.same_world(db, coach, p) and booking_svc.fits_session(db, p, s)[0]:
            out.append({"id": p.id, "name": p.name, "category": p.category, "gender": p.gender, "has_account": has_account(p),
                        "contact_channel": p.contact_channel or "sms", "trained": p.id in trained})
    out.sort(key=lambda x: (not x["trained"], not x["has_account"]))  # déjà entraînés chez lui d'abord
    return {"players": out, "spots_left": booking_svc.spots_left(db, s), "message": default_invite(coach, s)}


def new_session_invite(coach: Coach, s: TrainingSession) -> str:
    """Message aux joueurs prévenus d'une nouvelle séance (ils répondent dans l'application)."""
    what = {"duo": " à deux", "groupe": " en groupe"}.get(s.kind, "")
    return letter(None, f"Je vous propose une séance de padel{what} :", booking_svc._details(s),
                  "Pour l'accepter ou la refuser, ouvrez l'application : la proposition est sur votre page d'accueil.", sign=coach.name)


def default_invite(coach: Coach, s: TrainingSession) -> str:
    what = {"duo": " à deux", "groupe": " en groupe"}.get(s.kind, "")
    return letter(None, f"Il reste de la place dans une séance de padel{what} :", booking_svc._details(s),
                  "Pour la rejoindre, ouvrez l'application : la proposition est sur votre page d'accueil.", sign=coach.name)


class InviteIn(BaseModel):
    player_ids: list[int]
    message: str = ""


@router.post("/{session_id}/refund/{player_id}", response_model=SessionOut)
def refund_absent(session_id: int, player_id: int, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Joueur absent d'une séance effectuée: le coach peut le rembourser, toujours en entier (crédits rendus)."""
    s = get_owned_session(db, coach, session_id)
    if s.status != "effectuee":
        raise HTTPException(409, "Seule une séance effectuée peut être remboursée à un absent.")
    a = next((x for x in s.attendances if x.player_id == player_id), None)
    if not a:
        raise HTTPException(404, "Ce joueur n'est pas dans cette séance")
    if a.refunded:
        raise HTTPException(409, "Ce joueur a déjà été remboursé pour cette séance.")
    amount = finance.refund_absent(db, s, a)
    p = db.get(Player, player_id)
    booking_svc.notify(db, [p], "Séance remboursée", lambda pl: letter(
        pl.name, f"Vous n'avez pas pu venir à la séance du {quand(s.start, s.duration_min)} : {coach.name} vous la rembourse."
        + (f" {dinars(amount)} ont été ajoutés à vos crédits." if amount else ""), sign=coach.name))
    db.commit()
    return to_out(s, None, session_payments(db, coach.id))


@router.post("/{session_id}/invite")
def invite_players(session_id: int, body: InviteIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Notifie les joueurs cochés et leur fait une proposition (acceptable dans leur appli)."""
    s = get_owned_session(db, coach, session_id)
    allowed_ids = {p["id"] for p in invitable(session_id, coach, db)["players"]}
    chosen = [db.get(Player, pid) for pid in body.player_ids if pid in allowed_ids]
    for p in chosen:
        if not db.scalar(select(Proposal).where(Proposal.session_id == s.id, Proposal.player_id == p.id, Proposal.status == "proposee")):
            db.add(Proposal(coach_id=coach.id, session_id=s.id, player_id=p.id))
    if chosen and groups.capacity(s) > len(s.attendances):
        s.open = True  # les joueurs invités pourront accepter la proposition
    message = body.message.strip() or default_invite(coach, s)
    sent = booking_svc.notify(db, chosen, "Une place pour vous dans une séance de padel", lambda _p: message, "invitation")
    db.commit()
    return {"sent": sent}


# --- Séance incomplète: le coach écrit aux inscrits (« partants à deux ? »), avec une remise facultative ----------

def default_low_message(coach: Coach, s: TrainingSession, off: int = 0) -> str:
    n = len(s.attendances)
    what = "à deux" if n == 2 else "seul avec moi" if n == 1 else f"à {n}"
    promo = f"Pour vous remercier, je vous fais -{dinars(off)} sur cette séance." if off else ""
    return letter(None, "Malheureusement, nous n'arrivons pas à compléter cette séance :", booking_svc._details(s),
                  f"Est-ce que ça vous intéresse quand même de vous entraîner {what} ? {promo}".strip(),
                  "Répondez-moi, ou changez de formule dans l'application (sur votre séance).", sign=coach.name)


@router.get("/{session_id}/message")
def message_preview(session_id: int, discount_millimes: int = 0, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Inscrits de la séance et message proposé."""
    s = get_owned_session(db, coach, session_id)
    players = [db.get(Player, a.player_id) for a in s.attendances]
    return {"players": [{"id": p.id, "name": p.name, "category": p.category, "gender": p.gender, "has_account": has_account(p)} for p in players],
            "message": default_low_message(coach, s, discount_millimes), "min_players": groups.min_needed(s)}


class LowIn(BaseModel):
    player_ids: list[int]
    message: str = ""
    discount_millimes: int = 0  # réduction par joueur sur la séance, en millimes (0 = aucune)


@router.post("/{session_id}/message")
def message_players(session_id: int, body: LowIn, coach: Coach = Depends(current_coach), db: Session = Depends(get_db)):
    """Écrit aux inscrits choisis. Avec une remise: le prix de chacun baisse (crédits déjà débités: la différence est rendue)."""
    from ..models import Booking
    s = get_owned_session(db, coach, session_id)
    if body.discount_millimes < 0:
        raise HTTPException(422, "Réduction invalide.")
    inside = {a.player_id for a in s.attendances}
    chosen = [db.get(Player, pid) for pid in body.player_ids if pid in inside]
    if body.discount_millimes:
        for b in db.scalars(select(Booking).where(Booking.session_id == s.id, Booking.status.in_(booking_svc.ACTIVE))):
            if body.discount_millimes > (b.discount_millimes or 0):
                b.discount_pct, b.discount_millimes = 0, body.discount_millimes
                booking_svc._reprice(db, coach, s, b)
        if s.price_mode == "par_joueur":  # séance montée par le coach: prix par joueur
            ref = grid_price(coach, s.kind, s.duration_min) or s.price_millimes  # prix des réglages, sans prorata
            s.price_millimes = min(s.price_millimes, max(ref - body.discount_millimes, 0))
    message = body.message.strip() or default_low_message(coach, s, body.discount_millimes)
    sent = booking_svc.notify(db, chosen, "Votre séance de padel", lambda _p: message)
    db.commit()
    return {"sent": sent}
