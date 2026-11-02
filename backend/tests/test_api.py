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


def mkplayer(c, phone="22 123 456", name="Sami", **extra):
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
    assert (bandeja["score"], bandeja["previous"]) == (3, 2)
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
    # confirmée mais le joueur n'a pas encore été prévenu
    todo = client.get("/booking/requests").json()
    assert todo[0]["status"] == "confirmee" and "confirmée" in todo[0]["message"]
    client.post(f"/booking/requests/{todo[0]['id']}/notified")
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
    # le club confirme: la réservation devient « confirmée », le coach doit prévenir le joueur
    client.post(f"/court-bookings/{cb['id']}/reply", json={"text": "OUI c'est bon"})
    assert client.get("/booking/summary").json() == {"pending": 0, "waiting_court": 0, "to_notify": 1, "waiting_players": 0}


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
    assert c1.post("/me/book", json={"kind": "individuel", "start": slot}).status_code == 201
    assert c2.post("/me/book", json={"kind": "individuel", "start": slot}).status_code == 409


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
    assert pc.post(f"/me/bookings/{near_id}/cancel").json()["refunded"] is False  # moins de 24 h avant
    assert pc.get("/me").json()["credits_millimes"] == 60000
    assert pc.post(f"/me/bookings/{far_id}/cancel").status_code == 409  # déjà annulée
    assert all(c["free"] for c in client.get("/court-bookings").json())  # les terrains sont redevenus libres


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
    _, near = player_client(client, name="Near", phone="20111111", category="P250")
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
    client.post("/sessions", json={"start": start, "club_id": nophone["id"]})
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
    ("P250", "M", "P100", "M", True), ("P250", "M", "P500", "M", True), ("P250", "M", "P1000", "M", False),
    ("P50", "M", "P250", "M", False), ("P250", "F", "P250", "M", True),
    ("P1000", "F", "P500", "M", True),   # une P1000 dame peut jouer avec un P500 homme
    ("P500", "F", "P1000", "M", False),  # mais pas avec un homme de catégorie supérieure
    ("P250", "F", "P500", "M", False), ("P250", "F", "P100", "M", True),
    ("P250", "M", "P500", "F", True), ("P500", "M", "P250", "F", False),
    ("P500", "F", "P250", "F", True), ("P500", "F", "P100", "F", False),
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
    _, ok_p = player_client(client, name="Man500", phone="20333333", category="P500", gender="M")  # P500 H: ok avec P500 D et P250 H
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
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "kind": "duo", "player_ids": [a, b], "price_millimes": 40000}).json()[0]
    assert client.get("/sessions").json()[0]["payments"] == []  # pas encore effectuée
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    client.post("/payments", json={"player_id": a, "amount_millimes": 25000, "session_id": s["id"]})
    client.post("/payments", json={"player_id": a, "amount_millimes": 15000, "session_id": s["id"]})
    pay = {x["player_id"]: x for x in client.get("/sessions").json()[0]["payments"]}
    assert pay[a] == {"player_id": a, "due_millimes": 40000, "credit_millimes": 0, "paid_millimes": 40000}
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
    assert login_as(TestClient(app), r2["token"]).get("/me").json()["contact_channel"] is None


def test_automatic_reminders_24h_and_2h(client):
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
    assert any(to == "lina@x.tn" and "demain (mardi 10/03) à 18h00 (Club X)" in body for _, to, body in Notifier.sent)
    assert send_due(db, notifier, now=start - timedelta(minutes=110)) == 3  # 2 h avant
    assert "aujourd'hui à 18h00" in Notifier.sent[-1][2]
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
    p = mkplayer(client)["id"]
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "player_ids": [p], "price_millimes": 60000}).json()[0]
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    assert client.patch(f"/sessions/{s['id']}", json={"status": "prevue"}).json()["status"] == "prevue"  # « Annuler »
    client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    assert client.patch(f"/sessions/{s['id']}", json={"status": "annulee"}).status_code == 409
    client.post("/payments", json={"player_id": p, "amount_millimes": 60000, "session_id": s["id"]})
    assert client.patch(f"/sessions/{s['id']}", json={"status": "prevue"}).status_code == 409  # déjà réglée


def test_coach_adds_player_to_session(client):
    a, b, c = (mkplayer(client, phone=f"22 000 00{i}", name=n)["id"] for i, n in enumerate("ABC"))
    s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "kind": "duo", "player_ids": [a]}).json()[0]
    assert client.post(f"/sessions/{s['id']}/players", json={"player_id": b}).json()["player_ids"] == [a, b]
    assert client.post(f"/sessions/{s['id']}/players", json={"player_id": b}).status_code == 409  # déjà dedans
    assert client.post(f"/sessions/{s['id']}/players", json={"player_id": c}).status_code == 409  # complète


# --- Demi-tranches, exercices et préparation de séance ----------------------

@pytest.mark.parametrize("a, ga, b, gb, ok", [
    ("P100+", "M", "P250-", "M", True), ("P100-", "M", "P250+", "M", True),  # tranches voisines: le +/- ne bloque pas
    ("P25+", "M", "P100-", "M", False), ("P25-", "F", "P50+", "F", True),
    ("P500-", "F", "P500+", "M", True),  # même tranche: permis même si l'homme est en haut de la tranche
    ("P500+", "F", "P1000-", "M", False),
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
    g_start = next(x for x in slots if _day_of(x) == day and x != target)
    g = other.post("/sessions", json={"start": g_start, "kind": "groupe", "open": True, "player_ids": [host["id"]], "price_millimes": 30000, "club_id": club["id"]}).json()[0]
    # (à moins de 24 h, il faut accepter d'être 2: plus le temps de compléter un groupe de 3)
    off = pc.get(f"/me/offers?day={day}&kinds=duo,groupe").json()
    assert [x["session_id"] for x in off["groups"]] == [g["id"]]
    if not off["slots_other"]:  # jour à moins de 24 h: on ne peut pas ouvrir seul un nouveau duo/groupe
        assert off["too_late"] == ["duo", "groupe"]
    assert pc.post("/me/book", json={"session_id": g["id"], "kinds": ["duo", "groupe"]}).json()["status"] in ("confirmee", "acceptee")
    assert pc.get(f"/me/offers?day={day}&kinds=duo,groupe").json()["groups"] == []  # déjà inscrit


# --- Formules multiples, durées par formule, happy hours, promotions ---------

def test_durations_happy_hours_and_multiple_kinds(client):
    open_week(client)
    st = client.get("/booking/settings").json()
    hh = [{"weekday": d, "start_time": "09:00", "end_time": "12:00", "discount_pct": 25} for d in range(7)]
    st = client.put("/booking/settings", json={**st, "duration_groupe": 90, "happy_hours": hh}).json()
    assert (st["duration_duo"], st["duration_groupe"], len(st["happy_hours"])) == (60, 90, 7)
    assert client.put("/booking/settings", json={**st, "happy_hours": [{**hh[0], "discount_pct": 95}]}).status_code == 422
    p, pc = player_client(client)
    day = _day_of(pc.get("/me/slots").json()[-1])
    off = pc.get(f"/me/offers?day={day}&kinds=individuel,groupe").json()
    slots = off["slots_other"]
    morning = next(x for x in slots if datetime.fromisoformat(x["start"].replace("Z", "+00:00")).astimezone(timezone.utc).hour == 8)  # 9h à Tunis
    opts = {o["kind"]: o for o in morning["options"]}
    assert opts["groupe"]["duration_min"] == 90 and opts["individuel"]["duration_min"] == 60
    assert opts["individuel"]["price_millimes"] == 45000 and opts["individuel"]["reason"] == "happy_hour"  # 60 TND - 25 %
    # grille commune: créneaux toutes les 30 min, mais un groupe de 90 min ne dépasse pas 21h
    last = [x for x in slots if any(o["kind"] == "groupe" for o in x["options"])][-1]
    assert datetime.fromisoformat(last["start"].replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%H:%M") == "18:30"  # 19h30 à Tunis
    # réservation: formules acceptées montrées au coach; il démarre seul (plus petite formule cochée), prix happy hour retenu
    r = pc.post("/me/book", json={"kind": "groupe", "start": morning["start"], "kinds": ["individuel", "groupe"]}).json()
    req = client.get("/booking/requests").json()[0]
    assert req["accepted_kinds"] == ["individuel", "groupe"] and req["kind"] == "individuel" and req["duration_min"] == 60 and req["price_millimes"] == 45000
    # en groupe uniquement: 90 min, prix du groupe avec la happy hour
    p2, pc2 = player_client(client, name="Gaby", phone="20444555")
    later = [x for x in slots if datetime.fromisoformat(x["start"].replace("Z", "+00:00")) >= datetime.fromisoformat(morning["start"].replace("Z", "+00:00")) + timedelta(hours=1)]
    r2 = pc2.post("/me/book", json={"kind": "groupe", "start": next(x for x in later if any(o["kind"] == "groupe" and o["reason"] == "happy_hour" for o in x["options"]))["start"], "kinds": ["groupe"]}).json()
    req2 = next(x for x in client.get("/booking/requests").json() if x["id"] == r2["id"])
    assert (req2["kind"], req2["duration_min"], req2["price_millimes"]) == ("groupe", 90, 22500)
    assert r["status"] == "en_attente" and r["charged_millimes"] == 0  # validation par le coach, rien de débité avant


def test_promotion_on_reserved_court_notifies_players(client):
    from app.notify import Notifier
    open_week(client)
    p, pc = player_client(client, contact_channel="whatsapp")
    mkplayer(client, phone="22 000 999", name="Sans compte")
    slot = pc.get("/me/slots").json()[5]
    court = free_court(client, slot, minutes=60)
    Notifier.sent.clear()
    assert client.get(f"/promotions/preview?court_booking_id={court['id']}&discount_pct=30").json()["recipients"] == 2
    promo = client.post("/promotions", json={"court_booking_id": court["id"], "discount_pct": 30}).json()
    assert promo["notified_count"] == 2 and promo["prices"]["individuel"] == 42000
    assert sorted(ch for ch, _, _ in Notifier.sent) == ["sms", "whatsapp"] and "-30 %" in Notifier.sent[0][2]
    assert [x["id"] for x in pc.get("/me/promotions").json()] == [promo["id"]]
    off = pc.get(f"/me/offers?day={_day_of(slot)}&kinds=individuel").json()
    top = off["slots_with_court"][0]
    assert top["start"][:16] == slot[:16] and top["reason"] == "promo" and top["price_millimes"] == 42000
    pc.post("/me/book", json={"kind": "individuel", "start": top["start"]})
    assert pc.get("/me/promotions").json() == []  # terrain pris: la promotion s'arrête
    assert client.get("/sessions").json()[0]["price_millimes"] == 42000
    other = free_court(client, pc.get("/me/slots").json()[8], minutes=60)
    assert client.post("/promotions", json={"court_booking_id": other["id"], "discount_pct": 2}).status_code == 422


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
    slots = pc.get("/me/slots").json()
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
    a, pa = player_client(client, name="Amel", phone="20111111", gender="F", category="P250-")
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


def test_coach_invites_players_who_trained_with_him(client):
    from app.notify import Notifier
    open_week(client)
    host = mkplayer(client, name="Host", category="P250-")
    ok = mkplayer(client, phone="22 000 001", name="Ancien", category="P250+", contact_channel="whatsapp")
    far = mkplayer(client, phone="22 000 002", name="TropFort", category="P1000-")
    mkplayer(client, phone="22 000 003", name="Nouveau", category="P250-")  # jamais entraîné
    for pid in (ok["id"], far["id"]):
        s = client.post("/sessions", json={"start": "2026-01-05T10:00:00Z", "player_ids": [pid]}).json()[0]
        client.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    g = open_duo(client, host, hours=72, kind="groupe")
    inv = client.get(f"/sessions/{g['id']}/invitable").json()
    assert [p["name"] for p in inv["players"]] == ["Ancien"] and inv["spots_left"] == 3
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
    start = _future_slot(pa, 30)
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
    assert {t.date() for t in local} == {day} and [t.strftime("%H:%M") for t in local] == ["08:00", "09:00", "10:00", "11:00"]
    off = pc.get(f"/me/offers?day={day.isoformat()}&kinds=individuel").json()
    assert len(off["slots_with_court"]) == 4 and off["slots_other"] == []
    # réservation de 9 h (validée: terrain libre): la séance prend 9 h-10 h, le reste du bloc reste libre
    assert pc.post("/me/book", json={"kind": "individuel", "start": slots[1]}).json()["status"] == "confirmee"
    left = [datetime.fromisoformat(x.replace("Z", "+00:00")).astimezone(TUNIS).strftime("%H:%M") for x in pc.get("/me/slots").json()]
    assert left == ["08:00", "10:00", "11:00"]
    free = sorted((c for c in client.get("/court-bookings").json() if c["free"]), key=lambda c: c["start"])
    assert [(datetime.fromisoformat(c["start"].replace("Z", "+00:00")).astimezone(TUNIS).strftime("%H:%M"), c["duration_min"]) for c in free] == [("08:00", 60), ("10:00", 120)]
    # le coach monte lui-même une séance à 10 h dans ce club: elle utilise le terrain libre (pas de doublon)
    s10 = datetime.combine(day, datetime.min.time().replace(hour=10), TUNIS).isoformat()
    client.post("/sessions", json={"start": s10, "club_id": club["id"], "court_booked": True})
    assert sum(1 for c in client.get("/court-bookings").json() if c["free"]) == 2  # 8 h-9 h et 11 h-12 h


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
