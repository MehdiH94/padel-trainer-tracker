# Padel Trainer Tracker

Application de gestion pour un coach de padel indépendant (Tunisie) + espace joueur. Interface en français, fuseau Africa/Tunis, montants en millimes de TND (entiers). Lire `PLAN.md` pour les décisions produit.

## Structure
- `backend/` : FastAPI + SQLAlchemy 2 (SQLite en dev). `app/routers` (API), `app/services` (règles métier: réservations, terrains, finances), `app/sms` (fournisseur SMS abstrait, `FakeSmsProvider` en dev).
- `frontend/` : PWA React + Vite (`src/`). Le front appelle l'API via le préfixe `/api` (proxy Vite vers le port 8000).

## Commandes
```bash
# Backend (depuis backend/)
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m pytest -q                                  # 54 tests, doivent rester verts
uvicorn app.main:app --port 8000
python seed_demo.py                                  # données de démo (base vide): coach demo@padel.tn / demo1234, joueur sami@demo.tn / demo1234
# Frontend (depuis frontend/)
npm install && npm run dev                           # http://localhost:5173
npm run build
```
Le schéma est créé par `create_all`: après un changement de modèle, supprimer `backend/padel.db` et relancer le seed.

## Règles métier à ne pas casser
- Catégories P50 < P100 < P250 < P500 < P1000. Deux joueurs sont compatibles à un cran d'écart au plus; une joueuse ne joue pas avec un homme de catégorie supérieure (`constants.compatible`).
- Séance payée avec des crédits = `Attendance.credit_paid_millimes > 0`: jamais facturée une seconde fois.
- Recharge de crédits = `Payment(kind="credit")` + `CreditTx`; elle compte dans l'encaissé mais pas dans les paiements de séances.
- Aucun SMS/e-mail n'est réellement envoyé: les relances sont des liens `sms:` / `wa.me` / `mailto:` pré-remplis.
- Garder le code simple, commentaires en français, pas de dépendances inutiles.
