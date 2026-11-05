"""Deux coachs fictifs supplémentaires, avec joueurs, séances, terrains, happy hours, promotion et exercices.
Usage: python seed_more_coaches.py (API sur :8000; en production API_URL=http://127.0.0.1:8000/api dans le conteneur).
Sans effet si les coachs existent déjà. Comptes (mot de passe demo1234):
  coach.youssef@demo.tn  — Youssef Mansouri (compétition, Lac / Tunis)
  coach.meriem@demo.tn   — Meriem Ayari (initiation, La Marsa / Hammamet)
"""
import os
import random
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

API = os.getenv("API_URL", "http://127.0.0.1:8000")
TUNIS = ZoneInfo("Africa/Tunis")
PASSWORD = "demo1234"

COACHES = [
    {
        "email": "coach.youssef@demo.tn", "name": "Youssef Mansouri",
        "bio": "Ancien joueur classé P1000, j'entraîne depuis 8 ans des joueurs qui préparent leurs tournois.\n"
               "Séances intenses : tactique de double, jeu aérien et condition physique.",
        "specialties": ["Smash", "Víbora", "Tactique", "Physique"],
        "clubs": [("Lac Padel Club", "71 965 410"), ("Tunis Padel Center", "71 860 200")],
        "prices": (80000, 50000, 35000), "durations": (60, 60, 90), "auto_confirm": True,
        "availability": [(d, "07:00", "11:00") for d in range(6)] + [(d, "17:00", "22:00") for d in range(6)],
        "happy_hours": [(d, "07:00", "10:00", 15000) for d in range(4)],  # heures creuses: -15 TND
        "players": [("Omar Ben Youssef", "M", "P500+"), ("Ahmed Kallel", "M", "P500-"), ("Fares Jemai", "M", "P1000-"),
                    ("Sarra Mabrouk", "F", "P500-"), ("Nizar Belaid", "M", "P250+"), ("Dorra Saidi", "F", "P250+")],
        "exercise": ("Smash par 4 en série", "5 lobs courts d'affilée: smash à plat puis smash par 4 dès que la balle est derrière la tête. Compter les points gagnants.", ["Smash", "Physique"], 1, 4, 15),
        "promo": 15,  # réduction en TND par joueur
    },
    {
        "email": "coach.meriem@demo.tn", "name": "Meriem Ayari",
        "bio": "Coach diplômée, spécialiste de l'initiation et de la progression des débutants.\n"
               "Pédagogie douce et ludique, séances en petits groupes, dames bienvenues.",
        "specialties": ["Service", "Retour de service", "Volée", "Déplacements"],
        "clubs": [("Padel Club La Marsa", "71 745 100"), ("Hammamet Padel Club", "72 280 330")],
        "prices": (55000, 35000, 25000), "durations": (60, 90, 90), "auto_confirm": False,
        "availability": [(d, "09:00", "13:00") for d in range(1, 7)] + [(d, "15:00", "20:00") for d in range(1, 7)],
        "happy_hours": [(d, "15:00", "17:00", 10000) for d in (1, 2, 3)],  # -10 TND
        "players": [("Leila Chebbi", "F", "P25+"), ("Hana Ben Romdhane", "F", "P50-"), ("Malek Toumi", "M", "P50+"),
                    ("Ons Gharsalli", "F", "P100-"), ("Bilel Sassi", "M", "P25-"), ("Asma Khelifi", "F", "P100+")],
        "exercise": ("Parcours volée-déplacement", "Trois cônes au filet: pas chassé, volée contrôlée sur la balle du coach, retour au centre. 4 passages.", ["Volée", "Déplacements"], 1, 4, 10),
        "promo": 10,  # réduction en TND par joueur
    },
]
NOTES = ["Belle séance, bonne énergie.", "Progrès nets sur la régularité.", "Un peu fatigué(e), séance plus courte.", "Très appliqué(e), à encourager."]
IMPROVE = ["Fermer le poignet à la volée", "Mieux se replacer après le smash", "Anticiper la sortie de vitre", "Varier les hauteurs de balle"]


def at(day_offset: int, hhmm: str) -> str:
    """Date/heure de Tunis -> ISO UTC."""
    d = datetime.now(TUNIS).date() + timedelta(days=day_offset)
    return datetime.combine(d, time.fromisoformat(hhmm), TUNIS).astimezone(timezone.utc).isoformat()


def seed_coach(cfg: dict, rng: random.Random) -> bool:
    c = httpx.Client(base_url=API, timeout=30)
    r = c.post("/auth/register", json={"email": cfg["email"], "password": PASSWORD, "name": cfg["name"]})
    if r.status_code == 409:
        print(f"{cfg['name']} existe déjà: rien à faire")
        return False
    r.raise_for_status()
    c.headers["Authorization"] = "Bearer " + r.json()["token"]
    if c.get("/auth/account").json().get("pending"):
        # coach fictif: confirmé directement (sinon il attendrait l'administrateur, comme un vrai nouveau coach)
        from app.db import SessionLocal
        from app.models import Coach
        with SessionLocal() as db:
            coach = db.query(Coach).filter_by(email=cfg["email"]).one()
            coach.signup_status, coach.email_verified_at = "validee", datetime.now(timezone.utc)
            db.commit()
    pi, pd, pg = cfg["prices"]
    di, dd, dg = cfg["durations"]
    strokes = c.get("/strokes").json()

    # Réglages, page publique, clubs
    c.put("/booking/settings", json={
        "auto_confirm": cfg["auto_confirm"], "slot_minutes": di, "duration_duo": dd, "duration_groupe": dg,
        "price_individuel": pi, "price_duo": pd, "price_groupe": pg, "cancel_hours": 24,
        "availability": [{"weekday": d, "start_time": s, "end_time": e} for d, s, e in cfg["availability"]],
        "happy_hours": [{"weekday": d, "start_time": s, "end_time": e, "discount_millimes": p} for d, s, e, p in cfg["happy_hours"]],
        "bio": cfg["bio"], "specialties": cfg["specialties"],
    }).raise_for_status()
    c.put("/clubs/selection", json={"names": [], "new": [{"name": n, "phone": p} for n, p in cfg["clubs"]]}).raise_for_status()
    clubs = c.get("/clubs").json()

    # Joueurs et évaluations techniques
    ids = []
    for name, gender, cat in cfg["players"]:
        p = c.post("/players", json={
            "name": name, "phone": f"{rng.choice('2459')}{rng.randint(1000000, 9999999)}", "gender": gender, "category": cat,
            "dominant_hand": rng.choice(["droitier", "droitier", "gaucher"]), "side": rng.choice(["drive", "revers"]),
            "contact_channel": rng.choice(["whatsapp", "sms"]), "goals": rng.choice(["Préparer un tournoi", "Gagner en régularité", "Prendre confiance au filet"]),
        }).json()
        ids.append(p["id"])
        for stroke in strokes:
            c.post(f"/players/{p['id']}/skills", json={"stroke": stroke, "score": rng.randint(1, 5)})

    # Séances passées (effectuées, avec retours et paiements) sur les 3 dernières semaines
    for k in range(10):
        day = -rng.randint(1, 21)
        kind = rng.choice(["individuel", "duo", "groupe"])
        n = {"individuel": 1, "duo": 2, "groupe": rng.choice([3, 4])}[kind]
        who = rng.sample(ids, n)
        price = {"individuel": pi, "duo": pd, "groupe": pg}[kind]
        s = c.post("/sessions", json={"start": at(day, rng.choice(["09:00", "10:00", "17:00", "18:00", "19:00"])), "kind": kind,
                                      "duration_min": {"individuel": di, "duo": dd, "groupe": dg}[kind], "club_id": rng.choice(clubs)["id"],
                                      "court_booked": True, "player_ids": who, "price_millimes": price})
        if s.status_code == 409:  # déjà une séance (un terrain) à cette heure: un coach n'a qu'un terrain à la fois
            continue
        s = s.json()[0]
        c.patch(f"/sessions/{s['id']}", json={"status": "effectuee"})
        for pid in who:
            c.put(f"/sessions/{s['id']}/feedback/{pid}", json={"worked_on": rng.sample(strokes, 2), "note": rng.choice(NOTES), "to_improve": rng.choice(IMPROVE)})
            if rng.random() < 0.75:  # quelques impayés
                c.post("/payments", json={"player_id": pid, "amount_millimes": price, "session_id": s["id"], "method": rng.choice(["especes", "virement"])})

    # Séances à venir: groupes et duos ouverts (les joueurs d'autres coachs peuvent les rejoindre)
    for day, hhmm, kind, n in [(1, "18:00", "groupe", 2), (2, "19:00", "duo", 1), (3, "10:00", "groupe", 3), (4, "17:00", "groupe", 1), (5, "18:00", "duo", 1)]:
        c.post("/sessions", json={"start": at(day, hhmm), "kind": kind, "duration_min": dg if kind == "groupe" else dd, "club_id": clubs[day % 2]["id"],
                                  "court_booked": True, "open": True, "player_ids": rng.sample(ids, n), "price_millimes": pg if kind == "groupe" else pd})

    # Terrains déjà réservés et libres, et une promotion sur l'un d'eux
    free = [c.post("/court-bookings/manual", json={"club_id": clubs[i % 2]["id"], "start": at(day, hhmm), "duration_min": 120, "court_label": f"Terrain {i + 1}"}).json()
            for i, (day, hhmm) in enumerate([(1, "20:00"), (2, "09:00"), (6, "18:00")])]
    c.post("/promotions", json={"court_booking_id": free[1]["id"], "discount_millimes": cfg["promo"] * 1000})  # promo en TND

    # Un exercice personnel
    name, desc, themes, mn, mx, dur = cfg["exercise"]
    c.post("/exercises", json={"name": name, "description": desc, "themes": themes, "min_players": mn, "max_players": mx, "duration_min": dur})
    print(f"{cfg['name']}: {len(ids)} joueurs, séances, terrains et promotion créés ({cfg['email']} / {PASSWORD})")
    return True


def main() -> None:
    rng = random.Random(11)
    for cfg in COACHES:
        seed_coach(cfg, rng)


if __name__ == "__main__":
    main()
