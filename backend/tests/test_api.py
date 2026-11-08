from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import db as dbmod
from app.main import app
from app.services.courts import parse_reply
from app.sms.fake import FakeSmsProvider

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestSession = sessionmaker(bind=engine, autoflush=False)


def _db():
    d = TestSession()
    try:
        yield d
    finally:
        d.close()


def login_as(c, token):
    c.headers["Authorization"] = f"Bearer {token}"
    return c


def confirm_coach(boss, email):
    """L'administrateur confirme un coach inscrit lui-même (en attente dès qu'il y a un administrateur)."""
    cid = next(c["id"] for c in boss.get("/admin/coach-signups").json() if c["email"] == email)
    assert boss.post(f"/admin/coach-signups/{cid}/validate").json()["status"] == "validee"


def register(email="a@b.tn"):
    c = TestClient(app)
    r = c.post("/auth/register", json={"email": email, "password": "secret1", "name": "Coach Test"}).json()
    return login_as(c, r["token"])


@pytest.fixture
def client():
    dbmod.Base.metadata.drop_all(engine)
    dbmod.Base.metadata.create_all(engine)
    app.dependency_overrides[dbmod.get_db] = _db
    FakeSmsProvider.sent.clear()
    yield register()
    app.dependency_overrides.clear()


_phones = iter(range(30000000, 39999999))


def mkplayer(c, phone=None, name="Sami", **extra):
    """Sans numéro précisé: 22 123 456 pour le premier joueur du coach, puis un numéro libre (un numéro par joueur)."""
    if phone is None:
        taken = {x["phone"] for x in c.get("/players").json()}
        phone = "22 123 456" if "+21622123456" not in taken else str(next(_phones))
    return c.post("/players", json={"name": name, "phone": phone, **extra}).json()


def open_week(c, auto_confirm=True):
    """Disponible tous les jours de 9h à 21h, créneaux d'1h. Prix: 60 / 40 / 30 TND par joueur."""
    c.put("/booking/settings", json={
        "auto_confirm": auto_confirm, "slot_minutes": 60, "price_individuel": 60000, "price_duo": 40000, "price_groupe": 30000,
        "cancel_hours": 24, "availability": [{"weekday": d, "start_time": "09:00", "end_time": "21:00"} for d in range(7)],
        "booking_mode": "disponibilites",
    })


def mkclub(c, **extra):
    return c.post("/clubs", json={"name": "Padel Club La Marsa", "phone": "71 123 456", **extra}).json()


def free_court(c, start, minutes=120, club=None):
    """Terrain réservé à la main, libre, qui couvre [start, start+minutes]."""
    club = club or mkclub(c)
    return c.post("/court-bookings/manual", json={"club_id": club["id"], "start": start, "duration_min": minutes, "court_label": "Terrain 2"}).json()


def player_client(c, **extra):
    """Crée un joueur, l'invite et retourne (player, client connecté en tant que joueur)."""
    p = mkplayer(c, **extra)
    token = c.post(f"/players/{p['id']}/invite").json()["token"]
    pc = TestClient(app)
    r = pc.post(f"/auth/invite/{token}", json={"email": f"p{p['id']}@x.tn", "password": "secret1"}).json()
    assert r["role"] == "player"
    return p, login_as(pc, r["token"])


# --- Base ---------------------------------------------------------------

def test_phone_normalised_and_validated(client):
    assert mkplayer(client)["phone"] == "+21622123456"
    assert client.post("/players", json={"name": "X", "phone": "123"}).status_code == 422


def test_auth_required(client):
    assert TestClient(app).get("/players").status_code == 401


def test_recurring_sessions(client):
    r = client.post("/sessions", json={"start": "2026-11-03T17:00:00Z", "repeat_weeks": 4})
    assert len(r.json()) == 4
    assert len({s["recurrence_id"] for s in r.json()}) == 1


def test_player_limit_per_kind(client):
    ids = [mkplayer(client, name=n)["id"] for n in "AB"]
    assert client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "kind": "individuel", "player_ids": ids}).status_code == 422
    assert client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "kind": "duo", "player_ids": ids}).status_code == 201


def test_group_price_is_split(client):
    ids = [mkplayer(client, name=n)["id"] for n in "ABC"]
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "kind": "groupe", "player_ids": ids, "price_millimes": 100000, "price_mode": "groupe"}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    unpaid = sorted(u["amount_millimes"] for u in client.get("/dashboard").json()["unpaid"])
    assert unpaid == [33333, 33333, 33334]


def test_unpaid_then_paid(client):
    p = mkplayer(client)
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "player_ids": [p["id"]], "price_millimes": 60000}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    assert client.get("/dashboard").json()["unpaid"][0]["amount_millimes"] == 60000
    client.post("/payments", json={"player_id": p["id"], "amount_millimes": 60000})
    assert client.get("/dashboard").json()["unpaid"] == []


def test_coach_isolation(client):
    p = mkplayer(client)
    other = register("c@d.tn")
    assert other.get("/players").json() == []
    assert other.get(f"/players/{p['id']}/profile").status_code == 404
    assert other.post(f"/players/{p['id']}/credits", json={"amount_millimes": 1000}).status_code == 404


def test_player_profile(client):
    p = mkplayer(client)
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "player_ids": [p["id"]], "price_millimes": 60000}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    client.put(f"/sessions/{s['id']}/feedback/{p['id']}", json={"worked_on": ["Bandeja", "Volée"], "note": "Bien", "to_improve": "Placement"})
    for stroke, score in [("Bandeja", 2), ("Bandeja", 3), ("Service", 5), ("Smash", 1)]:
        assert client.post(f"/players/{p['id']}/skills", json={"stroke": stroke, "score": score}).status_code == 201
    client.post("/payments", json={"player_id": p["id"], "amount_millimes": 20000})
    prof = client.get(f"/players/{p['id']}/profile").json()
    assert prof["finance"]["due_millimes"] == 40000
    assert prof["last_session"]["worked_on"] == ["Bandeja", "Volée"]
    bandeja = next(s for s in prof["skills"] if s["stroke"] == "Bandeja")
    assert (bandeja["score"], bandeja["previous"]) == (6.0, 4.0)  # anciennes notes sur 5 ramenées sur 10
    assert prof["strengths"] == ["Service"] and prof["weaknesses"] == ["Smash"]


# --- Comptes joueurs ----------------------------------------------------

def test_invite_flow_and_roles(client):
    p = mkplayer(client)
    assert client.get("/players").json()[0]["has_account"] is False
    token = client.post(f"/players/{p['id']}/invite").json()["token"]
    anon = TestClient(app)
    assert anon.get(f"/auth/invite/{token}").json()["player_name"] == "Sami"
    assert anon.post(f"/auth/invite/{token}", json={"email": "sami@x.tn", "password": "123"}).status_code == 422  # trop court
    r = anon.post(f"/auth/invite/{token}", json={"email": "Sami@X.tn", "password": "secret1"}).json()
    assert r["role"] == "player"
    assert anon.get(f"/auth/invite/{token}").status_code == 404  # lien à usage unique
    assert client.get("/players").json()[0]["has_account"] is True
    assert client.post(f"/players/{p['id']}/invite").status_code == 409
    again = TestClient(app).post("/auth/login", json={"email": "sami@x.tn", "password": "secret1"}).json()
    assert again["role"] == "player"
    # un joueur n'accède pas aux routes du coach, et inversement
    pc = login_as(TestClient(app), again["token"])
    assert pc.get("/players").status_code == 401
    assert client.get("/me").status_code == 401


# --- Crédits et réservation --------------------------------------------

def book_new(pc, kind="individuel", index=0):
    slot = pc.get("/me/slots").json()[index]
    return slot, pc.post("/me/book", json={"kind": kind, "start": slot})


def test_booking_auto_confirmed_when_a_court_is_free(client):
    open_week(client)
    p, pc = player_client(client)
    slot = pc.get("/me/slots").json()[0]
    free_court(client, slot)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 150000, "method": "especes"})
    r = pc.post("/me/book", json={"kind": "individuel", "start": slot})
    assert r.status_code == 201 and r.json()["status"] == "confirmee" and r.json()["credits_millimes"] == 90000
    s = client.get("/sessions").json()[0]
    assert s["player_ids"] == [p["id"]] and s["club"] == "Padel Club La Marsa" and s["open"] is False
    assert client.get("/court-bookings").json()[0]["free"] is False  # le terrain est attribué
    # confirmée: le joueur reçoit l'e-mail de confirmation, le coach n'a plus rien à envoyer
    from app.notify import OUTBOX
    assert any(to == f"p{p['id']}@x.tn" and "confirmée" in subj for to, subj, _ in OUTBOX)
    assert client.get("/booking/requests").json() == []
    # séance payée en crédits: rien à facturer
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    assert client.get("/dashboard").json()["unpaid"] == []
    prof = client.get(f"/players/{p['id']}/profile").json()["finance"]
    assert prof["due_millimes"] == 0 and prof["credits_balance_millimes"] == 90000


def test_no_court_request_waits_for_coach_then_court_confirmed(client):
    open_week(client, auto_confirm=False)
    club = mkclub(client)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 60000})
    _, r = book_new(pc)
    assert r.json()["status"] == "en_attente" and pc.get("/me").json()["credits_millimes"] == 60000  # débité à la validation
    req = client.get("/booking/requests").json()[0]
    assert req["courts_available"] == [] and req["name"] == "Sami"
    assert client.get("/booking/summary").json() == {"pending": 1, "waiting_court": 0, "to_notify": 0, "waiting_players": 0}
    # le coach accepte en attendant le terrain: SMS au club
    out = client.post(f"/booking/requests/{req['id']}/accept", json={"club_id": club["id"]}).json()
    assert out["status"] == "acceptee" and pc.get("/me").json()["credits_millimes"] == 0
    assert FakeSmsProvider.sent[-1][0] == "+21671123456"
    assert client.get("/booking/summary").json() == {"pending": 0, "waiting_court": 1, "to_notify": 0, "waiting_players": 0}
    cb = client.get("/court-bookings").json()[0]
    assert cb["status"] == "en_attente" and cb["players"] == ["Sami"]
    # le club confirme: la réservation devient « confirmée », le joueur est prévenu par e-mail
    from app.notify import OUTBOX
    OUTBOX.clear()
    client.post(f"/court-bookings/{cb['id']}/reply", json={"text": "OUI c'est bon"})
    assert client.get("/booking/summary").json() == {"pending": 0, "waiting_court": 0, "to_notify": 0, "waiting_players": 0}
    assert [subj for _, subj, _ in OUTBOX] == ["Votre séance de padel est confirmée"]


def test_pending_request_shows_free_court_and_accepts_with_it(client):
    open_week(client, auto_confirm=False)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 60000})
    slot = pc.get("/me/slots").json()[0]
    court = free_court(client, slot)
    assert pc.post("/me/book", json={"kind": "individuel", "start": slot}).json()["status"] == "en_attente"  # auto désactivé
    req = client.get("/booking/requests").json()[0]
    assert [c["id"] for c in req["courts_available"]] == [court["id"]]
    assert client.post(f"/booking/requests/{req['id']}/accept", json={"court_booking_id": court["id"]}).json()["status"] == "confirmee"
    assert client.get("/court-bookings").json()[0]["free"] is False
    # le même terrain ne peut pas servir deux fois
    p2, pc2 = player_client(client, name="B", phone="20222222")
    client.post(f"/players/{p2['id']}/credits", json={"amount_millimes": 60000})
    slot2 = pc2.get("/me/slots").json()[0]
    pc2.post("/me/book", json={"kind": "individuel", "start": slot2})
    req2 = next(r for r in client.get("/booking/requests").json() if r["status"] == "en_attente")
    assert client.post(f"/booking/requests/{req2['id']}/accept", json={"court_booking_id": court["id"]}).status_code == 409


def test_double_booking_prevented(client):
    open_week(client)
    p1, c1 = player_client(client, name="A", phone="20111111")
    p2, c2 = player_client(client, name="B", phone="20222222")
    for p in (p1, p2):
        client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 60000})
    slot = c1.get("/me/slots").json()[0]
    r1 = c1.post("/me/book", json={"kind": "individuel", "start": slot})
    assert r1.status_code == 201
    # une demande pas encore traitée ne bloque pas le créneau: le coach voit les deux ensemble et choisit
    r2 = c2.post("/me/book", json={"kind": "individuel", "start": slot})
    assert r2.status_code == 201
    assert client.post(f"/booking/requests/{r1.json()['id']}/accept", json={}).status_code == 200
    r = client.post(f"/booking/requests/{r2.json()['id']}/accept", json={})
    assert r.status_code == 409 and "déjà pris" in r.json()["detail"]  # deux joueurs seuls: jamais en même temps


def test_refusal_refunds(client):
    open_week(client, auto_confirm=False)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 60000})
    book_new(pc)
    req = client.get("/booking/requests").json()[0]
    client.post(f"/booking/requests/{req['id']}/refuse")
    assert pc.get("/me").json()["credits_millimes"] == 60000
    assert client.get("/sessions").json() == []


def test_cancellation_policy(client):
    open_week(client)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 120000})
    slots = pc.get("/me/slots").json()
    far = next(s for s in slots if datetime.fromisoformat(s) > datetime.now(timezone.utc) + timedelta(hours=30))
    near = next(s for s in slots if datetime.fromisoformat(s) < datetime.now(timezone.utc) + timedelta(hours=23))
    for s in (far, near):
        free_court(client, s)
    far_id = pc.post("/me/book", json={"kind": "individuel", "start": far}).json()["id"]
    near_id = pc.post("/me/book", json={"kind": "individuel", "start": near}).json()["id"]
    assert pc.get("/me").json()["credits_millimes"] == 0
    assert pc.post(f"/me/bookings/{far_id}/cancel").json()["refunded"] is True
    assert pc.get("/me").json()["credits_millimes"] == 60000
    # moins de 24 h avant une séance seul: annulation impossible, il peut se faire remplacer
    r = pc.post(f"/me/bookings/{near_id}/cancel")
    assert r.status_code == 409 and "remplacer" in r.json()["detail"]
    near_item = next(x for x in pc.get("/me/sessions").json()["upcoming"] if x["booking_id"] == near_id)
    assert near_item["can_cancel"] is False
    assert pc.get("/me").json()["credits_millimes"] == 60000
    assert pc.post(f"/me/bookings/{far_id}/cancel").status_code == 409  # déjà annulée
    assert sum(not c["free"] for c in client.get("/court-bookings").json()) == 1  # seul le terrain de la séance maintenue est pris


def test_coach_cancelling_booked_session_refunds(client):
    open_week(client)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 60000})
    slot = pc.get("/me/slots").json()[0]
    free_court(client, slot)
    pc.post("/me/book", json={"kind": "individuel", "start": slot})
    sid = client.get("/sessions").json()[0]["id"]
    client.patch(f"/sessions/{sid}", json={"status": "annulee"})
    assert pc.get("/me").json()["credits_millimes"] == 60000
    assert client.get("/court-bookings").json()[0]["free"] is True


def test_player_sees_history_and_progress(client):
    p, pc = player_client(client)
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "player_ids": [p["id"]]}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    client.put(f"/sessions/{s['id']}/feedback/{p['id']}", json={"worked_on": ["Service"], "note": "Top", "to_improve": ""})
    client.post(f"/players/{p['id']}/skills", json={"stroke": "Lob", "score": 5})
    assert pc.get("/me/sessions").json()["history"][0]["note"] == "Top"
    prog = pc.get("/me/progress").json()
    assert prog["strengths"] == ["Lob"] and "finance" not in prog


# --- Classement, suggestions et groupes ----------------------------------

def open_duo(client, host, hours=48, **extra):
    start = (datetime.now(timezone.utc) + timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)
    return client.post("/sessions", json={"start": start.isoformat(), "kind": "duo", "open": True, "player_ids": [host["id"]], "price_millimes": 40000, **extra}).json()[0]


def test_ranking_validation(client):
    p = client.post("/players", json={"name": "Lina", "phone": "22123456", "gender": "F", "category": "P250"}).json()
    assert (p["gender"], p["category"]) == ("F", "P250-")  # ancien code sans +/- -> bas de la tranche
    assert client.post("/players", json={"name": "X", "phone": "22123456", "category": "P999"}).status_code == 422
    assert client.post("/players", json={"name": "X", "phone": "22123456", "gender": "Z"}).status_code == 422


def test_suggestions_rank_by_level_and_type(client):
    open_week(client)
    host = mkplayer(client, name="Host", category="P100")
    s = open_duo(client, host)
    _, near = player_client(client, name="Near", phone="20111111", category="P100+")
    _, far = player_client(client, name="Far", phone="20222222", category="P1000")
    sug = near.get("/me/suggestions", params={"kinds": "duo"}).json()
    assert [x["session_id"] for x in sug] == [s["id"]] and sug[0]["match"] == "ideal" and sug[0]["spots_left"] == 1
    # formule non choisie (seul): la séance de duo n'est pas proposée
    assert near.get("/me/suggestions", params={"kinds": "individuel"}).json() == []
    assert far.get("/me/suggestions").json() == []  # P1000 trop éloigné de P100
    assert near.get("/me").json()["pref_kinds"] == ["individuel"]  # préférences mémorisées


def test_join_open_session(client):
    open_week(client)
    host = mkplayer(client, name="Host")
    s = open_duo(client, host)
    p, pc = player_client(client, name="Joiner", phone="20111111")
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 100000})
    r = pc.post("/me/book", json={"session_id": s["id"]})
    assert r.status_code == 201 and r.json()["status"] == "confirmee" and r.json()["credits_millimes"] == 60000
    assert sorted(client.get("/sessions").json()[0]["player_ids"]) == sorted([host["id"], p["id"]])
    p2, pc2 = player_client(client, name="Late", phone="20222222")
    client.post(f"/players/{p2['id']}/credits", json={"amount_millimes": 100000})
    assert pc2.post("/me/book", json={"session_id": s["id"]}).status_code == 409  # complète
    assert pc.post("/me/book", json={"session_id": s["id"]}).status_code == 409  # déjà inscrit
    # l'hôte (payant à la séance) reste facturé, pas le joueur prépayé
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    unpaid = {u["name"]: u["amount_millimes"] for u in client.get("/dashboard").json()["unpaid"]}
    assert unpaid == {"Host": 40000}


def test_join_waits_for_coach_when_manual(client):
    open_week(client, auto_confirm=False)
    host = mkplayer(client, name="Host")
    s = open_duo(client, host)
    p, pc = player_client(client, name="Joiner", phone="20111111")
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 40000})
    assert pc.post("/me/book", json={"session_id": s["id"]}).json()["status"] == "en_attente"
    assert len(client.get("/sessions").json()[0]["player_ids"]) == 1
    req = client.get("/booking/requests").json()[0]
    assert req["join"] is True and req["partners"] == ["Host"]
    assert client.post(f"/booking/requests/{req['id']}/accept", json={}).json()["status"] == "confirmee"  # séance sans suivi de terrain
    assert len(client.get("/sessions").json()[0]["player_ids"]) == 2


def test_coach_groups_and_proposals(client):
    open_week(client)
    host = mkplayer(client, name="Host", category="P100")
    s = open_duo(client, host)
    p, pc = player_client(client, name="Cand", phone="20111111", category="P100")
    mkplayer(client, name="Wrong", phone="20333333", category="P1000")
    g = client.get("/groups").json()
    assert [c["name"] for c in g[0]["candidates"]] == ["Cand"] and g[0]["spots_left"] == 1
    assert client.post("/proposals", json={"session_id": s["id"], "player_id": p["id"]}).status_code == 201
    assert client.post("/proposals", json={"session_id": s["id"], "player_id": p["id"]}).status_code == 409
    prop = pc.get("/me/proposals").json()
    assert len(prop) == 1 and prop[0]["partners"][0]["name"] == "Host"
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 40000})
    r = pc.post(f"/me/proposals/{prop[0]['id']}/accept")
    assert r.status_code == 200 and r.json()["status"] == "confirmee"
    assert pc.get("/me/proposals").json() == []
    assert client.get("/groups").json() == []  # séance complète


def test_declined_proposal_disappears(client):
    host = mkplayer(client, name="Host")
    s = open_duo(client, host)
    p, pc = player_client(client, name="Cand", phone="20111111")
    client.post("/proposals", json={"session_id": s["id"], "player_id": p["id"]})
    pid = pc.get("/me/proposals").json()[0]["id"]
    pc.post(f"/me/proposals/{pid}/decline")
    assert pc.get("/me/proposals").json() == []


# --- Terrains réservés à la main -----------------------------------------

def test_manual_courts_crud_and_session_with_booked_court(client):
    club = mkclub(client)
    start = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    c = free_court(client, start, 90, club)
    assert c["status"] == "confirmee" and c["free"] is True and c["court_label"] == "Terrain 2"
    assert client.delete(f"/court-bookings/{c['id']}").status_code == 200
    assert client.get("/court-bookings").json() == []
    # séance avec « terrain déjà réservé »: confirmé tout de suite, aucun SMS
    n = len(FakeSmsProvider.sent)
    s = client.post("/sessions", json={"start": start, "club_id": club["id"], "court_booked": True, "court": "Terrain 1"}).json()[0]
    assert s["court_status"] == "confirmee" and len(FakeSmsProvider.sent) == n
    cb = client.get("/court-bookings").json()[0]
    assert cb["source"] == "manuel" and cb["free"] is False
    assert client.delete(f"/court-bookings/{cb['id']}").status_code == 409  # lié à une séance


# --- Réservation des terrains par SMS ----------------------------------

def mkclub(c, **extra):
    return c.post("/clubs", json={"name": "Padel Club La Marsa", "phone": "71 123 456", **extra}).json()


def test_court_sms_sent_when_session_created(client):
    club = mkclub(client)
    p = mkplayer(client)
    start = (datetime.now(timezone.utc) + timedelta(days=2)).replace(hour=17, minute=0, second=0, microsecond=0)
    s = client.post("/sessions", json={"start": start.isoformat(), "club_id": club["id"], "player_ids": [p["id"]]}).json()[0]
    assert s["club"] == "Padel Club La Marsa" and s["court_status"] == "en_attente"
    to, body = FakeSmsProvider.sent[-1]
    assert to == "+21671123456" and "Sami" in body and "réserver un terrain" in body
    cb = client.get("/court-bookings").json()[0]
    assert cb["status"] == "en_attente" and cb["sent_at"]


def test_court_request_for_far_session_waits_then_sends(client):
    club = mkclub(client)
    far = datetime.now(timezone.utc) + timedelta(days=30)
    client.post("/sessions", json={"start": far.isoformat(), "club_id": club["id"], "repeat_weeks": 2})
    assert client.get("/court-bookings").json()[0]["status"] == "a_envoyer"
    assert FakeSmsProvider.sent == []
    assert client.post("/court-bookings/send-due").json()["sent"] == 0  # trop tôt


def test_custom_template_and_club_without_phone(client):
    club = mkclub(client, sms_template="Réservation {club}: {date} {debut}-{fin}")
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    client.post("/sessions", json={"start": start, "club_id": club["id"]})
    assert FakeSmsProvider.sent[-1][1].startswith("Réservation Padel Club La Marsa:")
    nophone = client.post("/clubs", json={"name": "Sans tel"}).json()
    later = (datetime.now(timezone.utc) + timedelta(days=1, hours=3)).isoformat()  # un seul terrain à la fois: autre heure
    client.post("/sessions", json={"start": later, "club_id": nophone["id"]})
    cb = next(c for c in client.get("/court-bookings").json() if c["club_name"] == "Sans tel")
    assert cb["status"] == "a_envoyer"
    assert client.post(f"/court-bookings/{cb['id']}/send").status_code == 422


@pytest.mark.parametrize("text,verdict", [
    ("OUI c'est bon", "confirmee"), ("Ok réservé ✅", "confirmee"), ("Confirmé", "confirmee"),
    ("Non, complet à cette heure", "refusee"), ("Désolé terrain occupé", "refusee"), ("oui mais complet", "refusee"),
    ("Pas disponible", "refusee"), ("Rappelez-moi demain", None),
])
def test_parse_reply(text, verdict):
    assert parse_reply(text) == verdict


def test_court_reply_via_paste_and_webhook(client):
    club = mkclub(client)
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    client.post("/sessions", json={"start": start, "club_id": club["id"]})
    cb_id = client.get("/court-bookings").json()[0]["id"]
    r = client.post(f"/court-bookings/{cb_id}/reply", json={"text": "Rappelez-moi"}).json()
    assert r["understood"] is False and r["status"] == "en_attente"
    anon = TestClient(app)
    assert anon.post("/courts/inbound", json={"phone": "71123456", "text": "oui"}).status_code == 403
    r = anon.post("/courts/inbound", json={"phone": "71123456", "text": "OUI c'est bon"}, headers={"X-Webhook-Secret": "dev-webhook-secret"}).json()
    assert r["matched"] and r["status"] == "confirmee"
    assert client.get("/sessions").json()[0]["court_status"] == "confirmee"


def test_cancelling_session_notifies_club(client):
    club = mkclub(client)
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    s = client.post("/sessions", json={"start": start, "club_id": club["id"]}).json()[0]
    n = len(FakeSmsProvider.sent)
    client.patch(f"/sessions/{s['id']}", json={"status": "annulee"})
    assert len(FakeSmsProvider.sent) == n + 1 and "annuler" in FakeSmsProvider.sent[-1][1]


# --- Relances ----------------------------------------------------------

def test_reminders(client):
    open_week(client)
    p = mkplayer(client, email="sami@x.tn")
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "player_ids": [p["id"]], "price_millimes": 60000}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=10, minute=0).isoformat()
    client.post("/sessions", json={"start": tomorrow, "player_ids": [p["id"]]})
    items = {i["kind"]: i for i in client.get("/reminders", params={"base": "https://app.test"}).json()}
    assert "60,000 TND" in items["impaye"]["message"] and items["impaye"]["email"] == "sami@x.tn"
    assert "demain" in items["seance"]["message"]
    assert "https://app.test/invite/" in items["invitation"]["message"]
    client.post("/reminders/log", json={"player_id": p["id"], "kind": "impaye", "channel": "whatsapp"})
    again = {i["kind"]: i for i in client.get("/reminders").json()}
    assert again["impaye"]["last_sent"]["channel"] == "whatsapp"
    # le joueur invité n'a plus de relance « invitation »
    token = items["invitation"]["message"].rsplit("/", 1)[1].split(" ")[0]
    TestClient(app).post(f"/auth/invite/{token}", json={"email": "sami@x.tn", "password": "secret1"})
    assert "invitation" not in {i["kind"] for i in client.get("/reminders").json()}


# --- Règles de niveau, fiches modifiables, notes --------------------------

from app.constants import compatible  # noqa: E402


@pytest.mark.parametrize("a,ga,b,gb,ok", [
    # même sexe: un cran (demi-tranche) d'écart au plus
    ("P250-", "M", "P250-", "M", True), ("P250-", "M", "P100+", "M", True), ("P250-", "M", "P250+", "M", True),
    ("P250-", "M", "P100-", "M", False), ("P250-", "M", "P500-", "M", False),
    ("P500+", "F", "P500-", "F", True), ("P500+", "F", "P250+", "F", False),
    # une joueuse et un homme: l'homme a 1 à 3 crans de moins
    ("P1000+", "F", "P1000-", "M", True), ("P1000+", "F", "P500+", "M", True), ("P1000+", "F", "P500-", "M", True),
    ("P1000+", "F", "P250+", "M", False), ("P1000+", "F", "P1000+", "M", False),
    ("P250+", "F", "P250-", "M", True), ("P250+", "F", "P100+", "M", True), ("P250+", "F", "P100-", "M", True),
    ("P250+", "F", "P50+", "M", False), ("P250-", "F", "P250+", "M", False), ("P250-", "F", "P500-", "M", False),
    ("P100", "M", "P100-", "M", True),  # ancien code sans +/- = bas de tranche
])
def test_level_compatibility(a, ga, b, gb, ok):
    assert compatible(a, ga, b, gb) is ok
    assert compatible(b, gb, a, ga) is ok  # la règle est symétrique


def test_suggestions_respect_every_player_and_gender_rule(client):
    open_week(client)
    # séance avec une P500 dame et un P250 homme: écart d'un cran entre eux, il reste 2 places
    w = mkplayer(client, name="Woman500", phone="20111111", gender="F", category="P500")
    m = mkplayer(client, name="Man250", phone="20222222", gender="M", category="P250")
    start = (datetime.now(timezone.utc) + timedelta(hours=48)).replace(minute=0, second=0, microsecond=0).isoformat()
    s = client.post("/sessions", json={"start": start, "kind": "groupe", "open": True, "player_ids": [w["id"], m["id"]], "price_millimes": 30000}).json()[0]
    _, ok_p = player_client(client, name="Man500", phone="20333333", category="P250+", gender="M")  # P250+ H: 1 cran sous la P500- D, 1 cran au-dessus du P250- H
    _, ko_high = player_client(client, name="Man1000", phone="20444444", category="P1000", gender="M")  # 2 crans au-dessus de P250
    _, ko_low = player_client(client, name="Man100", phone="20555555", category="P100", gender="M")  # 2 crans sous P500
    assert [x["session_id"] for x in ok_p.get("/me/suggestions").json()] == [s["id"]]
    assert ko_high.get("/me/suggestions").json() == []
    assert ko_low.get("/me/suggestions").json() == []
    assert ko_low.post("/me/book", json={"session_id": s["id"]}).status_code == 409
    cands = [c["name"] for c in client.get("/groups").json()[0]["candidates"]]
    assert "Man500" in cands and "Man1000" not in cands and "Man100" not in cands


def test_edit_player_profile(client):
    p = mkplayer(client, email="old@x.tn")
    body = {"name": "Sami Ben Ali", "phone": "98 765 432", "email": "new@x.tn", "gender": "M", "category": "P500+",
            "dominant_hand": "gaucher", "side": "revers", "goals": "Gagner un tournoi", "notes": "Épaule fragile"}
    out = client.put(f"/players/{p['id']}", json=body).json()
    assert (out["name"], out["phone"], out["category"], out["dominant_hand"], out["notes"]) == ("Sami Ben Ali", "+21698765432", "P500+", "gaucher", "Épaule fragile")
    prof = client.get(f"/players/{p['id']}/profile").json()["player"]
    assert prof["goals"] == "Gagner un tournoi" and prof["email"] == "new@x.tn"
    assert client.put(f"/players/{p['id']}", json={**body, "phone": "12"}).status_code == 422


def test_session_feedback_listing(client):
    p = mkplayer(client)
    s = client.post("/sessions", json={"start": "2026-11-03T17:00:00Z", "player_ids": [p["id"]]}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    assert client.get("/sessions").json()[0]["feedback_missing"] is True
    assert client.get(f"/sessions/{s['id']}/feedback").json()[0]["note"] == ""
    client.put(f"/sessions/{s['id']}/feedback/{p['id']}", json={"worked_on": ["Lob"], "note": "Top", "to_improve": ""})
    assert client.get("/sessions").json()[0]["feedback_missing"] is False
    fb = client.get(f"/sessions/{s['id']}/feedback").json()[0]
    assert (fb["name"], fb["worked_on"], fb["note"]) == ("Sami", ["Lob"], "Top")
    assert register("z@z.tn").get(f"/sessions/{s['id']}/feedback").status_code == 404


# --- Paiement par joueur et rappels automatiques -------------------------

def test_completed_session_shows_what_each_player_paid(client):
    a, b = mkplayer(client, name="Ali")["id"], mkplayer(client, phone="22 000 111", name="Bea")["id"]
    future = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()  # pas encore passée (sinon effectuée d'office)
    s = client.post("/sessions", json={"start": future, "kind": "duo", "player_ids": [a, b], "price_millimes": 40000}).json()[0]
    assert client.get("/sessions").json()[0]["payments"] == []  # pas encore effectuée
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    client.post("/payments", json={"player_id": a, "amount_millimes": 25000, "session_id": s["id"]})
    client.post("/payments", json={"player_id": a, "amount_millimes": 15000, "session_id": s["id"]})
    pay = {x["player_id"]: x for x in client.get("/sessions").json()[0]["payments"]}
    assert pay[a] == {"player_id": a, "due_millimes": 40000, "credit_millimes": 0, "paid_millimes": 40000, "refunded": False}
    assert pay[b]["paid_millimes"] == 0 and pay[b]["due_millimes"] == 40000
    other = mkplayer(client, phone="22 000 222", name="Cyr")["id"]  # pas dans la séance
    assert client.post("/payments", json={"player_id": other, "amount_millimes": 1000, "session_id": s["id"]}).status_code == 404


def test_contact_channel_at_signup_and_first_login(client):
    p = mkplayer(client)
    token = client.post(f"/players/{p['id']}/invite").json()["token"]
    anon = TestClient(app)
    assert anon.post(f"/auth/invite/{token}", json={"email": "s@x.tn", "password": "secret1", "contact_channel": "pigeon"}).status_code == 422
    r = anon.post(f"/auth/invite/{token}", json={"email": "s@x.tn", "password": "secret1", "contact_channel": "whatsapp"}).json()
    pc = login_as(TestClient(app), r["token"])
    assert pc.get("/me").json()["contact_channel"] == "whatsapp"
    assert pc.put("/me/contact", json={"contact_channel": "email"}).json()["contact_channel"] == "email"
    assert pc.put("/me/contact", json={"contact_channel": "fax"}).status_code == 422
    # joueur sans choix: la question lui est posée à la première connexion
    q = mkplayer(client, phone="22 999 888", name="Nour")
    t2 = client.post(f"/players/{q['id']}/invite").json()["token"]
    r2 = TestClient(app).post(f"/auth/invite/{t2}", json={"email": "n@x.tn", "password": "secret1"}).json()
    assert login_as(TestClient(app), r2["token"]).get("/me").json()["contact_channel"] == "email"  # version bêta: e-mail par défaut


def test_automatic_reminders_24h_and_2h(client, monkeypatch):
    monkeypatch.setattr('app.notify.EMAIL_ONLY', False)  # choix du joueur (WhatsApp, SMS, e-mail): version après la bêta
    from app.models import SessionReminder
    from app.notify import Notifier
    from app.services.session_reminders import send_due

    Notifier.sent.clear()
    wa = mkplayer(client, name="Sami Ben", contact_channel="whatsapp")["id"]
    mail = mkplayer(client, phone="22 000 333", name="Lina", email="lina@x.tn", contact_channel="email")["id"]
    nochoice = mkplayer(client, phone="22 000 444", name="Omar")["id"]
    start = datetime(2026, 3, 10, 17, 0, tzinfo=timezone.utc)  # 18h00 à Tunis
    client.post("/sessions", json={"start": start.isoformat(), "kind": "groupe", "club": "Club X", "player_ids": [wa, mail, nochoice]})
    db = TestSession()
    notifier = Notifier(FakeSmsProvider())
    assert send_due(db, notifier, now=start - timedelta(hours=30)) == 0  # trop tôt
    assert send_due(db, notifier, now=start - timedelta(hours=23)) == 3  # rappel de la veille
    assert send_due(db, notifier, now=start - timedelta(hours=20)) == 0  # pas deux fois
    assert sorted(ch for ch, _, _ in Notifier.sent) == ["email", "sms", "whatsapp"]  # sans choix: SMS
    body = next(body for _, to, body in Notifier.sent if to == "lina@x.tn")
    # mise en page: salutation, phrase, détails ligne par ligne, signature
    assert body.startswith("Bonjour Lina,\n\nPetit rappel : vous avez une séance de padel demain.")
    assert "Quand : mardi 10 mars, de 18h à 19h\nOù : Club X" in body and body.endswith("À bientôt,\nCoach Test")
    assert send_due(db, notifier, now=start - timedelta(minutes=110)) == 3  # 2 h avant
    assert "commence bientôt" in Notifier.sent[-1][2] and "de 18h à 19h" in Notifier.sent[-1][2]
    assert send_due(db, notifier, now=start - timedelta(minutes=30)) == 0
    assert send_due(db, notifier, now=start + timedelta(minutes=5)) == 0  # séance commencée
    assert sorted(r.kind for r in db.query(SessionReminder)) == ["24h"] * 3 + ["2h"] * 3
    db.close()


def test_no_reminder_for_cancelled_session(client):
    from app.notify import Notifier
    from app.services.session_reminders import send_due

    p = mkplayer(client)["id"]
    start = datetime(2026, 3, 10, 17, 0, tzinfo=timezone.utc)
    s = client.post("/sessions", json={"start": start.isoformat(), "player_ids": [p]}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "annulee"})
    db = TestSession()
    assert send_due(db, Notifier(FakeSmsProvider()), now=start - timedelta(hours=3)) == 0
    db.close()


def test_payment_without_session_covers_oldest_sessions(client):
    p = mkplayer(client)["id"]
    ids = [client.post("/sessions", json={"start": f"2026-01-0{d}T10:00:00Z", "player_ids": [p], "price_millimes": 60000}).json()[0]["id"] for d in (5, 6)]
    for i in ids:
        client.patch(f"/sessions/{i}", json={"status": "effectuee"})
    client.post("/payments", json={"player_id": p, "amount_millimes": 80000})  # saisi depuis la fiche joueur
    paid = [s["payments"][0]["paid_millimes"] for s in client.get("/sessions").json()]
    assert paid == [60000, 20000]


def test_index_is_never_cached(tmp_path, monkeypatch):
    """Après un déploiement, le navigateur doit recharger index.html (sinon il garde l'ancien design)."""
    import importlib
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "assets" / "a-123.js").write_text("x")
    monkeypatch.setenv("STATIC_DIR", str(tmp_path))
    from app import web
    web = importlib.reload(web)
    c = TestClient(web.web)
    assert c.get("/").headers["cache-control"] == "no-cache"
    assert c.get("/invite/abc").headers["cache-control"] == "no-cache"  # route du navigateur -> index.html
    assert "immutable" in c.get("/assets/a-123.js").headers["cache-control"]


def test_undo_completed_session_until_paid(client):
    """Ticket coach n°12: une séance passée devient effectuée toute seule (crédits débités); le coach peut quand
    même l'annuler si elle n'a pas eu lieu (crédits rendus), sauf si un paiement a été encaissé pour elle."""
    p = mkplayer(client)["id"]
    client.post(f"/players/{p}/credits", json={"amount_millimes": 100000, "method": "especes"})
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "player_ids": [p], "price_millimes": 60000}).json()[0]
    assert next(x for x in client.get("/sessions").json() if x["id"] == s["id"])["status"] == "effectuee"  # automatiquement
    assert client.get(f"/players/{p}/credits").json()["balance_millimes"] == 40000
    assert client.patch(f"/sessions/{s['id']}", json={"status": "annulee"}).json()["status"] == "annulee"  # pas eu lieu
    assert client.get(f"/players/{p}/credits").json()["balance_millimes"] == 100000  # crédits rendus
    s2 = client.post("/sessions", json={"start": "2026-01-06T10:00:00Z", "player_ids": [p], "price_millimes": 60000}).json()[0]
    client.get("/sessions")
    client.post("/payments", json={"player_id": p, "amount_millimes": 60000, "session_id": s2["id"], "method": "especes"})
    assert client.patch(f"/sessions/{s2['id']}", json={"status": "annulee"}).status_code == 409  # déjà réglée


def test_coach_adds_player_to_session(client):
    a, b, c = (mkplayer(client, phone=f"22 000 00{i}", name=n)["id"] for i, n in enumerate("ABC"))
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "kind": "duo", "player_ids": [a]}).json()[0]
    assert client.post(f"/sessions/{s['id']}/players", json={"player_id": b}).json()["player_ids"] == [a, b]
    assert client.post(f"/sessions/{s['id']}/players", json={"player_id": b}).status_code == 409  # déjà dedans
    assert client.post(f"/sessions/{s['id']}/players", json={"player_id": c}).status_code == 409  # complète


# --- Demi-tranches, exercices et préparation de séance ----------------------

@pytest.mark.parametrize("a, ga, b, gb, ok", [
    ("P100+", "M", "P250-", "M", True), ("P100-", "M", "P250+", "M", False),  # tranches voisines: le +/- compte maintenant
    ("P25+", "M", "P50-", "M", True), ("P25-", "F", "P50+", "F", False),
    ("P500-", "F", "P500+", "M", False),  # un homme au-dessus d'une joueuse: non
    ("P500+", "F", "P250+", "M", True),
])
def test_half_tier_compatibility(a, ga, b, gb, ok):
    from app.constants import compatible
    assert compatible(a, ga, b, gb) is ok


def test_half_tier_categories(client):
    for cat in ("P25-", "P25+", "P1000+"):
        assert mkplayer(client, name=cat, category=cat)["category"] == cat
    assert client.post("/players", json={"name": "X", "phone": "22123456", "category": "P2000+"}).status_code == 422


def test_exercise_library(client):
    lib = client.get("/exercises").json()
    assert len(lib) >= 30 and not any(e["mine"] for e in lib)  # exercices proposés par l'application
    builtin = lib[0]["id"]
    assert client.put(f"/exercises/{builtin}", json={"name": "x", "themes": ["Smash"]}).status_code == 404  # non modifiable
    e = client.post("/exercises", json={"name": "Smash sur cible", "description": "Cerceau au sol", "themes": ["Smash", "Physique"], "duration_min": 20}).json()
    assert e["mine"] and e["themes"] == ["Smash", "Physique"]
    assert client.post("/exercises", json={"name": "Sans thème", "themes": []}).status_code == 422
    assert client.put(f"/exercises/{e['id']}", json={"name": "Smash sur cible", "themes": ["Smash"], "max_players": 2}).json()["max_players"] == 2
    other = register("other@b.tn")
    assert all(not x["mine"] for x in other.get("/exercises").json())  # chacun ses exercices
    assert other.delete(f"/exercises/{e['id']}").status_code == 404
    assert client.delete(f"/exercises/{e['id']}").status_code == 200


def test_session_plan_from_weaknesses(client):
    a, b = mkplayer(client, name="Ali")["id"], mkplayer(client, phone="22 000 111", name="Bea")["id"]
    for pid, stroke, score in ((a, "Bandeja", 1), (a, "Smash", 4), (b, "Bandeja", 2), (b, "Lob", 2), (b, "Volée", 3)):
        client.post(f"/players/{pid}/skills", json={"stroke": stroke, "score": score})
    s = client.post("/sessions", json={"start": "2026-03-10T17:00:00Z", "kind": "duo", "duration_min": 90, "player_ids": [a, b]}).json()[0]
    info = client.get(f"/sessions/{s['id']}/plan").json()
    assert info["recommended"][:2] == ["Bandeja", "Lob"] and info["plan"] is None
    assert {p["name"]: [w["theme"] for w in p["weak"]] for p in info["players"]} == {"Ali": ["Bandeja"], "Bea": ["Bandeja", "Lob"]}
    mine = client.post("/exercises", json={"name": "Ma bandeja", "themes": ["Bandeja"], "min_players": 2, "max_players": 2}).json()
    plan = client.post(f"/sessions/{s['id']}/plan/generate", json={"themes": info["recommended"], "seed": 1}).json()
    items = plan["items"]
    assert sum(i["duration_min"] for i in items) == 90 and items[0]["kind"] == "echauffement" and items[-1]["kind"] == "retour"
    assert [i["start_min"] for i in items] == [sum(x["duration_min"] for x in items[:k]) for k in range(len(items))]
    assert mine["id"] in [i["exercise_id"] for i in items]  # les exercices du coach passent en premier
    assert len({i["exercise_id"] for i in items}) == len(items)  # pas deux fois le même
    # le coach ignore la recommandation et choisit lui-même; séance individuelle de 60 min
    solo = client.post("/sessions", json={"start": "2026-03-11T17:00:00Z", "duration_min": 60, "player_ids": [a]}).json()[0]
    p2 = client.post(f"/sessions/{solo['id']}/plan/generate", json={"themes": ["Service"]}).json()
    assert sum(i["duration_min"] for i in p2["items"]) == 60 and all(i["theme"] in ("Échauffement", "Service", "Jeu") for i in p2["items"])
    assert all(i["kind"] != "jeu" or "1 contre" not in i["name"] for i in p2["items"])
    assert client.put(f"/sessions/{s['id']}/plan", json=plan).json() == {"ok": True}
    assert client.get(f"/sessions/{s['id']}/plan").json()["plan"]["items"] == items


# --- Prise de rendez-vous tous coachs, page coach ---------------------------

def _day_of(iso):
    from app.services.common import TUNIS
    return datetime.fromisoformat(iso).astimezone(TUNIS).date().isoformat()


def test_booking_without_credits_makes_balance_negative(client):
    open_week(client)
    p, pc = player_client(client)
    slot = pc.get("/me/slots").json()[0]
    free_court(client, slot)
    r = pc.post("/me/book", json={"kind": "individuel", "start": slot}).json()  # validation automatique (terrain libre)
    assert r["status"] == "confirmee" and r["charged_millimes"] == 60000 and r["credits_millimes"] == -60000
    s = client.get("/sessions").json()[0]
    assert s["price_millimes"] == 60000
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    unpaid = client.get("/dashboard").json()["unpaid"]
    assert [(u["amount_millimes"], u["negative_balance_millimes"]) for u in unpaid] == [(60000, 60000)]  # une seule fois


def test_player_books_with_another_coach_and_sees_coach_page(client):
    open_week(client)
    p, pc = player_client(client, name="Sami Ben", gender="M", category="P250+")
    # un second coach, avec son club et un terrain déjà réservé
    other = register("coach2@b.tn")
    open_week(other)
    other.put("/booking/settings", json={**other.get("/booking/settings").json(), "bio": "Ancien joueur pro.", "specialties": ["Smash", "Bandeja", "Inconnu"]})
    club = other.post("/clubs", json={"name": "Club Carthage", "phone": "71 000 000"}).json()
    slots = pc.get("/me/slots").json()
    day = _day_of(slots[3])
    coaches = pc.get("/me/coaches").json()
    assert [c["mine"] for c in coaches] == [True, False] and coaches[1]["clubs"] == ["Club Carthage"]
    page = pc.get(f"/me/coaches/{coaches[1]['id']}").json()
    assert page["bio"] == "Ancien joueur pro." and page["specialties"] == ["Smash", "Bandeja"] and len(page["availability"]) == 7
    assert "Club Carthage" in pc.get("/me/clubs").json()
    # seul: d'abord les créneaux où le coach a déjà un terrain
    target = next(x for x in slots if _day_of(x) == day and datetime.fromisoformat(x).astimezone(timezone.utc).hour >= 15)
    other.post("/court-bookings/manual", json={"club_id": club["id"], "start": target, "duration_min": 60})
    off = pc.get(f"/me/offers?day={day}&kind=individuel&club=club carthage").json()
    assert [x["start"][:16] for x in off["slots_with_court"]] == [target[:16]] and off["slots_with_court"][0]["coach"]["name"] == "Coach Test"
    assert all(x["coach"]["id"] == coaches[1]["id"] for x in off["slots_other"])  # filtre club: seul ce coach y travaille
    assert pc.get(f"/me/offers?day={day}&kind=individuel&period=matin").json()["slots_with_court"] == []
    # réservation chez le second coach: une fiche est créée chez lui, reliée au compte
    r = pc.post("/me/book", json={"kind": "individuel", "start": off["slots_with_court"][0]["start"], "coach_id": coaches[1]["id"]}).json()
    assert r["status"] == "confirmee" and r["coach_name"] == "Coach Test" and r["credits_millimes"] == -60000
    theirs = other.get("/players").json()
    assert [(x["name"], x["category"], x["has_account"]) for x in theirs] == [("Sami Ben", "P250+", True)]
    mine = pc.get("/me/sessions").json()["upcoming"]
    assert len(mine) == 1 and mine[0]["club"] == "Club Carthage"
    assert {w["coach_id"] for w in pc.get("/me").json()["wallets"]} == {coaches[0]["id"], coaches[1]["id"]}
    # en groupe: le groupe déjà formé chez le second coach est proposé, avec de nouveaux créneaux
    host = other.post("/players", json={"name": "Host", "phone": "22 999 999", "category": "P250-"}).json()
    t0 = datetime.fromisoformat(target)
    g_start = next(x for x in slots if _day_of(x) == day and abs(datetime.fromisoformat(x) - t0) >= timedelta(hours=2))
    g = other.post("/sessions", json={"start": g_start, "kind": "groupe", "open": True, "player_ids": [host["id"]], "price_millimes": 30000, "club_id": club["id"]}).json()[0]
    # (à moins de 24 h, il faut accepter d'être 2: plus le temps de compléter un groupe de 3)
    off = pc.get(f"/me/offers?day={day}&kinds=duo,groupe").json()
    assert [x["session_id"] for x in off["groups"]] == [g["id"]]
    if not off["slots_other"]:  # jour à moins de 24 h: on ne peut pas ouvrir seul un nouveau duo/groupe
        assert off["too_late"] == ["duo", "groupe"]
    assert pc.post("/me/book", json={"session_id": g["id"], "kinds": ["duo", "groupe"]}).json()["status"] in ("confirmee", "acceptee")
    assert pc.get(f"/me/offers?day={day}&kinds=duo,groupe").json()["groups"] == []  # déjà inscrit


# --- Formules multiples, durées par formule, happy hours, promotions ---------

def test_player_chooses_duration_happy_hours_and_multiple_kinds(client):
    """Le joueur choisit la durée: seul = toujours 1 h; à deux / en groupe = 1 h, 1 h 30 (par défaut) ou les deux.
    Prix du coach par heure et par joueur, 1 h 30 au prorata (x 1,5)."""
    open_week(client)  # 60 / 40 / 30 TND l'heure
    st = client.get("/booking/settings").json()
    hh = [{"weekday": d, "start_time": "09:00", "end_time": "12:00", "discount_millimes": 15000} for d in range(7)]  # heures creuses: -15 TND
    st = client.put("/booking/settings", json={**st, "happy_hours": hh}).json()
    assert client.put("/booking/settings", json={**st, "happy_hours": [{**hh[0], "discount_millimes": 0}]}).status_code == 422
    p, pc = player_client(client)
    day = _day_of(pc.get("/me/slots").json()[-1])
    utc = lambda x: datetime.fromisoformat(x["start"].replace("Z", "+00:00")).astimezone(timezone.utc)  # noqa: E731
    off = pc.get(f"/me/offers?day={day}&kinds=individuel,groupe&groupe_min=90").json()
    morning = next(x for x in off["slots_other"] if utc(x).hour == 8 and utc(x).minute == 0)  # 9 h à Tunis
    opts = {(o["kind"], o["duration_min"]): o for o in morning["options"]}
    assert set(opts) == {("individuel", 60), ("groupe", 90)}  # jamais seul 1 h 30, groupe seulement 1 h 30 (son choix)
    assert opts[("individuel", 60)]["price_millimes"] == 45000 and opts[("individuel", 60)]["reason"] == "happy_hour"  # 60 - 15
    assert opts[("groupe", 90)]["base_millimes"] == 45000 and opts[("groupe", 90)]["price_millimes"] == 30000  # 30 TND/h x 1,5 - 15
    both = pc.get(f"/me/offers?day={day}&kinds=groupe&groupe_min=60,90").json()["slots_other"]
    assert {o["duration_min"] for x in both for o in x["options"]} == {60, 90}  # les deux durées, chacune son prix
    last = [x for x in off["slots_other"] if any(o["duration_min"] == 90 for o in x["options"])][-1]
    assert utc(last).strftime("%H:%M") == "18:30"  # un groupe d'1 h 30 ne dépasse pas 21 h
    # seul: toujours 1 h
    assert pc.post("/me/book", json={"kind": "individuel", "start": morning["start"], "kinds": ["individuel"], "minutes": 90}).status_code == 409
    # 1 h: seul ou groupe d'1 h 30 -> à 1 h seule la formule « seul » reste
    r = pc.post("/me/book", json={"kind": "individuel", "start": morning["start"], "kinds": ["individuel", "groupe"], "minutes": 60, "durations": {"groupe": [90]}}).json()
    req = client.get("/booking/requests").json()[0]
    assert req["accepted_kinds"] == ["individuel"] and req["kind"] == "individuel" and req["duration_min"] == 60 and req["price_millimes"] == 45000
    # en groupe 1 h 30, juste après (sans trou)
    p2, pc2 = player_client(client, name="Gaby", phone="20444555")
    t0 = utc(morning)
    later = [x for x in pc2.get(f"/me/offers?day={day}&kinds=groupe&groupe_min=90").json()["slots_other"] if utc(x) > t0]
    assert utc(later[0]) == t0 + timedelta(minutes=60)
    r2 = pc2.post("/me/book", json={"kind": "groupe", "start": later[0]["start"], "kinds": ["groupe"], "minutes": 90, "durations": {"groupe": [90]}}).json()
    req2 = next(x for x in client.get("/booking/requests").json() if x["id"] == r2["id"])
    assert (req2["kind"], req2["duration_min"], req2["price_millimes"]) == ("groupe", 90, 30000)
    assert r["status"] == "en_attente" and r["charged_millimes"] == 0  # validation par le coach, rien de débité avant


def test_session_of_another_duration_is_shown_with_a_note(client):
    """Duo d'1 h 30 demandé: une séance à deux d'1 h existante est quand même montrée (« autre durée »);
    le joueur peut la rejoindre en acceptant cette durée."""
    open_week(client)
    a, b = mkplayer(client, name="Host"), None
    start = (datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=9, minute=0, second=0, microsecond=0)
    s = client.post("/sessions", json={"start": start.isoformat(), "kind": "duo", "duration_min": 60, "open": True, "player_ids": [a["id"]]}).json()[0]
    p, pc = player_client(client, phone="20555666")
    g = pc.get(f"/me/offers?day={_day_of(start.isoformat())}&kinds=duo&duo_min=90").json()["groups"]
    assert [(x["session_id"], x["other_duration"]) for x in g] == [(s["id"], True)]
    assert pc.post("/me/book", json={"session_id": s["id"], "kinds": ["duo"], "durations": {"duo": [90]}}).status_code == 409
    r = pc.post("/me/book", json={"session_id": s["id"], "kinds": ["duo"], "durations": {"duo": [60, 90]}})
    assert r.status_code == 201 and r.json()["price_millimes"] == 40000  # 1 h à deux


def test_coach_refunds_an_absent_player(client):
    """Séance effectuée, un joueur n'est pas venu: le coach le rembourse, ses crédits lui reviennent."""
    open_week(client)  # 40 TND l'heure à deux
    a, b = mkplayer(client, name="Ali"), mkplayer(client, name="Bea")
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    s = client.post("/sessions", json={"start": start, "kind": "duo", "player_ids": [a["id"], b["id"]], "discount_millimes": 0}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    for x in (a, b):  # la recharge règle d'abord la séance effectuée
        client.post(f"/players/{x['id']}/credits", json={"amount_millimes": 100000})
    bal = lambda x: client.get(f"/players/{x['id']}/credits").json()["balance_millimes"]  # noqa: E731
    assert bal(a) == bal(b) == 60000  # 40 TND l'heure, à deux
    out = client.post(f"/sessions/{s['id']}/refund/{b['id']}").json()
    assert next(x for x in out["payments"] if x["player_id"] == b["id"])["refunded"] is True
    assert bal(b) == 100000 and bal(a) == 60000
    assert client.post(f"/sessions/{s['id']}/refund/{b['id']}").status_code == 409  # pas deux fois
    # toujours tout ce qu'il a payé (même si une somme est envoyée)
    client.post(f"/sessions/{s['id']}/refund/{a['id']}", json={"amount_millimes": 15000})
    assert bal(a) == 100000
    client.patch(f"/sessions/{s['id']}", json={"status": "prevue"})  # retour à « prévue »: rien n'est rendu deux fois
    assert bal(b) == 100000


def test_promotion_on_reserved_court_notifies_players(client, monkeypatch):
    monkeypatch.setattr('app.notify.EMAIL_ONLY', False)  # choix du joueur (WhatsApp, SMS, e-mail): version après la bêta
    from app.notify import Notifier
    open_week(client)
    p, pc = player_client(client, contact_channel="whatsapp")
    mkplayer(client, phone="22 000 999", name="Sans compte")
    slot = pc.get("/me/slots").json()[5]
    court = free_court(client, slot, minutes=60)
    Notifier.sent.clear()
    assert client.get(f"/promotions/preview?court_booking_id={court['id']}&discount_millimes=18000").json()["recipients"] == 2
    promo = client.post("/promotions", json={"court_booking_id": court["id"], "discount_millimes": 18000}).json()
    assert promo["notified_count"] == 2 and promo["prices"]["individuel"] == 42000
    assert sorted(ch for ch, _, _ in Notifier.sent) == ["sms", "whatsapp"] and "-18 TND" in Notifier.sent[0][2]
    assert [x["id"] for x in pc.get("/me/promotions").json()] == [promo["id"]]
    off = pc.get(f"/me/offers?day={_day_of(slot)}&kinds=individuel").json()
    top = off["slots_with_court"][0]
    assert top["start"][:16] == slot[:16] and top["reason"] == "promo" and top["price_millimes"] == 42000
    pc.post("/me/book", json={"kind": "individuel", "start": top["start"]})
    assert pc.get("/me/promotions").json() == []  # terrain pris: la promotion s'arrête
    assert client.get("/sessions").json()[0]["price_millimes"] == 42000
    other = free_court(client, pc.get("/me/slots").json()[8], minutes=60)
    assert client.post("/promotions", json={"court_booking_id": other["id"], "discount_millimes": 0}).status_code == 422


def test_coach_chooses_clubs(client):
    mkclub(client)  # Padel Club La Marsa
    other = register("coach2@b.tn")
    other.post("/clubs", json={"name": "Club Carthage", "phone": "71 000 000"})
    cat = client.get("/clubs/catalog").json()
    assert cat["mine"] == ["Padel Club La Marsa"] and [k["name"] for k in cat["known"]] == ["Club Carthage"]
    # il rejoint un club connu (téléphone repris), en ajoute un nouveau et quitte La Marsa
    cat = client.put("/clubs/selection", json={"names": ["club carthage"], "new": [{"name": "Hammamet Padel", "phone": "72 111 222"}]}).json()
    assert cat["mine"] == ["Club Carthage", "Hammamet Padel"] and cat["known"] == [{"name": "Padel Club La Marsa", "phone": "+21671123456"}]
    assert [(c["name"], c["phone"]) for c in client.get("/clubs").json()] == [("Club Carthage", "+21671000000"), ("Hammamet Padel", "+21672111222")]
    assert len(client.get("/clubs?all=true").json()) == 3  # La Marsa reste en base (historique)
    _, pc = player_client(client)
    me_coach = next(c for c in pc.get("/me/coaches").json() if c["mine"])
    assert me_coach["clubs"] == ["Club Carthage", "Hammamet Padel"]
    client.put("/clubs/selection", json={"names": ["Padel Club La Marsa", "Club Carthage", "Hammamet Padel"]})
    assert len(client.get("/clubs").json()) == 3  # réactivé, pas dupliqué



# --- DP-001: débit à la validation du coach, solde négatif autorisé ------------

def test_dp001_debit_on_coach_validation_and_negative_balance(client):
    open_week(client, auto_confirm=False)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 120000})
    slots = [s for s in pc.get("/me/slots").json() if s[14:16] == "00"]  # heures pleines (grille de 30 min)
    ids = [pc.post("/me/book", json={"kind": "individuel", "start": slots[i]}).json()["id"] for i in (-1, -3, -5, -7)]  # loin: annulable
    bal = lambda: pc.get("/me").json()["credits_millimes"]  # noqa: E731
    assert bal() == 120000  # demandes en attente: rien de débité
    accept = lambda i: client.post(f"/booking/requests/{i}/accept", json={})  # noqa: E731
    accept(ids[0]), accept(ids[1])
    assert bal() == 0
    accept(ids[2])
    assert bal() == -60000  # solde négatif: dette envers le coach
    unpaid = client.get("/dashboard").json()["unpaid"]
    assert [(u["player_id"], u["amount_millimes"]) for u in unpaid] == [(p["id"], 60000)]
    assert client.get(f"/players/{p['id']}/credits").json()["balance_millimes"] == -60000
    assert client.get(f"/players/{p['id']}/profile").json()["finance"]["due_millimes"] == 60000
    assert any(i["kind"] == "impaye" and i["amount_millimes"] == 60000 for i in client.get("/reminders").json())
    # séance validée puis effectuée: pas comptée une deuxième fois dans les impayés
    sid = next(s["id"] for s in client.get("/sessions").json() if s["start"][:16] == slots[-5][:16])
    client.patch(f"/sessions/{sid}", json={"status": "effectuee"})
    assert [u["amount_millimes"] for u in client.get("/dashboard").json()["unpaid"]] == [60000]
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 60000})
    assert bal() == 0 and client.get("/dashboard").json()["unpaid"] == []
    # refus: rien débité; annulation dans les délais d'une séance validée: 60 TND rendus
    client.post(f"/booking/requests/{ids[3]}/refuse")
    assert bal() == 0
    assert pc.post(f"/me/bookings/{ids[0]}/cancel").json()["refunded_millimes"] == 60000
    assert bal() == 60000


# --- DP-002: vérification de l'e-mail des joueurs ------------------------------

def test_dp002_email_verification(client, monkeypatch):
    from app.notify import OUTBOX
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "1")
    OUTBOX.clear()
    open_week(client)
    p = mkplayer(client)
    token = client.post(f"/players/{p['id']}/invite").json()["token"]
    anon = TestClient(app)
    r = anon.post(f"/auth/invite/{token}", json={"email": "sami@x.tn", "password": "secret1", "base": "https://padel.example.tn"}).json()
    pc = login_as(TestClient(app), r["token"])
    # un e-mail avec le lien est parti vers l'adresse du compte
    to, subject, body = OUTBOX[-1]
    assert to == "sami@x.tn" and "Vérifiez" in subject and "https://padel.example.tn/verify/" in body
    me = pc.get("/me").json()
    assert me["email_verified"] is False and me["can_book"] is False
    assert client.get("/players").json()[0]["email_verified"] is False
    # non vérifié: il voit l'appli mais ne peut pas réserver
    slot = pc.get("/me/slots").json()[0]
    assert pc.post("/me/book", json={"kind": "individuel", "start": slot}).status_code == 403
    # renvoi du lien: limité à un par minute, l'ancien lien ne marche plus
    assert pc.post("/me/verify-email/resend", json={}).status_code == 429
    from app.models import Player
    db = TestSession()
    row = db.get(Player, p["id"])
    row.email_token_sent_at = datetime.now(timezone.utc) - timedelta(minutes=2)
    db.commit()
    db.close()
    old_link = body.split("/verify/")[1].split()[0]
    assert pc.post("/me/verify-email/resend", json={}).json()["email"] == "sami@x.tn"
    new_link = OUTBOX[-1][2].split("/verify/")[1].split()[0]
    assert old_link != new_link and anon.post(f"/auth/verify/{old_link}").status_code == 404
    # clic sur le lien: compte vérifié, réservation possible
    assert anon.post(f"/auth/verify/{new_link}").json()["ok"] is True
    assert anon.post(f"/auth/verify/{new_link}").status_code == 404  # usage unique
    assert pc.get("/me").json()["email_verified"] is True
    assert client.get("/players").json()[0]["email_verified"] is True
    assert pc.post("/me/book", json={"kind": "individuel", "start": slot}).status_code == 201


def test_dp002_not_enforced_without_email_sending(client, monkeypatch):
    monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    monkeypatch.delenv("SMTP_HOST", raising=False)
    open_week(client)
    _, pc = player_client(client)
    assert pc.get("/me").json()["can_book"] is True  # aucun e-mail ne peut partir: on ne bloque pas


def test_dp003_old_address_redirects_to_canonical_domain(tmp_path, monkeypatch):
    import importlib
    (tmp_path / "index.html").write_text("<html>app</html>")
    monkeypatch.setenv("STATIC_DIR", str(tmp_path))
    monkeypatch.setenv("CANONICAL_HOST", "padel.exemple.tn")
    from app import web
    web = importlib.reload(web)
    c = TestClient(web.web, base_url="http://141.95.86.176")
    r = c.get("/invite/abc?x=1", follow_redirects=False)
    assert r.status_code == 301 and r.headers["location"] == "https://padel.exemple.tn/invite/abc?x=1"
    assert TestClient(web.web, base_url="https://padel.exemple.tn").get("/").status_code == 200
    assert TestClient(web.web, base_url="http://127.0.0.1:8000").get("/api/health").json() == {"ok": True}  # vérification interne
    monkeypatch.delenv("CANONICAL_HOST")
    importlib.reload(web)


# --- Formules choisies: jamais de séance d'une autre formule ------------------

def test_formulas_are_respected_when_matching_groups(client):
    open_week(client)
    a, pa = player_client(client, name="Ali", phone="20111111")
    b, pb = player_client(client, name="Bea", phone="20222222")
    slots = pa.get("/me/slots").json()
    day = _day_of(slots[-1])
    start = next(x for x in slots if _day_of(x) == day)
    # Ali ne veut que seul ou à deux: il prend le créneau en duo
    r = pa.post("/me/book", json={"kind": "duo", "start": start, "kinds": ["individuel", "duo"]}).json()
    assert r["status"] == "en_attente" or r["status"] == "confirmee"
    req = next(x for x in client.get("/booking/requests").json() if x["name"] == "Ali")
    assert req["accepted_kinds"] == ["individuel", "duo"] and req["max_players"] == 2  # clair pour le coach
    if req["status"] == "en_attente":
        client.post(f"/booking/requests/{req['id']}/accept", json={})
    sid = next(s["id"] for s in client.get("/sessions").json() if s["player_ids"] == [a["id"]])
    # 1. Bea cherche un groupe: la séance d'Ali (duo) ne lui est pas proposée, seulement signalée
    off = pb.get(f"/me/offers?day={day}&kinds=groupe").json()
    assert off["groups"] == [] and off["other_kinds"] == {"duo": 1}
    assert pb.post("/me/book", json={"session_id": sid, "kinds": ["groupe"]}).status_code == 409
    # 2. Bea veut s'entraîner seule: aucun groupe proposé, mais on lui signale ce qui existe
    off = pb.get(f"/me/offers?day={day}&kinds=individuel").json()
    assert off["groups"] == [] and off["other_kinds"] == {"duo": 1}
    assert pb.get("/me/suggestions?kinds=individuel").json() == []
    # si elle reconsidère (duo coché), la séance d'Ali apparaît, et c'est un duo: 1 place, pas plus
    off = pb.get(f"/me/offers?day={day}&kinds=individuel,duo").json()
    assert [g["session_id"] for g in off["groups"]] == [sid] and off["groups"][0]["spots_left"] == 1 and off["other_kinds"] == {}
    rb = pb.post("/me/book", json={"session_id": sid, "kinds": ["individuel", "duo"]})
    assert rb.status_code == 201
    if rb.json()["status"] == "en_attente":
        client.post(f"/booking/requests/{rb.json()['id']}/accept", json={})
    # ils jouent à deux: chacun paie le prix du duo (Ali, seul jusque-là, payait le prix solo)
    prices = {x["name"]: x["price_millimes"] for x in client.get("/booking/requests").json() if x["name"] in ("Ali", "Bea")}
    sess = next(x for x in client.get("/sessions").json() if x["id"] == sid)
    assert sess["kind"] == "duo" and all(v == 40000 for v in prices.values()) or prices == {}
    c, pc = player_client(client, name="Cyr", phone="20333333")
    assert pc.post("/me/book", json={"session_id": sid}).status_code == 409  # complète: le duo reste à 2


# --- Groupes formés par les joueurs: minimum de joueurs, 24 h, 6 h, invitations ----

def _future_slot(pc, min_hours, hour_utc=None):
    now = datetime.now(timezone.utc)
    for x in pc.get("/me/slots").json():
        t = datetime.fromisoformat(x.replace("Z", "+00:00"))
        t = t if t.tzinfo else t.replace(tzinfo=timezone.utc)
        if t - now >= timedelta(hours=min_hours) and (hour_utc is None or t.hour == hour_utc):
            return x


def test_group_waits_for_minimum_then_confirms_and_notifies(client):
    from app.notify import Notifier
    open_week(client, auto_confirm=False)
    a, pa = player_client(client, name="Amel", phone="20111111", gender="F", category="P250+")  # les hommes P250-: 1 cran de moins
    b, pb = player_client(client, name="Bilel", phone="20222222", category="P250-")
    c, pc = player_client(client, name="Chedly", phone="20333333", category="P250-")
    start = _future_slot(pa, 30)
    day = _day_of(start)
    free_court(client, start)
    # Amel veut s'entraîner à deux ou plus: elle prend le créneau (terrain réservé) en duo, le coach accepte
    r = pa.post("/me/book", json={"kind": "duo", "start": start, "kinds": ["duo", "groupe"]}).json()
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    req = next(x for x in client.get("/booking/requests").json() if x["id"] == r["id"])
    assert req["status"] == "attente_joueurs" and (req["players_count"], req["min_needed"]) == (1, 2)
    assert client.get("/booking/summary").json()["waiting_players"] == 1
    assert pa.get("/me/sessions").json()["upcoming"][0]["status"] == "attente_joueurs"
    # une joueuse qui veut s'entraîner seule ne se voit pas proposer cette séance
    solo = pc.get(f"/me/offers?day={day}&kinds=individuel").json()
    assert solo["groups"] == [] and solo["other_kinds"] == {"duo": 1}
    # Bilel (à deux ou plus) la rejoint, le coach accepte: la séance atteint le minimum, Amel est prévenue
    g = pb.get(f"/me/offers?day={day}&kinds=duo,groupe").json()["groups"]
    assert len(g) == 1 and g[0]["missing"] == 0 and g[0]["kind"] == "duo"
    Notifier.sent.clear()
    rb = pb.post("/me/book", json={"session_id": g[0]["session_id"], "kinds": ["duo", "groupe"]}).json()
    client.post(f"/booking/requests/{rb['id']}/accept", json={})
    assert pa.get("/me/sessions").json()["upcoming"][0]["status"] == "confirmee"
    assert any("1 joueur a rejoint" in body and "confirmée" in body for _, _, body in Notifier.sent)
    # les deux acceptent un groupe: la séance reste visible pour qui cherche un groupe (3e joueur)
    g = pc.get(f"/me/offers?day={day}&kinds=groupe").json()["groups"]
    assert len(g) == 1 and g[0]["kind"] == "groupe" and g[0]["spots_left"] == 2


def test_cannot_open_group_alone_within_24h(client):
    open_week(client)
    p, pc = player_client(client)
    soon = pc.get("/me/slots").json()[0]  # dans moins de 24 h
    off = pc.get(f"/me/offers?day={_day_of(soon)}&kinds=groupe").json()
    assert soon[:16] not in [x["start"][:16] for x in off["slots_with_court"] + off["slots_other"]] and "groupe" in off["too_late"]
    assert pc.post("/me/book", json={"kind": "groupe", "start": soon, "kinds": ["groupe"]}).status_code == 409
    assert pc.post("/me/book", json={"kind": "individuel", "start": soon, "kinds": ["individuel", "groupe"]}).status_code == 201


def test_six_hours_before_players_can_reconsider(client):
    from app.notify import Notifier
    from app.services.booking import remind_incomplete
    open_week(client, auto_confirm=False)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 100000})
    start = _future_slot(pc, 30)
    r = pc.post("/me/book", json={"kind": "duo", "start": start, "kinds": ["duo"]}).json()  # à deux uniquement
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    assert pc.get("/me").json()["credits_millimes"] == 60000  # 40 TND (duo) débités à la validation
    Notifier.sent.clear()
    db = TestSession()
    when = datetime.fromisoformat(start.replace("Z", "+00:00"))
    when = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
    assert remind_incomplete(db, now=when - timedelta(hours=7)) == 0  # trop tôt
    assert remind_incomplete(db, now=when - timedelta(hours=5)) == 1
    assert remind_incomplete(db, now=when - timedelta(hours=4)) == 0  # une seule fois
    db.close()
    assert "pas encore assez de joueurs (1/2)" in Notifier.sent[-1][2]
    # il passe en solo: la séance est confirmée, prix du solo (60 TND), différence débitée
    out = pc.post(f"/me/bookings/{r['id']}/formula", json={"kind": "individuel"}).json()
    assert out["status"] == "confirmee" and out["price_millimes"] == 60000 and out["credits_millimes"] == 40000  # 20 TND de plus débités
    # annuler une demande dont le groupe ne s'est pas formé est toujours remboursé
    p2, pc2 = player_client(client, name="Ines", phone="20999999")
    r2 = pc2.post("/me/book", json={"kind": "duo", "start": _future_slot(pc2, 30), "kinds": ["duo"]}).json()
    client.post(f"/booking/requests/{r2['id']}/accept", json={})
    assert pc2.post(f"/me/bookings/{r2['id']}/cancel").json()["refunded"] is True


def test_coach_invites_players_who_trained_with_him(client, monkeypatch):
    monkeypatch.setattr('app.notify.EMAIL_ONLY', False)  # choix du joueur (WhatsApp, SMS, e-mail): version après la bêta
    from app.notify import Notifier
    open_week(client)
    host = mkplayer(client, name="Host", category="P250-")
    ok = mkplayer(client, phone="22 000 001", name="Ancien", category="P250+", contact_channel="whatsapp")
    far = mkplayer(client, phone="22 000 002", name="TropFort", category="P1000-")
    mkplayer(client, phone="22 000 003", name="Nouveau", category="P250-")  # jamais entraîné
    for h, pid in ((10, ok["id"]), (12, far["id"])):  # le coach n'est pas à deux séances en même temps
        s = client.post("/sessions", json={"start": f"2026-01-05T{h}:00:00Z", "player_ids": [pid]}).json()[0]
        client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    g = open_duo(client, host, hours=72, kind="groupe")
    inv = client.get(f"/sessions/{g['id']}/invitable").json()
    # tous les joueurs de niveau compatible, ceux déjà entraînés chez lui d'abord (TropFort: trop d'écart)
    assert [(p["name"], p["trained"]) for p in inv["players"]] == [("Ancien", True), ("Nouveau", False)] and inv["spots_left"] == 3
    Notifier.sent.clear()
    assert client.post(f"/sessions/{g['id']}/invite", json={"player_ids": [ok["id"], far["id"]]}).json()["sent"] == 1  # TropFort ignoré
    assert Notifier.sent[0][0] == "whatsapp" and "en groupe" in Notifier.sent[0][2]
    assert [p["name"] for p in client.get("/groups").json()[0]["proposed"]] == ["Ancien"]  # proposition visible dans son appli



def test_price_follows_the_formula_actually_played(client):
    open_week(client, auto_confirm=False)
    a, pa = player_client(client, name="Ali", phone="20111111")
    b, pb = player_client(client, name="Bea", phone="20222222")
    s, ps = player_client(client, name="Solo", phone="20333333")
    for p in (a, b, s):
        client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 100000})
    start = _future_slot(pa, 54)  # à plus de 48 h: un duo peut encore être annulé
    bal = lambda pc: pc.get("/me").json()["credits_millimes"]  # noqa: E731
    # Ali accepte seul ou à deux: validé seul, il paie le solo (60)
    r = pa.post("/me/book", json={"kind": "individuel", "start": start, "kinds": ["individuel", "duo"]}).json()
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    assert pa.get("/me/sessions").json()["upcoming"][0]["status"] in ("confirmee", "acceptee") and bal(pa) == 40000
    # Bea le rejoint: ils jouent à deux, chacun paie le duo (40): Ali récupère 20
    sid = next(x["id"] for x in client.get("/sessions").json() if x["player_ids"] == [a["id"]])
    rb = pb.post("/me/book", json={"session_id": sid, "kinds": ["duo"]}).json()
    assert rb["price_millimes"] == 40000
    client.post(f"/booking/requests/{rb['id']}/accept", json={})
    assert bal(pa) == 60000 and bal(pb) == 60000
    # Bea annule (dans les délais): Ali rejoue seul et repaie le solo
    pb.post(f"/me/bookings/{rb['id']}/cancel")
    assert bal(pa) == 40000 and bal(pb) == 100000
    # qui n'a coché que « seul » reste seul: personne ne peut le rejoindre, il paie le solo
    start2 = _future_slot(ps, 54)
    r2 = ps.post("/me/book", json={"kind": "individuel", "start": start2, "kinds": ["individuel"]}).json()
    client.post(f"/booking/requests/{r2['id']}/accept", json={})
    sid2 = next(x["id"] for x in client.get("/sessions").json() if x["player_ids"] == [s["id"]])
    assert pb.post("/me/book", json={"session_id": sid2, "kinds": ["individuel", "duo", "groupe"]}).status_code == 409
    assert bal(ps) == 40000


def test_recurring_manual_courts(client):
    club = mkclub(client)
    from app.services.common import TUNIS
    tomorrow = (datetime.now(TUNIS) + timedelta(days=1)).date()
    start = datetime.combine(tomorrow, datetime.min.time().replace(hour=9), TUNIS).isoformat()
    # tous les jours de 9 h à 10 h pendant une semaine
    r = client.post("/court-bookings/manual", json={"club_id": club["id"], "start": start, "duration_min": 60, "repeat": "daily",
                                                     "until": (tomorrow + timedelta(days=6)).isoformat()}).json()
    assert r["created"] == 7 and r["series_id"]
    free = [c for c in client.get("/court-bookings").json() if c["free"]]
    assert len(free) == 7 and all(datetime.fromisoformat(c["start"]).replace(tzinfo=timezone.utc).astimezone(TUNIS).hour == 9 for c in free)
    # chaque lundi de 17 h à 18 h pendant 4 semaines; les créneaux déjà saisis sont sautés
    monday = tomorrow + timedelta(days=(7 - tomorrow.weekday()) % 7)
    st2 = datetime.combine(monday, datetime.min.time().replace(hour=17), TUNIS).isoformat()
    r2 = client.post("/court-bookings/manual", json={"club_id": club["id"], "start": st2, "repeat": "weekly", "weekdays": [0],
                                                      "until": (monday + timedelta(weeks=3)).isoformat()}).json()
    assert r2["created"] == 4
    again = client.post("/court-bookings/manual", json={"club_id": club["id"], "start": st2, "repeat": "weekly", "weekdays": [0],
                                                         "until": (monday + timedelta(weeks=3)).isoformat()})
    assert again.status_code == 409  # déjà saisis
    assert client.post("/court-bookings/manual", json={"club_id": club["id"], "start": st2, "repeat": "daily",
                                                        "until": (monday + timedelta(days=400)).isoformat()}).status_code == 422
    # supprimer la série à partir du 3e jour: les 2 premiers restent
    third = sorted((c for c in client.get("/court-bookings").json() if c["series_id"] == r["series_id"]), key=lambda c: c["start"])[2]
    assert client.delete(f"/court-bookings/{third['id']}?series=true").json()["deleted"] == 5
    assert len([c for c in client.get("/court-bookings").json() if c["series_id"] == r["series_id"]]) == 2



def test_slots_only_on_reserved_courts_by_default(client):
    from app.services.common import TUNIS
    open_week(client)
    st = client.get("/booking/settings").json()
    client.put("/booking/settings", json={**st, "booking_mode": "terrains"})
    p, pc = player_client(client)
    assert pc.get("/me/slots").json() == []  # aucun terrain réservé: rien à proposer
    club = mkclub(client)
    day = (datetime.now(TUNIS) + timedelta(days=3)).date()
    start = datetime.combine(day, datetime.min.time().replace(hour=8), TUNIS)
    client.post("/court-bookings/manual", json={"club_id": club["id"], "start": start.isoformat(), "duration_min": 240})  # mardi 8 h-12 h
    slots = pc.get("/me/slots").json()
    local = [datetime.fromisoformat(x.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).astimezone(TUNIS) for x in slots]
    # tout début qui ne laisse pas de bout de terrain de moins d'1 h (jamais 8 h 30 ni 10 h 30)
    assert {t.date() for t in local} == {day} and [t.strftime("%H:%M") for t in local] == ["08:00", "09:00", "09:30", "10:00", "11:00"]
    off = pc.get(f"/me/offers?day={day.isoformat()}&kinds=individuel").json()
    assert len(off["slots_with_court"]) == 5 and off["slots_other"] == []
    # réservation de 8 h (validée: terrain libre): la séance prend 8 h-9 h, le reste du bloc reste libre
    assert pc.post("/me/book", json={"kind": "individuel", "start": slots[0]}).json()["status"] == "confirmee"
    left = [datetime.fromisoformat(x.replace("Z", "+00:00")).astimezone(TUNIS).strftime("%H:%M") for x in pc.get("/me/slots").json()]
    assert left == ["09:00", "10:00", "11:00"]  # 9 h 30 laisserait une demi-heure perdue après la séance de 8 h
    free = sorted((c for c in client.get("/court-bookings").json() if c["free"]), key=lambda c: c["start"])
    assert [(datetime.fromisoformat(c["start"].replace("Z", "+00:00")).astimezone(TUNIS).strftime("%H:%M"), c["duration_min"]) for c in free] == [("09:00", 180)]
    # le coach monte lui-même une séance à 10 h dans ce club: elle utilise le terrain libre (pas de doublon)
    s10 = datetime.combine(day, datetime.min.time().replace(hour=10), TUNIS).isoformat()
    client.post("/sessions", json={"start": s10, "club_id": club["id"], "court_booked": True})
    assert sum(1 for c in client.get("/court-bookings").json() if c["free"]) == 2  # 9 h-10 h et 11 h-12 h


def test_court_calendar_states(client):
    open_week(client, auto_confirm=False)
    club = mkclub(client)
    p, pc = player_client(client)
    start = _future_slot(pc, 30)
    free_court(client, start, minutes=240)  # terrain réservé, aucun joueur
    states = lambda: sorted(c["state"] for c in client.get("/court-bookings").json() if c["state"] != "annule")  # noqa: E731
    assert states() == ["libre"]
    r = pc.post("/me/book", json={"kind": "duo", "start": start, "kinds": ["duo"]}).json()
    rq = next(x for x in client.get("/booking/requests").json() if x["id"] == r["id"])
    client.post(f"/booking/requests/{r['id']}/accept", json={"court_booking_id": rq["courts_available"][0]["id"]})
    assert states() == ["incomplet", "libre"]  # 1 joueur sur 2 voulus; le reste du bloc reste libre
    host = mkplayer(client, phone="22 777 777", name="Host")
    later = (datetime.now(timezone.utc) + timedelta(days=5)).replace(minute=0, second=0, microsecond=0)
    client.post("/sessions", json={"start": later.isoformat(), "player_ids": [host["id"]], "club_id": club["id"]})  # SMS au club: demande
    assert states() == ["demande", "incomplet", "libre"]
    cb = next(c for c in client.get("/court-bookings").json() if c["state"] == "demande")
    client.post(f"/court-bookings/{cb['id']}/reply", json={"text": "OUI c'est bon"})
    assert states() == ["complet", "incomplet", "libre"]


# --- Inscription par lien, validation par l'administrateur, portefeuille par coach ---

def test_signup_link_prefilled_and_admin_validation(client, monkeypatch):
    from app.notify import OUTBOX
    other = register("other@b.tn")  # coach inscrit avant l'arrivée d'un administrateur: pas de confirmation
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    OUTBOX.clear()
    # à l'ajout d'un élève, le lien d'inscription pré-rempli est déjà prêt
    p = mkplayer(client, name="Sami Ben Ali", category="P250-")
    assert p["invite_path"].startswith("/invite/")
    token = p["invite_path"].split("/")[-1]
    anon = TestClient(app)
    info = anon.get(f"/auth/invite/{token}").json()
    assert (info["player_name"], info["phone"], info["category"]) == ("Sami Ben Ali", "+21622123456", "P250-")
    # le joueur complète et corrige son niveau
    anon.post(f"/auth/invite/{token}", json={"email": "sami@x.tn", "password": "secret1", "category": "P500-"})
    assert any(to == "boss@padel.tn" and "Sami Ben Ali" in body and "P250-" in body for to, _, body in OUTBOX)
    # doublon chez un autre coach (même téléphone)
    mkplayer(other, name="Sami B.", phone="+216 22123456")
    # un coach ordinaire n'a pas accès à l'administration
    assert client.get("/admin/signups").status_code == 403
    assert "admin" not in client.get("/booking/summary").json()
    boss = register("boss@padel.tn")
    assert boss.get("/booking/summary").json()["signups"] == 1
    [s] = boss.get("/admin/signups").json()
    assert (s["category"], s["invited_category"]) == ("P500-", "P250-")
    assert s["duplicates"][0]["why"] == ["même téléphone"]
    r = boss.post(f"/admin/signups/{s['id']}/validate", json={"category": "P250+"}).json()
    assert (r["status"], r["category"]) == ("validee", "P250+")
    assert boss.get("/booking/summary").json()["signups"] == 0


def test_refused_signup_closes_the_account(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    p, pc = player_client(client)
    boss = register("boss@padel.tn")
    assert boss.post(f"/admin/signups/{p['id']}/refuse").json()["ok"]
    assert pc.get("/me").status_code == 401
    assert TestClient(app).post("/auth/login", json={"email": f"p{p['id']}@x.tn", "password": "secret1"}).status_code == 401
    assert client.get("/players").json()[0]["has_account"] is False  # le coach peut renvoyer un lien


def test_coach_sees_only_own_players(client):
    mkplayer(client, name="Mon élève")
    other = register("other@b.tn")
    q = mkplayer(other, name="Élève d'un autre", phone="98 765 432")
    assert [p["name"] for p in client.get("/players").json()] == ["Mon élève"]
    assert client.put(f"/players/{q['id']}", json={"name": "x", "phone": "22 000 000"}).status_code == 404
    assert client.post(f"/players/{q['id']}/credits", json={"amount_millimes": 1000}).status_code == 404


def test_wallet_per_coach_with_credits_and_dues(client):
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 200000})
    s = client.post("/sessions", json={"start": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(), "kind": "individuel",
                                       "price_millimes": 60000, "player_ids": [p["id"]]}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    # la séance effectuée est payée avec les crédits: un seul solde, jamais solde et impayé en même temps
    [w] = pc.get("/me").json()["wallets"]
    assert (w["coach_name"], w["credits_millimes"], w["due_millimes"]) == ("Coach Test", 140000, 0)
    assert client.get("/sessions").json()[0]["payments"][0]["credit_millimes"] == 60000
    # retour à « prévue »: crédits rendus; de nouveau effectuée: débités une seule fois
    client.patch(f"/sessions/{s['id']}", json={"status": "prevue"})
    assert pc.get("/me").json()["wallets"][0]["credits_millimes"] == 200000
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    assert pc.get("/me").json()["wallets"][0]["credits_millimes"] == 140000


def test_no_credits_means_debt_then_recharge_settles_it(client):
    p, pc = player_client(client)
    for d in (2, 1):
        s = client.post("/sessions", json={"start": (datetime.now(timezone.utc) - timedelta(days=d)).isoformat(), "kind": "individuel",
                                           "price_millimes": 60000, "player_ids": [p["id"]]}).json()[0]
        client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    w = pc.get("/me").json()["wallets"][0]
    assert (w["credits_millimes"], w["due_millimes"]) == (0, 120000)  # rien en crédits: dans le rouge
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 200000})  # la recharge règle les deux séances
    w = pc.get("/me").json()["wallets"][0]
    assert (w["credits_millimes"], w["due_millimes"]) == (80000, 0)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 0})  # refusé, sans effet
    p2, pc2 = player_client(client, phone="98 111 222", name="Ali")
    client.post(f"/players/{p2['id']}/credits", json={"amount_millimes": 50000})
    s = client.post("/sessions", json={"start": (datetime.now(timezone.utc) - timedelta(days=1, hours=3)).isoformat(), "kind": "individuel",
                                       "price_millimes": 60000, "player_ids": [p2["id"]]}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    w = pc2.get("/me").json()["wallets"][0]
    assert (w["credits_millimes"], w["due_millimes"]) == (0, 10000)  # crédits insuffisants: le reste en impayé


def test_late_cancel_replaced_by_another_player(client):
    """Après le délai (24 h seul, 48 h à deux ou en groupe), le joueur envoie un lien: un autre joueur prend sa place,
    paie avec ses crédits, et celui qui part récupère les siens."""
    open_week(client)
    p, pc = player_client(client, category="P250-")
    q, qc = player_client(client, name="Rim", phone="20111222", category="P250-")
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 100000})
    start = _future_slot(pc, 30)  # entre 24 et 48 h: un duo ne peut plus être annulé
    free_court(client, start)
    r = pc.post("/me/book", json={"kind": "duo", "start": start, "kinds": ["duo"]}).json()
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    sid = next(x["id"] for x in client.get("/sessions").json() if x["player_ids"] == [p["id"]])
    client.post(f"/booking/requests/{qc.post('/me/book', json={'session_id': sid, 'kinds': ['duo']}).json()['id']}/accept", json={})
    assert pc.post(f"/me/bookings/{r['id']}/cancel").status_code == 409
    path = pc.post(f"/me/bookings/{r['id']}/replacement").json()["path"]
    token = path.split("/")[-1]
    anon = TestClient(app)
    info = anon.get(f"/replace/{token}").json()
    assert info["leaving"] == "Sami" and info["coach_name"] == "Coach Test"
    assert pc.post(f"/replace/{token}/take").status_code == 409  # pas sa propre place
    # un ami sans compte s'inscrit depuis le lien et prend la place (dans le rouge: pas encore de crédits)
    out = anon.post(f"/replace/{token}/signup", json={"name": "Ali Ben Salah", "phone": "98 123 000", "email": "ali@x.tn",
                                                      "password": "secret1", "category": "P250+"}).json()
    ali = login_as(TestClient(app), out["token"])
    [mine] = ali.get("/me/sessions").json()["upcoming"]
    assert mine["status"] in ("confirmee", "acceptee", "attente_joueurs")
    w = ali.get("/me").json()["wallets"][0]
    assert w["due_millimes"] == r["price_millimes"]
    assert pc.get("/me").json()["wallets"][0]["credits_millimes"] == 100000  # Sami récupère ses crédits
    assert pc.get("/me/sessions").json()["upcoming"] == []
    names = {x["name"] for x in client.get("/players").json()}
    assert "Ali Ben Salah" in names  # le remplaçant devient élève du coach
    assert anon.get(f"/replace/{token}").status_code == 404  # lien à usage unique


def test_replacement_requires_compatible_level(client):
    open_week(client)
    p, pc = player_client(client, category="P1000-")
    q, qc = player_client(client, name="Rim", phone="20111222", category="P1000-")
    start = _future_slot(pc, 30)
    free_court(client, start)
    r = pc.post("/me/book", json={"kind": "duo", "start": start, "kinds": ["duo"]}).json()
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    sid = next(x["id"] for x in client.get("/sessions").json() if x["player_ids"] == [p["id"]])
    r2 = qc.post("/me/book", json={"session_id": sid, "kinds": ["duo"]}).json()
    client.post(f"/booking/requests/{r2['id']}/accept", json={})
    token = qc.post(f"/me/bookings/{r2['id']}/replacement").json()["path"].split("/")[-1]
    _, low = player_client(client, name="Novice", phone="20333444", category="P25-")
    assert low.post(f"/replace/{token}/take").status_code == 409  # trop d'écart avec Sami


def test_coach_made_session_can_be_cancelled_or_handed_over(client):
    """Séance montée par le coach (sans réservation en ligne): mêmes règles que les réservations du joueur."""
    p, pc = player_client(client, category="P250-")
    q, qc = player_client(client, name="Rim", phone="20111222", category="P250-")
    far = (datetime.now(timezone.utc) + timedelta(days=5)).replace(minute=0, second=0, microsecond=0)
    near = (datetime.now(timezone.utc) + timedelta(hours=30)).replace(minute=0, second=0, microsecond=0)
    s1 = client.post("/sessions", json={"start": far.isoformat(), "kind": "duo", "price_millimes": 80000, "price_mode": "groupe", "player_ids": [p["id"], q["id"]]}).json()[0]
    s2 = client.post("/sessions", json={"start": near.isoformat(), "kind": "duo", "price_millimes": 80000, "price_mode": "groupe", "player_ids": [p["id"], q["id"]]}).json()[0]
    up = {x["session_id"]: x for x in pc.get("/me/sessions").json()["upcoming"]}
    assert up[s1["id"]]["can_cancel"] is True and up[s2["id"]]["can_cancel"] is False  # duo: 48 h avant
    # annulation dans les délais: Sami quitte la séance, Rim reste
    b1 = pc.post(f"/me/sessions/{s1['id']}/booking").json()["booking_id"]
    assert pc.post(f"/me/bookings/{b1}/cancel").status_code == 200
    assert next(x for x in client.get("/sessions").json() if x["id"] == s1["id"])["player_ids"] == [q["id"]]
    # hors délai: pas d'annulation, mais un lien pour se faire remplacer
    b2 = pc.post(f"/me/sessions/{s2['id']}/booking").json()["booking_id"]
    assert pc.post(f"/me/bookings/{b2}/cancel").status_code == 409
    token = pc.post(f"/me/bookings/{b2}/replacement").json()["path"].split("/")[-1]
    _, ali = player_client(client, name="Ali", phone="20333444", category="P250+")
    assert ali.post(f"/replace/{token}/take").status_code == 200
    names = {pl["id"]: pl["name"] for pl in client.get("/players").json()}
    assert sorted(names[i] for i in next(x for x in client.get("/sessions").json() if x["id"] == s2["id"])["player_ids"]) == ["Ali", "Rim"]


def test_beta_everything_by_email(client):
    """Version bêta: tous les messages aux joueurs partent par e-mail, quel que soit leur choix; le coach reçoit
    aussi les siens (demande, annulation)."""
    from app.notify import OUTBOX, Notifier
    open_week(client, auto_confirm=False)
    p, pc = player_client(client, contact_channel="whatsapp")
    OUTBOX.clear()
    Notifier.sent.clear()
    r = pc.post("/me/book", json={"kind": "individuel", "start": _future_slot(pc, 60)}).json()
    assert ("a@b.tn", "Nouvelle demande de Sami") in [(to, subj) for to, subj, _ in OUTBOX]  # e-mail au coach
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    assert all(ch == "email" for ch, _, _ in Notifier.sent) and Notifier.sent
    assert any(subj == "Votre séance de padel est confirmée" for _, subj, _ in OUTBOX)
    pc.post(f"/me/bookings/{r['id']}/cancel")
    assert any(subj == "Sami a annulé" for _, subj, _ in OUTBOX)
    # refus et recharge: e-mails aussi
    r2 = pc.post("/me/book", json={"kind": "individuel", "start": _future_slot(pc, 80)}).json()
    client.post(f"/booking/requests/{r2['id']}/refuse")
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 50000})
    subjects = [subj for to, subj, _ in OUTBOX if to == f"p{p['id']}@x.tn"]
    assert "Votre demande de séance n'a pas pu être acceptée" in subjects and "Recharge de crédits" in subjects


def test_coach_announces_free_court_to_chosen_players(client):
    from app.notify import OUTBOX
    p, pc = player_client(client)
    q, qc = player_client(client, name="Rim", phone="20111222")
    start = (datetime.now(timezone.utc) + timedelta(days=3)).replace(minute=0, second=0, microsecond=0)
    cb = free_court(client, start.isoformat(), minutes=240)
    data = client.get(f"/court-bookings/{cb['id']}/announce").json()
    assert {x["name"] for x in data["players"]} == {"Sami", "Rim"} and "créneau est disponible" in data["message"] and " à " in data["message"]
    OUTBOX.clear()
    assert client.post(f"/court-bookings/{cb['id']}/announce", json={"player_ids": [q["id"]], "message": ""}).json()["sent"] == 1
    assert [to for to, _, _ in OUTBOX] == [f"p{q['id']}@x.tn"]  # seulement le joueur choisi
    other = register("other@b.tn")
    assert other.get(f"/court-bookings/{cb['id']}/announce").status_code == 404


def test_complete_session_from_planning_opens_it(client):
    """Séance à deux montée par le coach, fermée: l'inviter l'ouvre, le joueur invité peut accepter."""
    a = mkplayer(client, name="Ali")
    p, pc = player_client(client, name="Rim", phone="20111222")
    past = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    s0 = client.post("/sessions", json={"start": past, "kind": "individuel", "player_ids": [p["id"]]}).json()[0]
    client.patch(f"/sessions/{s0['id']}", json={"status": "effectuee"})  # Rim s'est déjà entraînée ici
    start = (datetime.now(timezone.utc) + timedelta(days=3)).replace(minute=0, second=0, microsecond=0).isoformat()
    s = client.post("/sessions", json={"start": start, "kind": "duo", "open": False, "player_ids": [a["id"]]}).json()[0]
    assert [x["id"] for x in client.get(f"/sessions/{s['id']}/invitable").json()["players"]] == [p["id"]]
    client.post(f"/sessions/{s['id']}/invite", json={"player_ids": [p["id"]]})
    prop = pc.get("/me/proposals").json()[0]
    assert pc.post(f"/me/proposals/{prop['id']}/accept").status_code == 200
    assert sorted(next(x for x in client.get("/sessions").json() if x["id"] == s["id"])["player_ids"]) == sorted([a["id"], p["id"]])


def test_admin_manages_players_coaches_and_clubs(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    boss = register("boss@padel.tn")
    assert client.get("/admin/players").status_code == 403  # réservé à l'administrateur
    # un coach ajouté par l'administrateur peut se connecter
    new = boss.post("/admin/coaches", json={"name": "Coach Neuf", "email": "neuf@padel.tn"}).json()
    assert TestClient(app).post("/auth/login", json={"email": "neuf@padel.tn", "password": new["password"]}).json()["role"] == "coach"
    # élève ajouté chez un coach: dans sa liste, avec son lien d'inscription
    coach_id = next(c["id"] for c in boss.get("/admin/coaches").json() if c["email"] == "a@b.tn")
    added = boss.post("/admin/players", json={"name": "Lina", "phone": "20 000 111", "coach_id": coach_id}).json()
    assert added["invite_path"].startswith("/invite/") and [p["name"] for p in client.get("/players").json()] == ["Lina"]
    # joueur avec compte chez deux coachs: supprimer la fiche compte garde l'accès chez l'autre coach
    p, pc = player_client(client, name="Sami", phone="22 123 456")
    other = register("other@b.tn")
    assert other.get("/booking/settings").status_code == 403  # en attente de l'administrateur
    confirm_coach(boss, "other@b.tn")
    other.put("/booking/settings", json={"auto_confirm": False, "slot_minutes": 60, "price_individuel": 60000, "price_duo": 40000,
                                         "price_groupe": 30000, "cancel_hours": 24, "booking_mode": "disponibilites",
                                         "availability": [{"weekday": d, "start_time": "09:00", "end_time": "21:00"} for d in range(7)]})
    other_id = next(c["id"] for c in boss.get("/admin/coaches").json() if c["email"] == "other@b.tn")
    when = (datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=9, minute=0, second=0, microsecond=0)  # 10 h à Tunis
    assert pc.post("/me/book", json={"kind": "individuel", "start": when.isoformat(), "coach_id": other_id}).status_code == 201
    s = client.post("/sessions", json={"start": (datetime.now(timezone.utc) + timedelta(days=4)).isoformat(), "kind": "individuel", "player_ids": [p["id"]]}).json()[0]
    assert boss.delete(f"/admin/players/{p['id']}").json()["ok"]
    assert next(x for x in client.get("/sessions").json() if x["id"] == s["id"])["status"] == "annulee"  # restée vide
    again = TestClient(app).post("/auth/login", json={"email": f"p{p['id']}@x.tn", "password": "secret1"}).json()
    assert again["role"] == "player"  # la fiche chez l'autre coach est devenue le compte
    # supprimer un coach: ses élèves et ses séances disparaissent
    assert boss.delete(f"/admin/coaches/{coach_id}").json()["ok"]
    assert all(x["coach_id"] != coach_id for x in boss.get("/admin/players").json())
    assert client.get("/players").status_code == 401
    # clubs: ajout au catalogue, puis retrait
    boss.post("/admin/clubs", json={"name": "Padel Arena Sousse", "phone": "73 000 000"})
    assert "Padel Arena Sousse" in [c["name"] for c in other.get("/clubs/catalog").json()["known"]]
    assert boss.delete("/admin/clubs/padel arena sousse").json()["ok"]
    assert "Padel Arena Sousse" not in [c["name"] for c in other.get("/clubs/catalog").json()["known"]]
    assert boss.delete(f"/admin/coaches/{next(c['id'] for c in boss.get('/admin/coaches').json() if c['email'] == 'boss@padel.tn')}").status_code == 409


def test_player_contact_must_be_unique(client):
    p, pc = player_client(client, name="Sami")
    mine = pc.get("/me").json()["email"]
    # e-mail déjà pris (joueur, ou compte coach, quelle que soit la casse) ou téléphone déjà dans mes joueurs: refusé
    r = client.post("/players", json={"name": "Neuf", "phone": "20 999 000", "email": mine.upper()})
    assert r.status_code == 409 and "Sami" in r.json()["detail"]
    r = client.post("/players", json={"name": "Neuf", "phone": "20 999 000", "email": "A@B.tn"})
    assert r.status_code == 409 and "coach" in r.json()["detail"]
    r = client.post("/players", json={"name": "Neuf", "phone": "22 123 456"})
    assert r.status_code == 409 and "numéro" in r.json()["detail"]
    # vérification pendant la saisie
    chk = client.get("/players/check", params={"email": mine, "phone": "22123456"}).json()
    assert chk["email"] and chk["phone"]
    assert client.get("/players/check", params={"email": "libre@x.tn", "phone": "20 999 000"}).json() == {"email": None, "phone": None}
    assert client.get("/players/check", params={"email": mine, "phone": "22123456", "exclude": p["id"]}).json() == {"email": None, "phone": None}
    # un autre coach peut avoir le même numéro (même personne chez deux coachs)
    assert register("other@b.tn").post("/players", json={"name": "Sami", "phone": "22 123 456"}).status_code == 201


def test_signup_never_fails_when_email_sending_fails(client, monkeypatch):
    """SMTP mal réglé: l'inscription aboutit quand même (l'e-mail est seulement journalisé comme non envoyé)."""
    import smtplib
    monkeypatch.setenv("SMTP_HOST", "smtp.invalid")
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "0")
    monkeypatch.setattr(smtplib, "SMTP", lambda *a, **k: (_ for _ in ()).throw(OSError("serveur injoignable")))
    p = client.post("/players", json={"name": "Lina", "phone": "20 777 888", "email": "a@b.tn"})
    assert p.status_code == 409  # e-mail du coach: refusé dès la création
    p = client.post("/players", json={"name": "Lina", "phone": "20 777 888"}).json()
    anon = TestClient(app)
    r = anon.post(f"/auth/invite/{p['invite_path'].split('/')[-1]}", json={"email": "a@b.tn", "password": "secret1"})
    assert r.status_code == 409 and "déjà utilisée" in r.json()["detail"]
    r = anon.post(f"/auth/invite/{p['invite_path'].split('/')[-1]}", json={"email": "lina@x.tn", "password": "secret1"})
    assert r.status_code == 200 and r.json()["role"] == "player"


def test_admin_full_rights_act_as_and_edit_everything(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    boss = register("boss@padel.tn")
    coach_id = next(c["id"] for c in boss.get("/admin/coaches").json() if c["email"] == "a@b.tn")
    p, pc = player_client(client, name="Sami")
    # l'administrateur agit dans l'espace du coach: mêmes droits (ici: annuler une séance)
    tok = boss.post(f"/admin/coaches/{coach_id}/act").json()
    as_coach = login_as(TestClient(app), tok["token"])
    s = as_coach.post("/sessions", json={"start": (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(), "player_ids": [p["id"]]}).json()[0]
    assert as_coach.patch(f"/sessions/{s['id']}", json={"status": "annulee"}).json()["status"] == "annulee"
    assert client.get("/sessions").json()[0]["status"] == "annulee"  # c'est bien le planning du coach
    # ... et dans l'espace du joueur
    as_player = login_as(TestClient(app), boss.post(f"/admin/players/{p['id']}/act").json()["token"])
    assert as_player.get("/me").json()["name"] == "Sami"
    assert client.post(f"/admin/coaches/{coach_id}/act").status_code == 403  # un coach ordinaire ne peut pas
    # modifier e-mail de connexion, mot de passe, téléphone: même ce qu'un coach ne peut pas toucher
    r = boss.put(f"/admin/players/{p['id']}", json={"name": "Sami B.", "phone": "20 111 333", "email": "Nouveau@x.tn",
                                                    "category": "P250+", "password": "neuf123"})
    assert r.status_code == 200
    assert TestClient(app).post("/auth/login", json={"email": "nouveau@x.tn", "password": "neuf123"}).json()["role"] == "player"
    # fiche partagée: chez un deuxième coach, la même identité
    other = register("other@b.tn")
    confirm_coach(boss, "other@b.tn")
    from app.db import get_db
    from app.services.accounts import row_for_coach
    db = next(app.dependency_overrides[get_db]())
    from app.models import Coach, Player
    acc = db.get(Player, p["id"])
    row_for_coach(db, acc, db.query(Coach).filter_by(email="other@b.tn").one())
    db.commit()
    db.close()
    client.put(f"/players/{p['id']}", json={"name": "Sami Ben Ali", "phone": "20 111 333", "category": "P500-"})
    assert [(x["name"], x["category"]) for x in other.get("/players").json()] == [("Sami Ben Ali", "P500-")]
    # coach et club modifiables
    assert boss.put(f"/admin/coaches/{coach_id}", json={"name": "Coach Renommé", "email": "a@b.tn"}).status_code == 200
    assert client.get("/booking/settings").status_code == 200
    boss.post("/admin/clubs", json={"name": "Club Test"})
    assert boss.put("/admin/clubs/club test", json={"name": "Club Test Sousse", "phone": "73 111 222"}).status_code == 200
    assert "Club Test Sousse" in [c["name"] for c in boss.get("/admin/clubs").json()]


def test_errors_are_explained_in_plain_french(client):
    """Jamais de liste technique ni de code: chaque refus dit ce qui ne va pas."""
    cases = [
        ({"name": "A", "phone": "123"}, "8 chiffres"),
        ({"name": "A", "phone": "22 123 456", "email": "sansarobase"}, "@"),
        ({"phone": "22 123 456"}, "Nom : ce champ est obligatoire."),
        ({"name": "A", "phone": "22 123 456", "category": "P2000"}, "Niveau invalide"),
    ]
    for body, expected in cases:
        r = client.post("/players", json=body)
        assert r.status_code == 422 and isinstance(r.json()["detail"], str) and expected in r.json()["detail"], r.json()
    r = TestClient(app).post("/auth/register", json={"email": "nouveau@x.tn", "password": "123", "name": "Coach"})
    assert r.json()["detail"] == "Mot de passe trop court : 6 caractères minimum."
    r = TestClient(app).post("/auth/register", json={"email": "pasunemail", "password": "secret1", "name": "Coach"})
    assert "nom@exemple.com" in r.json()["detail"]
    r = TestClient(app).post("/auth/register", json={"email": "A@B.tn", "password": "secret1", "name": "Coach"})
    assert r.status_code == 409 and "déjà un compte" in r.json()["detail"]


def test_stay_logged_in_refresh(client, monkeypatch):
    """« Rester connecté »: le jeton est renouvelé à l'ouverture; pas pour un accès administrateur, ni un compte fermé."""
    r = client.post("/auth/refresh").json()
    assert r["role"] == "coach" and login_as(TestClient(app), r["token"]).get("/players").status_code == 200
    assert TestClient(app).post("/auth/refresh").status_code == 401  # sans jeton
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    boss = register("boss@padel.tn")
    coach_id = next(c["id"] for c in boss.get("/admin/coaches").json() if c["email"] == "a@b.tn")
    acting = login_as(TestClient(app), boss.post(f"/admin/coaches/{coach_id}/act").json()["token"])
    assert acting.post("/auth/refresh").status_code == 409
    p, pc = player_client(client)
    assert pc.post("/auth/refresh").json()["role"] == "player"
    boss.post(f"/admin/signups/{p['id']}/refuse")
    assert pc.post("/auth/refresh").status_code == 401


def test_email_layout_html_and_french():
    """Les e-mails partent en texte et en HTML (paragraphes, détails en gras), déclarés en français."""
    from app.notify import _html, letter
    body = letter("Sami Ben Ali", "Bonne nouvelle : votre séance est confirmée.", [("Quand", "mercredi 4 novembre, de 12h à 13h"), ("Où", "")],
                  "Lien : https://padel.tn", sign="Coach Démo")
    assert body == ("Bonjour Sami,\n\nBonne nouvelle : votre séance est confirmée.\n\nQuand : mercredi 4 novembre, de 12h à 13h"
                    "\n\nLien : https://padel.tn\n\nÀ bientôt,\nCoach Démo")
    page = _html("Sujet", body)
    assert 'lang="fr"' in page and "<b>Quand</b>" in page and '<a href="https://padel.tn"' in page and page.count("<p ") == 5


def test_public_signup_without_coach_then_books_a_coach(client, monkeypatch):
    """Lien public: compte sans coach, invisible des coachs; il en choisit un en réservant et devient son élève."""
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    open_week(client)
    anon = TestClient(app)
    assert anon.post("/auth/signup", json={"name": "Nadia", "phone": "123", "email": "nadia@x.tn", "password": "secret1"}).status_code == 422
    assert anon.post("/auth/signup", json={"name": "Nadia", "phone": "20 444 555", "email": "a@b.tn", "password": "secret1"}).status_code == 409
    r = anon.post("/auth/signup", json={"name": "Nadia Ben Salem", "phone": "20 444 555", "email": "Nadia@x.tn", "password": "secret1", "category": "P250-"})
    assert r.json()["role"] == "player"
    pc = login_as(TestClient(app), r.json()["token"])
    # rien n'est possible avant la confirmation de l'administrateur
    assert pc.get("/me").status_code == 403 and pc.get("/auth/account").json()["pending"] is True
    boss = register("boss@padel.tn")
    [s] = boss.get("/admin/signups").json()
    assert s["coach_name"].startswith("Sans coach")
    boss.post(f"/admin/signups/{s['id']}/validate", json={})
    assert pc.get("/auth/account").json()["pending"] is False
    me = pc.get("/me").json()
    assert (me["coach_name"], me["wallets"], pc.get("/me/slots").json(), pc.get("/me/suggestions").json()) == ("", [], [], [])
    assert pc.get("/me/progress").status_code == 200 and pc.get("/me/sessions").status_code == 200
    assert client.get("/players").json() == []  # aucun coach ne la voit tant qu'elle n'a pas réservé
    # elle choisit le coach en réservant: une fiche est créée chez lui
    coach_id = client.get("/booking/settings").json().get("coach_id") or next(c["id"] for c in pc.get("/me/coaches").json())
    when = (datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=9, minute=0, second=0, microsecond=0)
    assert pc.post("/me/book", json={"kind": "individuel", "start": when.isoformat()}).status_code == 422  # pas encore de coach
    assert pc.post("/me/book", json={"kind": "individuel", "start": when.isoformat(), "coach_id": coach_id}).status_code == 201
    assert [p["name"] for p in client.get("/players").json()] == ["Nadia Ben Salem"]
    me = pc.get("/me").json()
    assert me["coach_name"] == "Coach Test" and len(me["wallets"]) == 1


def test_slots_never_overlap_and_leave_no_unusable_gap(client):
    """Terrain 8 h-12 h: tous les débuts possibles toutes les 30 min, sans laisser de trou de moins d'1 h (ex. pas
    de début à 8 h 30); ceux collés au bord sont « idéaux ». Une séance d'1 h 30 ouverte à 8 h bloque jusqu'à 9 h 30."""
    st = client.get("/booking/settings").json()
    client.put("/booking/settings", json={**st, "auto_confirm": False, "price_individuel": 60000, "price_duo": 40000, "price_groupe": 30000, "booking_mode": "terrains"})
    day = (datetime.now(timezone.utc) + timedelta(days=4)).date()
    eight = datetime(day.year, day.month, day.day, 7, 0, tzinfo=timezone.utc)  # 8 h à Tunis
    free_court(client, eight.isoformat(), minutes=240)
    p, pc = player_client(client)
    hhmm = lambda xs: sorted({(datetime.fromisoformat(x["start"].replace("Z", "+00:00")) + timedelta(hours=1)).strftime("%H:%M") for x in xs})  # noqa: E731
    first = pc.get(f"/me/offers?day={day}&kinds=individuel").json()["slots_with_court"]
    # n'importe quel début toutes les 30 min, sans laisser de bout de terrain de moins d'1 h (jamais 8 h 30 ni 10 h 30)
    assert hhmm(first) == ["08:00", "09:00", "09:30", "10:00", "11:00"]
    assert [x["ideal"] for x in sorted(first, key=lambda x: x["start"])] == [True, False, False, False, True]  # collés au bord
    r = pc.post("/me/book", json={"kind": "groupe", "start": eight.isoformat(), "kinds": ["groupe"], "minutes": 90})
    assert r.status_code == 201
    assert "08:00" in hhmm(pc.get(f"/me/offers?day={day}&kinds=individuel").json()["slots_with_court"])  # demande pas encore traitée: le créneau reste proposé
    client.post(f"/booking/requests/{r.json()['id']}/accept", json={})
    after = pc.get(f"/me/offers?day={day}&kinds=individuel,duo,groupe").json()["slots_with_court"]
    assert hhmm(after)[0] == "09:30" and "09:00" not in hhmm(after)  # à la suite du groupe (8 h-9 h 30)


def test_coach_session_price_comes_from_settings_with_optional_promo(client):
    open_week(client)  # prix: 60 / 40 / 30 TND par joueur
    a, b = mkplayer(client, name="A"), mkplayer(client, name="B")
    start = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    s = client.post("/sessions", json={"start": start, "kind": "duo", "player_ids": [a["id"], b["id"]], "discount_millimes": 0, "price_millimes": 999000}).json()[0]
    assert (s["price_millimes"], s["price_mode"]) == (40000, "par_joueur")  # le prix saisi est ignoré
    later = (datetime.now(timezone.utc) + timedelta(days=3, hours=3)).isoformat()  # pas deux séances en même temps
    s = client.post("/sessions", json={"start": later, "kind": "individuel", "player_ids": [a["id"]], "discount_millimes": 15000}).json()[0]
    assert s["price_millimes"] == 45000  # 60 TND - 15 TND
    assert client.post("/sessions", json={"start": start, "kind": "individuel", "discount_millimes": -1}).status_code == 422


def test_new_session_tells_if_a_court_is_already_booked(client):
    marsa = mkclub(client)
    other = client.post("/clubs", json={"name": "Gammarth Padel", "phone": ""}).json()
    start = (datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=8, minute=0, second=0, microsecond=0)
    free_court(client, start.isoformat(), minutes=240, club=marsa)
    nine = (start + timedelta(hours=1)).isoformat()
    r = client.get("/court-bookings/cover", params={"start": nine, "duration_min": 90, "club_id": marsa["id"]}).json()
    assert r["here"]["club_name"] == "Padel Club La Marsa" and r["elsewhere"] == []
    r = client.get("/court-bookings/cover", params={"start": nine, "duration_min": 90, "club_id": other["id"]}).json()
    assert r["here"] is None and [c["club_name"] for c in r["elsewhere"]] == ["Padel Club La Marsa"]  # « choisir ce club »
    late = (start + timedelta(hours=3, minutes=30)).isoformat()  # dépasse midi: le terrain ne couvre pas
    assert client.get("/court-bookings/cover", params={"start": late, "duration_min": 60, "club_id": marsa["id"]}).json()["busy"].startswith("Vous avez déjà un terrain")


def test_new_coach_waits_for_email_and_admin_then_more_admins(client, monkeypatch):
    """Nouveau coach: e-mail vérifié puis confirmation d'un administrateur avant tout; un administrateur en nomme d'autres."""
    from app.notify import OUTBOX
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "1")
    boss = register("boss@padel.tn")
    assert boss.get("/auth/account").json()["pending"] is False  # administrateur du serveur: jamais en attente
    OUTBOX.clear()
    anon = TestClient(app)
    r = anon.post("/auth/register", json={"email": "neuf@b.tn", "password": "secret1", "name": "Coach Neuf", "phone": "22 333 444"}).json()
    new = login_as(TestClient(app), r["token"])
    acc = new.get("/auth/account").json()
    assert (acc["pending"], acc["email_verified"], acc["email_required"], acc["signup_status"]) == (True, False, True, "a_valider")
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "0")
    monkeypatch.setenv("SMTP_HOST", "smtp.exemple.tn")  # e-mails possibles: le coach vérifie son e-mail quand même
    assert new.get("/auth/account").json()["email_required"] is True
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "1")
    monkeypatch.delenv("SMTP_HOST")
    assert new.get("/booking/settings").status_code == 403
    assert any(to == "boss@padel.tn" and "Coach Neuf" in body for to, _, body in OUTBOX)  # l'administrateur est prévenu
    token = next(body for to, _, body in OUTBOX if to == "neuf@b.tn").split("/verify/")[1].split()[0]
    v = anon.post(f"/auth/verify/{token}").json()
    assert v["coach"] and v["waiting_admin"]  # e-mail vérifié, reste la confirmation
    assert boss.get("/booking/summary").json()["signups"] == 1
    [c] = boss.get("/admin/coach-signups").json()
    assert (c["phone"], c["email_verified"]) == ("+21622333444", True)
    OUTBOX.clear()
    boss.post(f"/admin/coach-signups/{c['id']}/validate", json={"base": "http://padel.tn:8090"})
    assert any(to == "neuf@b.tn" and "http://padel.tn:8090" in body and "Bien démarrer" in body for to, _, body in OUTBOX)  # lien du vrai site
    assert new.get("/auth/account").json()["pending"] is False and new.get("/booking/settings").status_code == 200
    # plusieurs administrateurs
    assert new.get("/admin/coaches").status_code == 403
    assert boss.put(f"/admin/coaches/{c['id']}/admin", json={"admin": True}).json()["admin"] is True
    assert new.get("/admin/coaches").status_code == 200 and new.get("/booking/summary").json()["admin"]
    boss_id = next(x["id"] for x in new.get("/admin/coaches").json() if x["email"] == "boss@padel.tn")
    assert new.put(f"/admin/coaches/{boss_id}/admin", json={"admin": False}).status_code == 409  # fixé par ADMIN_EMAILS
    assert boss.put(f"/admin/coaches/{c['id']}/admin", json={"admin": False}).json()["admin"] is False
    # un coach refusé ne peut rien faire
    r = anon.post("/auth/register", json={"email": "faux@b.tn", "password": "secret1", "name": "Faux"}).json()
    fake = next(x for x in boss.get("/admin/coach-signups").json() if x["email"] == "faux@b.tn")
    boss.post(f"/admin/coach-signups/{fake['id']}/refuse")
    assert login_as(TestClient(app), r["token"]).get("/auth/account").json()["signup_status"] == "refusee"


def test_time_off_hides_slots_and_free_court_happy_hour_and_low_session_message(client):
    """Absence du coach: aucun créneau ces jours-là. Terrain libre annoncé avec une remise = promotion.
    Séance incomplète: message aux inscrits avec remise, le prix baisse."""
    from app.notify import OUTBOX
    open_week(client)
    p, pc = player_client(client)
    day = (datetime.now(timezone.utc) + timedelta(days=3)).date()
    before = [x for x in pc.get("/me/slots").json() if x.startswith(day.isoformat())]
    assert before
    off = client.post("/time-off", json={"start_date": day.isoformat(), "reason": "Vacances"}).json()
    assert (off["end_date"], off["reason"]) == (day.isoformat(), "Vacances")
    assert not [x for x in pc.get("/me/slots").json() if x.startswith(day.isoformat())]
    assert client.post("/time-off", json={"start_date": day.isoformat(), "end_date": "2000-01-01"}).status_code == 422
    assert client.delete(f"/time-off/{off['id']}").json()["ok"] and client.get("/time-off").json() == []
    # terrain libre annoncé en happy hour
    start = (datetime.now(timezone.utc) + timedelta(days=4)).replace(minute=0, second=0, microsecond=0)
    cb = free_court(client, start.isoformat(), minutes=120)
    msg = client.get(f"/court-bookings/{cb['id']}/announce?discount_millimes=20000").json()["message"]
    assert "heures creuses : -20 TND" in msg
    OUTBOX.clear()
    assert client.post(f"/court-bookings/{cb['id']}/announce", json={"player_ids": [p["id"]], "discount_millimes": 20000}).json()["sent"] == 1
    [promo] = [x for x in client.get("/promotions").json()["items"] if x["active"]]
    assert (promo["court_booking_id"], promo["discount_millimes"]) == (cb["id"], 20000)
    # séance en groupe à deux: le coach demande s'ils sont partants à deux, avec -10 %
    q = mkplayer(client, name="Rim", phone="20 111 222")
    s = client.post("/sessions", json={"start": (start + timedelta(days=1)).isoformat(), "kind": "groupe", "player_ids": [p["id"], q["id"]], "discount_millimes": 0}).json()[0]
    pre = client.get(f"/sessions/{s['id']}/message?discount_millimes=3000").json()
    assert {x["name"] for x in pre["players"]} == {"Sami", "Rim"} and "à deux" in pre["message"] and "-3 TND" in pre["message"]
    OUTBOX.clear()
    assert client.post(f"/sessions/{s['id']}/message", json={"player_ids": [p["id"], q["id"]], "discount_millimes": 3000}).json()["sent"] == 2
    assert next(x for x in client.get("/sessions").json() if x["id"] == s["id"])["price_millimes"] == 27000  # 30 TND - 3 TND


def test_one_court_at_a_time_and_sessions_go_on_the_free_court(client):
    """Un coach n'a qu'un terrain à la fois: pas de second terrain à la même heure; une séance (du coach ou
    d'un joueur) a lieu sur son terrain libre qui couvre l'horaire, quel que soit le club choisi."""
    open_week(client, auto_confirm=False)
    marsa = mkclub(client)
    other = client.post("/clubs", json={"name": "Gammarth Padel", "phone": "71 000 111"}).json()
    start = (datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=8, minute=0, second=0, microsecond=0)
    free_court(client, start.isoformat(), minutes=240, club=marsa)
    # second terrain qui chevauche (même dans un autre club): refusé
    r = client.post("/court-bookings/manual", json={"club_id": other["id"], "start": (start + timedelta(hours=2)).isoformat(), "duration_min": 120})
    assert r.status_code == 409 and "qu'un terrain à la fois" in r.json()["detail"]
    # juste après le premier: accepté
    assert client.post("/court-bookings/manual", json={"club_id": other["id"], "start": (start + timedelta(hours=4)).isoformat(), "duration_min": 60}).status_code == 201
    # séance du coach demandée à Gammarth pendant le terrain libre de La Marsa: elle a lieu à La Marsa, sur ce terrain
    s = client.post("/sessions", json={"start": (start + timedelta(hours=1)).isoformat(), "club_id": other["id"], "player_ids": []}).json()[0]
    assert s["club"] == "Padel Club La Marsa" and s["court_status"] == "confirmee"
    # séance qui dépasse le terrain (pas couverte) dans un autre club: refusée, pas de second terrain
    r = client.post("/sessions", json={"start": (start + timedelta(hours=3, minutes=30)).isoformat(), "club_id": other["id"]})
    assert r.status_code == 409
    # demande d'un joueur acceptée « avec demande au club »: elle va quand même sur le terrain libre
    p, pc = player_client(client)
    when = start + timedelta(hours=2)
    b = pc.post("/me/book", json={"kind": "individuel", "start": when.isoformat()})
    assert b.status_code == 201, b.text
    r = client.post(f"/booking/requests/{b.json()['id']}/accept", json={"club_id": other["id"]}).json()
    assert r["status"] == "confirmee"


# --- Comptes test isolés (DP-004) -----------------------------------------

TEST_EMAILS = " Coach.Test@padel.tn , joueur.test@x.tn,ancien.test@x.tn"


def invited(c, email, **extra):
    """Joueur ajouté par le coach c, qui crée son compte avec cet e-mail."""
    p = mkplayer(c, **extra)
    token = c.post(f"/players/{p['id']}/invite").json()["token"]
    r = TestClient(app).post(f"/auth/invite/{token}", json={"email": email, "password": "secret1"}).json()
    return p, login_as(TestClient(app), r["token"])


@pytest.fixture
def two_worlds(client, monkeypatch):
    """Un vrai coach (client) et un coach test, chacun avec son club; les comptes test sont listés côté serveur."""
    monkeypatch.setenv("TEST_ACCOUNT_EMAILS", TEST_EMAILS)
    open_week(client, auto_confirm=False)
    mkclub(client)
    tc = register("coach.test@padel.tn")
    open_week(tc, auto_confirm=False)
    tc.post("/clubs", json={"name": "Club Agents", "phone": "71 000 001"})
    return client, tc


def _coaches(pc):
    return {c["id"]: c["name"] for c in pc.get("/me/coaches").json()}


def _in(days, hour_utc=9):
    return (datetime.now(timezone.utc) + timedelta(days=days)).replace(hour=hour_utc, minute=0, second=0, microsecond=0).isoformat()


def test_real_player_never_sees_test_coach(two_worlds):
    real, tc = two_worlds
    _, pc = player_client(real)
    _, tpc = invited(tc, "joueur.test@x.tn")
    [real_id] = _coaches(pc)  # seul le vrai coach est listé
    [test_id] = _coaches(tpc)
    assert test_id != real_id
    assert pc.get(f"/me/coaches/{test_id}").status_code == 404
    clubs = pc.get("/me/clubs").json()
    assert "Club Agents" not in clubs and "Padel Club La Marsa" in clubs
    day = _day_of(pc.get("/me/slots").json()[0])
    off = pc.get(f"/me/offers?day={day}&kinds=individuel,duo,groupe").json()
    assert off["slots_other"] and all(x["coach"]["id"] == real_id for x in off["slots_other"] + off["slots_with_court"] + off["groups"])
    assert pc.get(f"/me/offers?day={day}&kinds=individuel&coach_id={test_id}").json()["slots_other"] == []
    assert pc.post("/me/book", json={"kind": "individuel", "start": _in(3), "coach_id": test_id}).status_code == 404
    # une séance ouverte du coach test n'est jamais proposée, ni rejointe
    s = tc.post("/sessions", json={"start": _in(4), "kind": "groupe", "open": True}).json()[0]
    assert all(g["session_id"] != s["id"] for g in pc.get(f"/me/offers?day={_day_of(_in(4))}&kinds=groupe").json()["groups"])
    assert pc.post("/me/book", json={"session_id": s["id"], "kinds": ["groupe"]}).status_code == 404
    assert tc.get("/booking/requests").json() == []


def test_test_player_sees_only_test_coach_and_never_reaches_real_coach(two_worlds):
    real, tc = two_worlds
    sami, pc = player_client(real)
    [real_id] = _coaches(pc)
    _, tpc = invited(tc, "Joueur.Test@x.tn")  # majuscules sans importance
    assert list(_coaches(tpc).values()) == ["Coach Test"]
    assert tpc.get("/me/clubs").json() == ["Club Agents"]
    assert tpc.get(f"/me/coaches/{real_id}").status_code == 404
    day = _day_of(tpc.get("/me/slots").json()[0])
    off = tpc.get(f"/me/offers?day={day}&kinds=individuel").json()
    assert off["slots_other"] and all(x["coach"]["id"] != real_id for x in off["slots_other"] + off["slots_with_court"])
    assert tpc.post("/me/book", json={"kind": "individuel", "start": _in(3), "coach_id": real_id}).status_code == 404
    # ni par le lien « remplacez-moi » d'un vrai joueur
    near = next(x for x in pc.get("/me/slots").json() if datetime.fromisoformat(x) < datetime.now(timezone.utc) + timedelta(hours=23))
    b = pc.post("/me/book", json={"kind": "individuel", "start": near}).json()
    real.post(f"/booking/requests/{b['id']}/accept", json={})
    token = pc.post(f"/me/bookings/{b['id']}/replacement").json()["path"].split("/")[-1]
    assert tpc.post(f"/replace/{token}/take").status_code == 404
    signup = {"name": "Agent Deux", "phone": "98 123 001", "email": "ancien.test@x.tn", "password": "secret1"}
    assert TestClient(app).post(f"/replace/{token}/signup", json=signup).status_code == 404
    # le vrai coach n'a aucune demande ni fiche du joueur test
    assert real.get("/booking/requests").json() == []  # (celle de Sami est déjà acceptée)
    assert [p["name"] for p in real.get("/players").json()] == ["Sami"]


def test_test_player_full_booking_cycle_with_test_coach(two_worlds):
    real, tc = two_worlds
    p, tpc = invited(tc, "joueur.test@x.tn")
    tc.post(f"/players/{p['id']}/credits", json={"amount_millimes": 100000})
    far = next(s for s in tpc.get("/me/slots").json() if datetime.fromisoformat(s) > datetime.now(timezone.utc) + timedelta(hours=30))
    r = tpc.post("/me/book", json={"kind": "individuel", "start": far}).json()
    assert r["status"] == "en_attente" and r["credits_millimes"] == 100000  # rien n'est débité à la demande
    [req] = tc.get("/booking/requests").json()
    assert tc.post(f"/booking/requests/{req['id']}/accept", json={}).status_code == 200
    assert tpc.get("/me").json()["wallets"][0]["credits_millimes"] == 40000  # 60 TND débités à la validation
    assert tpc.post(f"/me/bookings/{r['id']}/cancel").json()["refunded"] is True
    assert tpc.get("/me").json()["wallets"][0]["credits_millimes"] == 100000
    assert real.get("/booking/requests").json() == []


def test_messages_stay_in_their_world(two_worlds):
    """Promotions, annonces et invitations: un coach test n'écrit qu'aux joueurs test, un vrai coach jamais à eux."""
    real, tc = two_worlds
    _, tpc = invited(tc, "joueur.test@x.tn")
    player_client(tc, name="Vrai Chez Test", phone="20555666")  # vrai joueur inscrit chez le coach test
    player_client(real)
    _, old = invited(real, "ancien.test@x.tn", name="Ancien", phone="20999000")  # compte test resté chez le vrai coach
    start = _in(4, 8)
    cb = free_court(tc, start, club=tc.get("/clubs").json()[0])
    assert [x["name"] for x in tc.get(f"/court-bookings/{cb['id']}/announce").json()["players"]] == ["Sami"]
    assert tc.get(f"/promotions/preview?court_booking_id={cb['id']}").json()["recipients"] == 1
    assert tc.post("/promotions", json={"court_booking_id": cb["id"], "discount_millimes": 20000}).json()["notified_count"] == 1
    assert len(tpc.get("/me/promotions").json()) == 1
    s = tc.post("/sessions", json={"start": _in(5), "kind": "groupe", "open": True}).json()[0]
    assert [x["name"] for x in tc.get(f"/sessions/{s['id']}/invitable").json()["players"]] == ["Sami"]
    # le vrai coach n'écrit jamais au compte test, qui ne voit ni ses promotions ni ses propositions
    rcb = free_court(real, start, club=real.get("/clubs").json()[0])
    assert [x["name"] for x in real.get(f"/court-bookings/{rcb['id']}/announce").json()["players"]] == ["Sami"]
    real.post("/promotions", json={"court_booking_id": rcb["id"], "discount_millimes": 20000})
    assert old.get("/me/promotions").json() == [] and old.get("/me/coaches").json()[0]["name"] == "Coach Test"
    rs = real.post("/sessions", json={"start": _in(5, 15), "kind": "groupe", "open": True}).json()[0]
    ancien = next(p["id"] for p in real.get("/players").json() if p["name"] == "Ancien")
    assert real.post(f"/sessions/{rs['id']}/invite", json={"player_ids": [ancien]}).json()["sent"] == 0
    assert old.get("/me/proposals").json() == []


def test_admin_sees_test_flag(two_worlds, monkeypatch):
    """Les comptes test restent visibles de l'administrateur, marqués is_test (à exclure des statistiques)."""
    real, tc = two_worlds
    monkeypatch.setenv("ADMIN_EMAILS", "a@b.tn")
    invited(tc, "joueur.test@x.tn")
    player_client(real)
    assert {c["email"]: c["is_test"] for c in real.get("/admin/coaches").json()} == {"a@b.tn": False, "coach.test@padel.tn": True}
    assert sorted((p["coach_name"], p["is_test"]) for p in real.get("/admin/players").json()) == [("Coach Test", False), ("Coach Test", True)]


def test_coach_cannot_have_two_sessions_at_once_and_reminders_list_all_sessions(client):
    """Ticket n°11: deux séances qui se chevauchent sont refusées. Ticket n°14: un seul rappel par joueur pour
    toutes ses séances de demain (clé unique)."""
    from app.services.common import TUNIS
    p = mkplayer(client, name="Sami Ben Ali")
    day = (datetime.now(TUNIS) + timedelta(days=1)).date()
    at = lambda h: datetime.combine(day, datetime.min.time().replace(hour=h), TUNIS).isoformat()  # noqa: E731
    assert client.post("/sessions", json={"start": at(12), "player_ids": [p["id"]]}).status_code == 201
    r = client.post("/sessions", json={"start": at(12), "player_ids": [p["id"]]})
    assert r.status_code == 409 and "déjà une séance" in r.json()["detail"] and "Sami Ben Ali" in r.json()["detail"]
    assert client.post("/sessions", json={"start": at(12) .replace("T12", "T12"), "duration_min": 90, "kind": "groupe"}).status_code == 409
    assert client.post("/sessions", json={"start": at(13), "player_ids": [p["id"]]}).status_code == 201  # juste après: accepté
    assert client.post("/sessions", json={"start": at(21), "player_ids": [p["id"]]}).status_code == 201
    rem = [x for x in client.get("/reminders").json() if x["kind"] == "seance"]
    assert len(rem) == 1 and rem[0]["sessions"] == 3 and "3 séances" in rem[0]["message"] and "21h00" in rem[0]["message"]
    keys = [x["key"] for x in client.get("/reminders").json()]
    assert len(keys) == len(set(keys))


def test_payment_after_recharge_debt_keeps_finances_consistent(client):
    """Ticket n°12: une recharge de 60 paie une séance de 70 en crédits (solde -10); les paiements suivants
    règlent d'abord les séances, puis comblent ce solde: après avoir tout versé, le joueur est à jour."""
    p = mkplayer(client, name="Wassim")
    starts = [(datetime.now(timezone.utc) - timedelta(days=d)).isoformat() for d in (3, 2)]
    for st, price in zip(starts, (70000, 40000)):
        s = client.post("/sessions", json={"start": st, "kind": "individuel", "price_millimes": price, "player_ids": [p["id"]]}).json()[0]
        client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    fin = lambda: client.get(f"/players/{p['id']}/profile").json()["finance"]  # noqa: E731
    assert fin()["due_millimes"] == 110000
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 60000, "method": "especes"})
    f = fin()
    assert f["due_millimes"] == 50000  # 40 de séance + 10 de crédits manquants
    client.post("/payments", json={"player_id": p["id"], "amount_millimes": 20000, "method": "especes"})
    client.post("/payments", json={"player_id": p["id"], "amount_millimes": 30000, "method": "virement"})
    f = fin()
    assert f["due_millimes"] == 0 and f["paid_millimes"] <= f["billed_millimes"] and f["credits_balance_millimes"] == 0
    assert all(u["player_id"] != p["id"] for u in client.get("/dashboard").json()["unpaid"])


def test_spider_criteria_editable_and_precise_ratings(client):
    """Araignée: jauge de 0 à 10 au dixième (value 0-100), critères standards modifiables par le coach."""
    p = mkplayer(client)
    c = client.get("/criteria").json()
    assert c["names"] == c["standard"] and not c["custom"]
    assert client.post(f"/players/{p['id']}/skills", json={"stroke": "Bandeja", "value": 73}).status_code == 201
    assert client.post(f"/players/{p['id']}/skills", json={"stroke": "Bandeja", "value": 101}).status_code == 422
    names = ["Service", "Bandeja", "Mental", "Déplacements"]
    c = client.put("/criteria", json={"names": names + ["  mental "]}).json()  # doublon ignoré
    assert c["names"] == names and c["custom"]
    assert client.put("/criteria", json={"names": ["A", "B"]}).status_code == 422  # au moins 3
    assert client.post(f"/players/{p['id']}/skills", json={"stroke": "Mental", "value": 85}).status_code == 201
    prof = client.get(f"/players/{p['id']}/profile").json()
    assert [s["stroke"] for s in prof["skills"]] == names
    sk = {s["stroke"]: s["score"] for s in prof["skills"]}
    assert (sk["Bandeja"], sk["Mental"], sk["Service"]) == (7.3, 8.5, None) and prof["strengths"] == ["Mental"]
    assert client.put("/criteria", json={"names": []}).json()["custom"] is False  # retour aux critères standards


def test_finance_tab_notes_and_coach_absence_for_players(client):
    """Onglet Finance: gagné (séances effectuées), encaissé (argent reçu), impayés, crédits d'avance, journal.
    Notes générales du coach sur un joueur. Absence du coach visible à l'accueil de ses joueurs."""
    from app.services.common import TUNIS
    p, pc = player_client(client, name="Sami")
    q = mkplayer(client, name="Rim", phone="20 111 222")
    today = datetime.now(TUNIS).date()
    at = lambda d, h: datetime.combine(today - timedelta(days=d), datetime.min.time().replace(hour=h), TUNIS).isoformat()  # noqa: E731
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 100000, "method": "especes"})  # versement de Sami
    for d, pid in ((2, p["id"]), (1, q["id"])):
        client.post("/sessions", json={"start": at(d, 9), "kind": "individuel", "player_ids": [pid], "price_millimes": 60000})
    f = client.get(f"/finance?start={today - timedelta(days=6)}&end={today}").json()
    assert (f["earned_millimes"], f["cashed_millimes"], f["sessions"]) == (120000, 100000, 2)
    assert [u["name"] for u in f["unpaid"]] == ["Rim"] and f["unpaid_total_millimes"] == 60000
    assert [c["name"] for c in f["credits"]] == ["Sami"] and f["credits_total_millimes"] == 40000
    assert f["journal"][0]["name"] == "Sami" and len(f["series"]) == 7 and f["group"] == "day"
    fin = client.get(f"/players/{p['id']}/profile").json()["finance"]
    assert (fin["given_millimes"], fin["consumed_millimes"], fin["balance_millimes"]) == (100000, 60000, 40000)
    assert client.put(f"/players/{p['id']}/notes", json={"notes": "Travailler le mental"}).json()["notes"] == "Travailler le mental"
    assert client.get(f"/players/{p['id']}/profile").json()["player"]["notes"] == "Travailler le mental"
    client.post("/time-off", json={"start_date": (today + timedelta(days=7)).isoformat(), "end_date": (today + timedelta(days=37)).isoformat(), "reason": "Vacances"})
    [a] = pc.get("/me").json()["absences"]
    assert a["coach_name"] == "Coach Test" and a["reason"] == "Vacances" and a["now"] is False


def test_admin_corrects_credits_coach_cannot(client, monkeypatch):
    """Administrateur: retirer ou ajouter des crédits sans argent reçu; un coach ordinaire ne peut pas."""
    p = mkplayer(client)
    assert client.post(f"/players/{p['id']}/credits/correction", json={"amount_millimes": -10000}).status_code == 403
    monkeypatch.setenv("ADMIN_EMAILS", "boss@padel.tn")
    boss = register("boss@padel.tn")
    coach_id = next(c["id"] for c in boss.get("/admin/coaches").json() if c["email"] == "a@b.tn")
    acting = login_as(TestClient(app), boss.post(f"/admin/coaches/{coach_id}/act").json()["token"])
    acting.post(f"/players/{p['id']}/credits", json={"amount_millimes": 50000, "method": "especes"})
    assert acting.post(f"/players/{p['id']}/credits/correction", json={"amount_millimes": -20000}).json()["balance_millimes"] == 30000
    assert acting.post(f"/players/{p['id']}/credits/correction", json={"amount_millimes": 0}).status_code == 422


def test_player_specific_spider_criteria(client):
    """Critères de l'araignée propres à un joueur (sinon ceux du coach)."""
    p, q = mkplayer(client, name="Ali"), mkplayer(client, name="Bea", phone="22 000 111")
    assert client.get(f"/players/{p['id']}/criteria").json()["custom"] is False
    names = ["Service", "Mental", "Cardio"]
    r = client.put(f"/players/{p['id']}/criteria", json={"names": names}).json()
    assert r["names"] == names and r["custom"]
    assert client.post(f"/players/{p['id']}/skills", json={"stroke": "Cardio", "value": 65}).status_code == 201
    assert [s["stroke"] for s in client.get(f"/players/{p['id']}/profile").json()["skills"]] == names
    assert len(client.get(f"/players/{q['id']}/profile").json()["skills"]) == 9  # les autres gardent ceux du coach
    assert client.put(f"/players/{p['id']}/criteria", json={"names": []}).json()["custom"] is False


def test_player_planning_matches_coach_feedback_and_progress(client):
    """Le joueur ajoute ses matchs et tournois, note son résultat et son jeu, dit qui l'a coaché;
    ce coach y ajoute son retour. Ma progression: une araignée par coach, ses notes, les heures de jeu."""
    p, pc = player_client(client)
    coach_id = next(c["id"] for c in pc.get("/me/coaches").json())
    past = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    e = pc.post("/me/events", json={"kind": "tournoi", "title": "Open de la Marsa", "start": past, "duration_min": 120,
                                    "result": "victoire", "score": "6-4 6-3", "rating": 7.5, "comment": "Bon filet", "coach_id": coach_id}).json()
    assert e["rating"] == 7.5 and e["coach_name"]
    assert pc.post("/me/events", json={"kind": "match", "start": past, "coach_id": 99999}).status_code == 422  # pas son coach
    m = client.get(f"/players/{p['id']}/matches").json()
    assert [x["id"] for x in m] == [e["id"]]
    client.put(f"/matches/{e['id']}/feedback", json={"feedback": "Très bon placement"})
    assert pc.get("/me/events").json()[0]["coach_feedback"] == "Très bon placement"
    client.post(f"/players/{p['id']}/skills", json={"stroke": "Volée", "value": 80})
    client.put(f"/players/{p['id']}/notes", json={"notes": "Travaille ton revers"})
    pr = pc.get("/me/progress").json()
    assert pr["by_coach"][0]["notes"] == "Travaille ton revers"
    assert next(s for s in pr["by_coach"][0]["skills"] if s["stroke"] == "Volée")["score"] == 8
    assert pr["play"]["tournoi"]["total"] == 2 and pr["play"]["tournoi"]["count"] == 1
    assert pc.delete(f"/me/events/{e['id']}").status_code == 200 and pc.get("/me/events").json() == []
    # « autre » (kiné, physique…): une description, pas de coach, pas compté dans le temps de jeu
    assert pc.post("/me/events", json={"kind": "autre", "start": past}).status_code == 422
    o = pc.post("/me/events", json={"kind": "autre", "title": "Kiné", "start": past, "duration_min": 60, "coach_id": coach_id}).json()
    assert o["title"] == "Kiné" and o["coach_id"] is None
    m = pc.post("/me/events", json={"kind": "match", "start": past, "court_reserved": True}).json()
    assert m["court_reserved"] is True and pc.get("/me/progress").json()["play"]["match"]["count"] == 1


def test_favorite_coaches_and_clubs_and_several_clubs_filter(client):
    """Coachs et clubs favoris du joueur (choisis d'office dans Réserver); recherche sur plusieurs clubs."""
    open_week(client)
    mkclub(client)
    p, pc = player_client(client)
    coach_id = pc.get("/me/coaches").json()[0]["id"]
    assert pc.get("/me").json()["favorites"]["coach_ids"] == [coach_id]  # lien de son coach: favori d'office
    pc.put("/me/favorites", json={"coach_ids": [coach_id], "clubs": ["Padel Club La Marsa"]})
    assert pc.get("/me").json()["favorites"] == {"coach_ids": [coach_id], "clubs": ["Padel Club La Marsa"]}
    day = _day_of(pc.get("/me/slots").json()[-1])
    both = pc.get(f"/me/offers?day={day}&kinds=individuel&clubs=Padel Club La Marsa|Autre Club").json()
    none = pc.get(f"/me/offers?day={day}&kinds=individuel&clubs=Autre Club").json()
    assert both["slots_other"] and not none["slots_other"]


def test_open_duration_shortened_by_the_strictest_and_same_slot_requests(client):
    """Le joueur accepte 1 h ou 1 h 30 sans choisir: la séance prend 1 h 30, puis 1 h quand un joueur qui ne veut
    que 1 h la rejoint (prix recalculés). Plusieurs demandes du même créneau: le coach les voit ensemble; accepter
    une demande compatible la fait rejoindre la séance, une demande incompatible est refusée avec une explication."""
    open_week(client, auto_confirm=False)  # 40 TND l'heure à deux, 30 en groupe
    a, pa = player_client(client, name="Ali", phone="20111111")
    b, pb = player_client(client, name="Bea", phone="20222222")
    for p in (a, b):
        client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 200000})
    start = _future_slot(pa, 50, hour_utc=9)  # 10 h à Tunis: 1 h 30 possible
    r = pa.post("/me/book", json={"kind": "duo", "start": start, "kinds": ["duo"], "durations": {"duo": [60, 90]}}).json()
    req = next(x for x in client.get("/booking/requests").json() if x["id"] == r["id"])
    assert req["duration_min"] == 90 and req["wish"] == [{"kind": "duo", "minutes": [60, 90]}]
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    sid = next(x["id"] for x in client.get("/sessions").json() if x["player_ids"] == [a["id"]])
    rb = pb.post("/me/book", json={"session_id": sid, "kinds": ["duo"], "durations": {"duo": [60]}}).json()
    assert rb["price_millimes"] == 40000  # 1 h à deux
    client.post(f"/booking/requests/{rb['id']}/accept", json={})
    s = next(x for x in client.get("/sessions").json() if x["id"] == sid)
    assert s["duration_min"] == 60 and pa.get("/me").json()["credits_millimes"] == 160000  # Ali repaie 1 h, pas 1 h 30

    # trois demandes du même créneau: deux en groupe 1 h 30, une seule 1 h
    later = (datetime.fromisoformat(start) + timedelta(days=2)).isoformat()
    x, px = player_client(client, name="Xavier", phone="20333333")
    y, py = player_client(client, name="Yasmine", phone="20444444")
    z, pz = player_client(client, name="Zied", phone="20555555")
    rx = px.post("/me/book", json={"kind": "groupe", "start": later, "kinds": ["groupe"], "durations": {"groupe": [90]}}).json()
    ry = py.post("/me/book", json={"kind": "groupe", "start": later, "kinds": ["groupe"], "durations": {"groupe": [90]}}).json()
    rz = pz.post("/me/book", json={"kind": "individuel", "start": later, "kinds": ["individuel"]}).json()
    reqs = {q["id"]: q for q in client.get("/booking/requests").json()}
    assert set(reqs[rx["id"]]["same_slot"]) == {ry["id"], rz["id"]} and reqs[rx["id"]]["fits_with"] == [ry["id"]]
    assert reqs[rz["id"]]["fits_with"] == []
    client.post(f"/booking/requests/{rx['id']}/accept", json={})
    reqs = {q["id"]: q for q in client.get("/booking/requests").json()}
    assert reqs[ry["id"]]["session_here"]["join"] is True and reqs[rz["id"]]["session_here"]["join"] is False
    assert client.post(f"/booking/requests/{ry['id']}/accept", json={}).status_code == 200  # Yasmine rejoint le groupe de Xavier
    assert client.post(f"/booking/requests/{rz['id']}/accept", json={}).status_code == 409
    grp_session = next(x2 for x2 in client.get("/sessions").json() if set(x2["player_ids"]) == {x["id"], y["id"]})
    assert grp_session["duration_min"] == 90


def test_coach_signup_link_profile_and_goals(client):
    """Lien d'inscription du coach (le même pour tous ses joueurs): le joueur devient son élève, coach favori,
    après confirmation de l'administrateur; main forte, côté et objectifs demandés à l'inscription."""
    from fastapi.testclient import TestClient
    link = client.get("/auth/coach-link").json()["path"]
    assert link == client.get("/auth/coach-link").json()["path"] and link.startswith("/inscription/")
    token = link.rsplit("/", 1)[1]
    assert TestClient(app).get(f"/auth/join/{token}").json()["coach_name"] == "Coach Test"
    body = {"name": "Nadia Club", "phone": "29 111 222", "email": "nadia@x.tn", "password": "secret1", "gender": "F", "category": "P100-",
            "dominant_hand": "gaucher", "side": "deux", "goals": "Progresser techniquement · Gagner un tableau P250", "coach_token": token}
    pc = login_as(TestClient(app), TestClient(app).post("/auth/signup", json=body).json()["token"])
    assert pc.get("/auth/account").json()["signup_status"] == "a_valider"  # confirmation de l'administrateur, comme le lien public
    mine = next(x for x in client.get("/players").json() if x["name"] == "Nadia Club")
    assert (mine["dominant_hand"], mine["side"], mine["goals"]) == ("gaucher", "deux", "Progresser techniquement · Gagner un tableau P250")
    assert TestClient(app).post("/auth/signup", json={**body, "email": "x1@x.tn", "coach_token": "faux"}).status_code == 404
    assert TestClient(app).post("/auth/signup", json={**body, "email": "x2@x.tn", "phone": "29 333 444", "side": "milieu"}).status_code == 422
    # lien personnel d'un élève: son coach devient son coach favori
    p, pc2 = player_client(client)
    coach_id = next(c["id"] for c in pc2.get("/me/coaches").json() if c["mine"])
    assert pc2.get("/me").json()["favorites"]["coach_ids"] == [coach_id]


def test_coach_proposes_another_time_and_player_notifications(client):
    """Comme une invitation de réunion: le coach propose un autre horaire, le joueur est notifié dans l'appli et
    accepte (séance acceptée d'office) ou refuse. Les messages des coachs arrivent aussi dans l'appli."""
    open_week(client, auto_confirm=False)
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 100000})
    slots = [s for s in pc.get("/me/slots").json() if s[14:16] == "00"]
    r = pc.post("/me/book", json={"kind": "individuel", "start": slots[0]}).json()
    later = datetime.fromisoformat(slots[-1]) + timedelta(days=1)
    out = client.post(f"/booking/requests/{r['id']}/propose", json={"start": later.isoformat(), "duration_min": 60})
    assert out.status_code == 200 and out.json()["status"] == "contre_proposition"
    n = pc.get("/me/notifications").json()
    assert n["unread"] == 2 and n["items"][1]["kind"] == "message"  # la recharge de crédits est aussi notifiée
    assert n["items"][0]["kind"] == "contre_proposition" and n["items"][0]["proposal"]["open"] is True
    up = pc.get("/me/sessions").json()["upcoming"]
    assert up[0]["status"] == "contre_proposition" and up[0]["proposed_start"]
    assert pc.post(f"/me/bookings/{r['id']}/proposal", json={"accept": True}).json()["status"] in ("acceptee", "confirmee")
    s = next(x for x in client.get("/sessions").json() if x["player_ids"] == [p["id"]] and x["start"][:13] == later.isoformat()[:13])
    assert s["duration_min"] == 60 and pc.get("/me").json()["credits_millimes"] == 40000  # débité à l'acceptation
    assert pc.post(f"/me/bookings/{r['id']}/proposal", json={"accept": True}).status_code == 409  # déjà répondu
    pc.post("/me/notifications/read")
    assert pc.get("/me/notifications").json()["unread"] == 0
    # refus: la demande est abandonnée
    r2 = pc.post("/me/book", json={"kind": "individuel", "start": slots[1]}).json()
    client.post(f"/booking/requests/{r2['id']}/propose", json={"start": (later + timedelta(hours=3)).isoformat()})
    pc.post(f"/me/bookings/{r2['id']}/proposal", json={"accept": False})
    assert all(x["id"] != r2["id"] for x in client.get("/booking/requests").json())
    # un horaire où le coach a déjà une séance est refusé
    r3 = pc.post("/me/book", json={"kind": "individuel", "start": slots[2]}).json()
    assert client.post(f"/booking/requests/{r3['id']}/propose", json={"start": later.isoformat()}).status_code == 409


def test_solo_accepted_keeps_session_open_and_plays_one_hour(client):
    """Le joueur coche seul, à deux et en groupe sur un terrain d'1 h 30: la séance est validée tout de suite (il accepte
    de jouer seul), reste ouverte aux autres joueurs, et il paie 1 h seul; à moins de 24 h, s'il est toujours seul, la
    séance passe à 1 h et la fin du terrain redevient libre."""
    st = client.get("/booking/settings").json()
    client.put("/booking/settings", json={**st, "auto_confirm": False, "price_individuel": 60000, "price_duo": 40000,
                                          "price_groupe": 30000, "booking_mode": "terrains"})
    p, pc = player_client(client)
    client.post(f"/players/{p['id']}/credits", json={"amount_millimes": 200000})
    day = (datetime.now(timezone.utc) + timedelta(days=3)).date()
    start = datetime(day.year, day.month, day.day, 9, 0, tzinfo=timezone.utc).isoformat()
    club = mkclub(client)
    free_court(client, start, 90, club=club)
    all3 = {"kinds": ["individuel", "duo", "groupe"], "durations": {"duo": [60], "groupe": [90]}}
    off = pc.get(f"/me/offers?day={day}&kinds=individuel,duo,groupe&duo_min=60&groupe_min=90").json()
    slot = next(x for x in off["slots_with_court"] if x["start"].startswith(start[:16]))
    assert {(o["kind"], o["duration_min"]) for o in slot["options"]} == {("individuel", 60), ("duo", 60), ("groupe", 90)}
    r = pc.post("/me/book", json={"kind": "individuel", "start": start, **all3}).json()
    assert client.post(f"/booking/requests/{r['id']}/accept", json={}).status_code == 200
    s = next(x for x in client.get("/sessions").json() if x["player_ids"] == [p["id"]])
    assert s["kind"] == "individuel" and s["duration_min"] == 90 and s["open"]  # terrain gardé 1 h 30 pour un groupe
    mine = pc.get("/me/sessions").json()["upcoming"][0]
    assert mine["status"] == "confirmee" and mine["min_needed"] == 1
    assert pc.get("/me").json()["credits_millimes"] == 140000  # 1 h seul, pas 1 h 30
    assert next(cb for cb in client.get("/court-bookings").json() if cb["session_id"] == s["id"])["state"] == "completable"  # confirmée, encore des places

    # à moins de 24 h et toujours seul: 1 h, la dernière demi-heure du terrain redevient libre
    soon = (datetime.now(timezone.utc) + timedelta(hours=5)).replace(minute=0, second=0, microsecond=0)
    free_court(client, soon.isoformat(), 90, club=club)
    r2 = pc.post("/me/book", json={"kind": "individuel", "start": soon.isoformat(), **all3}).json()
    client.post(f"/booking/requests/{r2['id']}/accept", json={})
    s2 = next(x for x in client.get("/sessions").json() if x["id"] != s["id"])
    assert s2["duration_min"] == 60 and s2["kind"] == "individuel"
    free = [cb for cb in client.get("/court-bookings").json() if cb["free"]]
    assert any(cb["start"].startswith((soon + timedelta(hours=1)).isoformat()[:16]) and cb["duration_min"] == 30 for cb in free)


def test_confirmed_session_still_completable_until_full(client):
    """Séance confirmée (minimum atteint) où les joueurs acceptent d'être plus nombreux: état « completable » dans
    le calendrier, le coach invite un joueur jusqu'au dernier moment; quand plus personne ne peut la rejoindre: « complet »."""
    st = client.get("/booking/settings").json()
    client.put("/booking/settings", json={**st, "auto_confirm": False, "price_individuel": 60000, "price_duo": 40000,
                                          "price_groupe": 30000, "booking_mode": "terrains"})
    a, pa = player_client(client, name="Ali", phone="20111111")
    b, pb = player_client(client, name="Bea", phone="20222222")
    c, pcl = player_client(client, name="Cyr", phone="20333333")
    day = (datetime.now(timezone.utc) + timedelta(days=3)).date()
    start = datetime(day.year, day.month, day.day, 9, 0, tzinfo=timezone.utc).isoformat()
    free_court(client, start, 90)
    state = lambda: next(cb for cb in client.get("/court-bookings").json() if cb["session_id"])
    r = pa.post("/me/book", json={"kind": "individuel", "start": start, "kinds": ["individuel", "duo", "groupe"],
                                  "durations": {"duo": [60, 90], "groupe": [90]}}).json()
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    cb = state()
    assert cb["state"] == "completable" and cb["players_count"] == 1 and cb["max_players"] == 4
    sid = cb["session_id"]
    s = next(x for x in client.get("/sessions").json() if x["id"] == sid)
    assert s["max_players"] == 4 and s["min_players"] == 1
    # le coach invite Bea, qui accepte: à deux, toujours complétable (Ali accepte le groupe)
    assert b["id"] in {p["id"] for p in client.get(f"/sessions/{sid}/invitable").json()["players"]}
    client.post(f"/sessions/{sid}/invite", json={"player_ids": [b["id"]]})
    prop = next(x for x in pb.get("/me/proposals").json())
    assert pb.post(f"/me/proposals/{prop['id']}/accept").status_code == 200
    cb = state()
    assert cb["players_count"] == 2 and cb["state"] == "completable"
    # Cyr ne veut qu'un duo: impossible de le rejoindre à trois; s'il ouvrait seul un duo avec Ali, la séance serait close
    s = next(x for x in client.get("/sessions").json() if x["id"] == sid)
    assert s["kind"] == "duo" and s["max_players"] == 4


def test_free_court_pieces_count_as_one_range(client):
    """Terrain 8 h-12 h découpé par une séance ensuite annulée (8-9, 9-10, 10-12): les morceaux qui se suivent forment
    une seule plage libre, 1 h 30 y est proposé et une séance à cheval sur deux morceaux est acceptée."""
    st = client.get("/booking/settings").json()
    client.put("/booking/settings", json={**st, "auto_confirm": False, "price_duo": 40000, "price_groupe": 30000, "booking_mode": "terrains"})
    p, pc = player_client(client)
    day = (datetime.now(timezone.utc) + timedelta(days=4)).date()
    at = lambda h, m=0: datetime(day.year, day.month, day.day, h, m, tzinfo=timezone.utc).isoformat()  # noqa: E731
    free_court(client, at(8), 240)
    r = pc.post("/me/book", json={"kind": "duo", "start": at(9), "kinds": ["duo"], "durations": {"duo": [60]}}).json()
    client.post(f"/booking/requests/{r['id']}/accept", json={})
    sid = next(s["id"] for s in client.get("/sessions").json() if s["player_ids"] == [p["id"]])
    assert client.patch(f"/sessions/{sid}", json={"status": "annulee"}).status_code == 200
    assert len([cb for cb in client.get("/court-bookings").json() if cb["free"]]) == 3  # trois morceaux libres
    off = pc.get(f"/me/offers?day={day}&kinds=duo,groupe&duo_min=90&groupe_min=90").json()
    starts = {x["start"][11:16] for x in off["slots_with_court"]}
    assert {"08:00", "09:00", "09:30", "10:30"} <= starts
    r2 = pc.post("/me/book", json={"kind": "groupe", "start": at(9, 30), "kinds": ["groupe"], "durations": {"groupe": [90]}}).json()
    assert client.post(f"/booking/requests/{r2['id']}/accept", json={}).status_code == 200
    cb = next(x for x in client.get("/court-bookings").json() if x["session_id"] and x["session_status"] == "prevue")
    assert cb["start"][11:16] == "09:30" and cb["duration_min"] == 90  # terrain réuni puis découpé à la bonne taille


def test_price_grid_per_duration_and_booking_horizon(client):
    """Le coach choisit les durées de chaque formule et leur prix (pas forcément au prorata), et jusqu'où ses joueurs
    peuvent réserver (1 semaine à 3 mois)."""
    st = client.get("/booking/settings").json()
    grid = {"individuel": {"60": 60000, "90": 70000}, "duo": {"90": 50000}, "groupe": {}}
    r = client.put("/booking/settings", json={**st, "auto_confirm": False, "booking_mode": "terrains", "price_grid": grid, "booking_horizon_days": 7})
    assert r.status_code == 200, r.text
    out = client.get("/booking/settings").json()
    assert out["price_grid"]["individuel"] == {"60": 60000, "90": 70000} and out["booking_horizon_days"] == 7
    assert client.put("/booking/settings", json={**out, "booking_horizon_days": 120}).status_code == 422  # jamais plus de 3 mois
    p, pc = player_client(client)
    soon = (datetime.now(timezone.utc) + timedelta(days=3)).date()
    far = (datetime.now(timezone.utc) + timedelta(days=10)).date()
    for d in (soon, far):
        free_court(client, datetime(d.year, d.month, d.day, 9, 0, tzinfo=timezone.utc).isoformat(), 180)
    off = pc.get(f"/me/offers?day={soon}&kinds=individuel,duo,groupe&individuel_min=60,90&duo_min=60,90&groupe_min=60,90").json()
    opts = {(o["kind"], o["duration_min"], o["price_millimes"]) for x in off["slots_with_court"] for o in x["options"]}
    assert ("individuel", 90, 70000) in opts and ("individuel", 60, 60000) in opts and ("duo", 90, 50000) in opts
    assert not any(k == "groupe" or (k == "duo" and m == 60) for k, m, _ in opts)  # ni groupe ni duo d'1 h chez ce coach
    # au-delà de la limite (7 jours): rien de proposé, réservation refusée avec une explication
    assert pc.get(f"/me/offers?day={far}&kinds=individuel").json()["slots_with_court"] == []
    r = pc.post("/me/book", json={"kind": "individuel", "start": datetime(far.year, far.month, far.day, 9, 0, tzinfo=timezone.utc).isoformat(), "kinds": ["individuel"]})
    assert r.status_code in (409, 422) and "1 semaine" in r.json()["detail"]
    assert next(c for c in pc.get("/me/coaches").json())["horizon_days"] == 7


def test_player_group_booking_invites_then_reaches_coach(client):
    """Réservation en groupe montée par un joueur: il choisit le créneau et « en groupe », invite des joueurs (liste ou
    lien); le coach ne voit la demande qu'une fois le minimum (3) atteint, et les accepte ensemble en une séance."""
    st = client.get("/booking/settings").json()
    client.put("/booking/settings", json={**st, "auto_confirm": False, "price_groupe": 30000, "booking_mode": "terrains"})
    a, pa = player_client(client, name="Ali", phone="20111111")
    b, pb = player_client(client, name="Bea", phone="20222222")
    c, pcl = player_client(client, name="Cyr", phone="20333333")
    d, pd = player_client(client, name="Dan", phone="20444444")
    day = (datetime.now(timezone.utc) + timedelta(days=3)).date()
    start = datetime(day.year, day.month, day.day, 9, 0, tzinfo=timezone.utc).isoformat()
    free_court(client, start, 180)
    coach_id = pa.get("/me/coaches").json()[0]["id"]
    assert pa.post("/me/group-bookings", json={"coach_id": coach_id, "start": start, "kinds": ["individuel"]}).status_code == 409  # jamais seul
    g = pa.post("/me/group-bookings", json={"coach_id": coach_id, "start": start, "kinds": ["groupe"], "durations": {"groupe": [90]}}).json()
    assert g["min"] == 3 and g["count"] == 1 and g["is_host"] and not g["formed"]
    tok = g["token"]
    names = {p["name"] for p in pa.get(f"/me/groups/{tok}/invitable").json()}
    assert {"Bea", "Cyr", "Dan"} <= names and "Ali" not in names
    assert pb.get(f"/me/groups/{tok}/invitable").status_code == 403  # seul l'organisateur invite
    assert pa.post(f"/me/groups/{tok}/invite", json={"player_ids": [b["id"], c["id"]], "base": "https://padel.tn"}).json()["sent"] == 2
    notif = next(n for n in pb.get("/me/notifications").json()["items"] if n["kind"] == "invitation_groupe")
    assert notif["group_token"] == tok and "Ali" in notif["title"]
    assert any(x["status"] == "invitation" for x in pb.get("/me/sessions").json()["upcoming"])
    assert client.get("/booking/requests").json() == []  # le coach ne voit rien tant que le groupe n'est pas formé
    assert pb.post(f"/me/groups/{tok}/join").json()["count"] == 2
    assert client.get("/booking/requests").json() == []
    assert pcl.post(f"/me/groups/{tok}/join").json()["formed"] is True  # 3 joueurs: envoyé au coach
    reqs = client.get("/booking/requests").json()
    assert len(reqs) == 3 and all(r["group"]["host"] == "Ali" for r in reqs)
    for r in reqs:
        assert client.post(f"/booking/requests/{r['id']}/accept", json={}).status_code == 200
    s = next(x for x in client.get("/sessions").json() if x["status"] == "prevue" and len(x["player_ids"]) == 3)
    assert s["kind"] == "groupe" and s["duration_min"] == 90 and {a["id"], b["id"], c["id"]} == set(s["player_ids"])
    # Dan reçoit le lien plus tard: il rejoint directement la séance
    assert pd.post(f"/me/groups/{tok}/join").status_code == 200
    s = next(x for x in client.get("/sessions").json() if x["id"] == s["id"])
    assert len(s["player_ids"]) == 4
