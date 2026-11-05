"""Données de démonstration riches. Usage: python seed_demo.py (API sur :8000, base vide).
Coach:  demo@padel.tn / demo1234
Joueur: sami@demo.tn / demo1234  (et ines@demo.tn, karim@demo.tn, rania@demo.tn)"""
import random
from datetime import datetime, timedelta, timezone

import os

import httpx

API = os.getenv("API_URL", "http://127.0.0.1:8000")  # en production: https://<domaine>/api

random.seed(7)
c = httpx.Client(base_url=API, timeout=30)
r = c.post("/auth/register", json={"email": "demo@padel.tn", "password": "demo1234", "name": "Coach Démo"})
if r.status_code == 409:
    r = c.post("/auth/login", json={"email": "demo@padel.tn", "password": "demo1234"})
c.headers["Authorization"] = "Bearer " + r.json()["token"]

PLAYERS = [  # (nom, genre, catégorie)
    ("Sami Ben Ali", "M", "P250+"), ("Ines Trabelsi", "F", "P50+"), ("Karim Jlassi", "M", "P500-"),
    ("Yasmine Gharbi", "F", "P25+"), ("Mehdi Bouazizi", "M", "P100+"), ("Rania Hammami", "F", "P250-"),
    ("Aymen Chaabane", "M", "P500+"), ("Salma Mejri", "F", "P100-"), ("Wassim Karray", "M", "P250-"),
    ("Nour Belhadj", "F", "P100+"), ("Hichem Ferchichi", "M", "P1000-"), ("Amira Dridi", "F", "P250+"),
    ("Youssef Taktak", "M", "P50-"), ("Lina Zouari", "F", "P100-"),
]
CLUB_DEFS = [
    ("Padel Club La Marsa", "71 745 100", ""),
    ("Tunis Padel Center", "71 860 200", "Bonjour, ici {coach}. Terrain dispo le {date} de {debut} à {fin} ? Merci de répondre OUI ou NON."),
    ("Carthage Padel Arena", "71 730 300", ""),
    ("Gammarth Padel", "71 910 400", ""),
]
STROKES = c.get("/strokes").json()
TAGS = STROKES + ["Placement", "Jeu au filet", "Stratégie", "Physique", "Jeu en double"]
NOTES = ["Très bonne séance, bonne concentration.", "Fatigué en fin de séance, à ménager.", "Gros progrès sur la régularité.",
         "Manque de confiance sur les balles hautes.", "Excellente attitude, très appliqué.", "A bien suivi les consignes de placement."]
IMPROVE = ["Fermer le poignet à la volée", "Mieux se placer après le service", "Anticiper le rebond de la vitre",
           "Garder les jambes fléchies", "Varier les hauteurs de balle", "Monter au filet plus tôt"]

clubs = [c.post("/clubs", json={"name": n, "phone": p, "sms_template": t}).json() for n, p, t in CLUB_DEFS]
ids = {}
for name, gender, cat in PLAYERS:
    phone = f"{random.choice('2459')}{random.randint(1000000, 9999999)}"
    first = name.split()[0].lower()
    ids[name] = c.post("/players", json={
        "name": name, "phone": phone, "gender": gender, "category": cat, "dominant_hand": random.choice(["droitier", "droitier", "gaucher"]),
        "side": random.choice(["drive", "revers"]), "email": f"{first}@demo.tn" if first in ("sami", "ines", "karim", "rania", "mehdi") else None,
        "goals": random.choice(["Gagner en régularité", "Préparer un tournoi de club", "Améliorer la défense", "Progresser en jeu au filet"]),
    }).json()["id"]
names = list(ids)
bad_payers = {"Karim Jlassi", "Nour Belhadj", "Youssef Taktak", "Wassim Karray", "Sami Ben Ali"}

# Évaluations techniques: deux relevés par coup (ancien puis récent) pour voir la progression
for n in names:
    for stroke in STROKES:
        old = random.randint(1, 5)
        c.post(f"/players/{ids[n]}/skills", json={"stroke": stroke, "score": old})
        c.post(f"/players/{ids[n]}/skills", json={"stroke": stroke, "score": max(1, min(5, old + random.choice([-1, 0, 0, 1, 1])))})

now = datetime.now(timezone.utc)
tz = timezone(timedelta(hours=1))
today = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
plan = []  # (start, kind, players, club)
for off in range(-56, 22):
    day = today + timedelta(days=off)
    if day.weekday() == 6 or off == 0:  # dimanche off; aujourd'hui géré à part
        continue
    for hour in sorted(random.sample([9, 10, 11, 14, 16, 17, 18, 19, 20], random.choice([1, 2, 2, 3]))):
        kind = random.choices(["individuel", "duo", "groupe"], [5, 3, 2])[0]
        k = {"individuel": 1, "duo": 2, "groupe": random.randint(3, 4)}[kind]
        plan.append((day + timedelta(hours=hour), kind, random.sample(names, k), random.choice(clubs)))

# Aujourd'hui, autour de l'heure actuelle: 2 terminées, 1 en cours, 3 à venir
base = now.astimezone(tz).replace(minute=0, second=0, microsecond=0)
for delta_min, kind in [(-300, "individuel"), (-180, "duo"), (-30, "individuel"), (90, "groupe"), (210, "individuel"), (330, "duo")]:
    k = {"individuel": 1, "duo": 2, "groupe": 3}[kind]
    plan.append((base + timedelta(minutes=delta_min), kind, random.sample(names, k), random.choice(clubs)))
plan.sort()

for start, kind, who, club in plan:
    price, mode = {"individuel": (60000, "par_joueur"), "duo": (80000, "groupe"), "groupe": (120000, "groupe")}[kind]
    s = c.post("/sessions", json={"start": start.isoformat(), "kind": kind, "club_id": club["id"], "price_millimes": price,
                                  "price_mode": mode, "player_ids": [ids[n] for n in who]}).json()[0]
    if start + timedelta(hours=1) > now:  # en cours ou à venir
        continue
    if random.random() < 0.08:
        c.patch(f"/sessions/{s['id']}", json={"status": "annulee"})
        continue
    c.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
    for n in who:
        if random.random() < 0.8:
            c.put(f"/sessions/{s['id']}/feedback/{ids[n]}", json={
                "worked_on": random.sample(TAGS, random.randint(1, 3)),
                "note": random.choice(NOTES), "to_improve": random.choice(IMPROVE) if random.random() < 0.7 else "",
            })

# Terrains: les séances passées sont confirmées; parmi les prochaines, mélange de statuts
cbs = c.get("/court-bookings").json()
for cb in cbs:
    when = datetime.fromisoformat(cb["start"]).replace(tzinfo=timezone.utc)
    if when < now:
        c.post(f"/court-bookings/{cb['id']}/status", json={"status": "confirmee"})
upcoming = [cb for cb in cbs if datetime.fromisoformat(cb["start"]).replace(tzinfo=timezone.utc) >= now and cb["status"] == "en_attente"]
for i, cb in enumerate(upcoming[:8]):
    if i % 4 in (0, 1):
        c.post(f"/court-bookings/{cb['id']}/reply", json={"text": random.choice(["OUI c'est bon", "Ok réservé", "Confirmé pour vous"])})
    elif i % 4 == 2:
        c.post(f"/court-bookings/{cb['id']}/reply", json={"text": "Désolé, terrain complet à cette heure"})

# Paiements: les bons payeurs règlent tout, les autres laissent les 3 dernières séances
billed = {n: [] for n in names}
for s in c.get("/sessions").json():
    if s["status"] != "effectuee":
        continue
    pid_list = s["player_ids"]
    for i, pid in enumerate(pid_list):
        share = s["price_millimes"] // len(pid_list) + (1 if i < s["price_millimes"] % len(pid_list) else 0) if s["price_mode"] == "groupe" else s["price_millimes"]
        billed[next(n for n in names if ids[n] == pid)].append((s["start"], share))
for n, items in billed.items():
    items.sort()
    keep = 3 if n in bad_payers else 0
    for start, amount in items[: len(items) - keep]:
        d = datetime.fromisoformat(start).replace(tzinfo=timezone.utc) + timedelta(days=random.randint(0, 3))
        c.post("/payments", json={"player_id": ids[n], "amount_millimes": amount, "method": random.choice(["especes", "especes", "virement"]), "paid_at": d.isoformat()})

# Réglages de réservation: disponibilités lun-sam, validation manuelle, prix par type de séance
c.put("/booking/settings", json={"auto_confirm": False, "slot_minutes": 60, "price_individuel": 60000, "price_duo": 40000, "price_groupe": 30000,
      "cancel_hours": 24, "booking_mode": "disponibilites", "availability": [{"weekday": d, "start_time": st, "end_time": en} for d in range(6) for st, en in [("09:00", "13:00"), ("15:00", "21:00")]]})

# Comptes joueurs (mot de passe demo1234) et crédits prépayés
accounts = {"Sami Ben Ali": 200000, "Ines Trabelsi": 120000, "Karim Jlassi": 0, "Rania Hammami": 300000, "Mehdi Bouazizi": 90000}
pcs = {}
for n, credit in accounts.items():
    inv = c.post(f"/players/{ids[n]}/invite").json()["token"]
    tok = httpx.post(f"{API}/auth/invite/{inv}", json={"email": f"{n.split()[0].lower()}@demo.tn", "password": "demo1234"}).json()["token"]
    pcs[n] = httpx.Client(base_url=API, headers={"Authorization": "Bearer " + tok})
    if not pcs[n].get("/me").json().get("can_book", True):
        # vérification d'e-mail exigée (SMTP_HOST ou REQUIRE_EMAIL_VERIFICATION=1): les comptes de démo sont
        # marqués vérifiés directement en base (même DATABASE_URL que le serveur), sinon ils ne pourraient pas réserver
        from app.db import SessionLocal
        from app.models import Player
        with SessionLocal() as db:
            acc = db.query(Player).filter_by(email=f"{n.split()[0].lower()}@demo.tn").one()
            acc.email_verified_at, acc.email_token = datetime.now(timezone.utc), None
            db.commit()
        if not pcs[n].get("/me").json().get("can_book", True):
            raise SystemExit("Les joueurs de démo ne peuvent pas réserver : lancez le seed avec le même DATABASE_URL que le serveur.")
    if credit:
        c.post(f"/players/{ids[n]}/credits", json={"amount_millimes": credit, "method": random.choice(["especes", "virement"])})

# Terrains que le coach a déjà réservés à la main (libres, utilisables pour de nouvelles séances)
slots = pcs["Sami Ben Ali"].get("/me/slots").json()
by_day = {}
for sl in slots:
    if sl[14:16] == "00":  # heures pleines (débuts toutes les 30 min)
        by_day.setdefault(sl[:10], []).append(sl)
days = sorted(by_day)
held = []
for k, day in enumerate(days[:5]):
    st = by_day[day][min(3, len(by_day[day]) - 1)]
    held.append(c.post("/court-bookings/manual", json={"club_id": clubs[k % 2]["id"], "start": st, "duration_min": 120, "court_label": f"Terrain {k % 3 + 1}"}).json())

# Séances ouvertes avec des places libres (pour les suggestions et les groupes automatiques)
def open_session(day_i, hour, kind, who, price, level=""):
    start = (today + timedelta(days=day_i, hours=hour)).isoformat()
    return c.post("/sessions", json={"start": start, "kind": kind, "club_id": clubs[0]["id"], "court_booked": True, "open": True,
                                      "price_millimes": price, "price_mode": "par_joueur", "level": level, "player_ids": [ids[n] for n in who]}).json()[0]

open_session(2, 18, "duo", ["Wassim Karray"], 40000)
open_session(3, 19, "groupe", ["Amira Dridi", "Rania Hammami"], 30000)
open_session(4, 10, "duo", ["Aymen Chaabane"], 40000)
open_session(2, 20, "groupe", ["Salma Mejri"], 30000)
open_session(5, 17, "duo", ["Lina Zouari"], 40000)

# Demandes de réservation des joueurs (créneaux recalculés: les séances ouvertes en ont pris certains)
slots = pcs["Sami Ben Ali"].get("/me/slots").json()
ok = {x[:16] for x in slots}
usable = [h for h in held if "start" in h and h["start"][:16] in ok]  # (un terrain refusé, ex. chevauchement, est ignoré)
pick = lambda day_i, hour: next((x for x in slots if x[:10] == days[day_i] and x[11:13] == hour), slots[day_i * 3])  # noqa: E731

# 1) Sami demande un créneau couvert par un terrain libre -> « terrain disponible »
if usable:
    pcs["Sami Ben Ali"].post("/me/book", json={"kind": "individuel", "start": usable[0]["start"]})
# 2) Ines demande un créneau pour un duo, sans terrain -> « aucun terrain »
pcs["Ines Trabelsi"].post("/me/book", json={"kind": "duo", "start": pick(2, "16")})
# 3) Mehdi rejoint une séance ouverte
sug = pcs["Mehdi Bouazizi"].get("/me/suggestions", params={"kinds": "duo,groupe"}).json()
if sug:
    pcs["Mehdi Bouazizi"].post("/me/book", json={"session_id": sug[0]["session_id"]})
# 4) Rania demande un créneau; le coach accepte en attendant le terrain (SMS au club)
r4 = pcs["Rania Hammami"].post("/me/book", json={"kind": "individuel", "start": pick(1, "10")})
if r4.status_code == 201:  # sinon (créneau pris…): la démo continue sans cette demande
    c.post(f"/booking/requests/{r4.json()['id']}/accept", json={"club_id": clubs[2]["id"]})
else:
    print("Demande de Rania non créée :", r4.json().get("detail"))
# 5) Une réservation confirmée avec un terrain libre, pas encore communiquée au joueur
if len(usable) > 1:
    r5 = pcs["Mehdi Bouazizi"].post("/me/book", json={"kind": "individuel", "start": usable[1]["start"]})
    if r5.status_code == 201 and r5.json().get("status") == "en_attente":
        c.post(f"/booking/requests/{r5.json()['id']}/accept", json={"court_booking_id": usable[1]["id"]})

# Le coach propose une séance à Karim (il peut accepter ou refuser depuis son application)
groups = c.get("/groups").json()
target = next((g for g in groups if g["kind"] == "duo" and g["players"] and g["players"][0]["category"].rstrip("+-") in ("P250", "P500")), None)
if target:
    c.post("/proposals", json={"session_id": target["session_id"], "player_id": ids["Karim Jlassi"]})

# Une relance déjà envoyée
c.post("/reminders/log", json={"player_id": ids["Karim Jlassi"], "kind": "impaye", "channel": "whatsapp"})

c.post("/sessions", json={"start": (today + timedelta(days=1, hours=21)).isoformat(), "kind": "duo", "club_id": clubs[0]["id"],
                          "price_millimes": 80000, "price_mode": "groupe", "repeat_weeks": 6,
                          "player_ids": [ids["Sami Ben Ali"], ids["Karim Jlassi"]]})
print("OK", len(plan), "séances")

# Désormais, les joueurs ne voient que les créneaux sur les terrains réservés du coach (réglage par défaut)
c.put("/booking/settings", json={**c.get("/booking/settings").json(), "booking_mode": "terrains"})

# Deux autres coachs fictifs (visibles par les joueurs dans « Réserver »)
import seed_more_coaches  # noqa: E402

seed_more_coaches.API = API
seed_more_coaches.main()
