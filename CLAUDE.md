# Padel Trainer Tracker

Application de gestion pour un coach de padel indépendant (Tunisie) + espace joueur. Interface en français, fuseau Africa/Tunis, montants en millimes de TND (entiers). Lire `PLAN.md` pour les décisions produit.

## Structure
- `backend/` : FastAPI + SQLAlchemy 2 (SQLite en dev). `app/routers` (API), `app/services` (règles métier: réservations, terrains, finances), `app/sms` (fournisseur SMS abstrait, `FakeSmsProvider` en dev).
- `frontend/` : PWA React + Vite (`src/`). Le front appelle l'API via le préfixe `/api` (proxy Vite vers le port 8000).

## Design
- Skill `ui-ux-pro-max` dans `.claude/skills/` (à utiliser pour tout travail d'interface). Système de design: `design-system/padel-coach/MASTER.md` (lire l'encadré « Adaptation retenue » en tête). Couleurs uniquement via les jetons CSS de `frontend/src/style.css` (mode clair + sombre), pas de couleur en dur dans les composants.

## Git
- Toujours pousser directement sur `main` (sans demander, sans demande de fusion): chaque push sur `main` lance les tests puis le déploiement sur le VPS.

## Commandes
```bash
# Backend (depuis backend/)
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m pytest -q                                  # 75 tests, doivent rester verts
uvicorn app.main:app --port 8000
python seed_demo.py                                  # données de démo (base vide): coach demo@padel.tn / demo1234, joueur sami@demo.tn / demo1234
# Frontend (depuis frontend/)
npm install && npm run dev                           # http://localhost:5173
npm run build
```
Le schéma est créé par `create_all`: après un changement de modèle, supprimer `backend/padel.db` et relancer le seed.

## Règles métier à ne pas casser
- Classement en demi-tranches P25- < P25+ < P50- < … < P1000+ (`constants.CATEGORIES`, même échelle hommes/femmes; un ancien code « P100 » vaut « P100- »). Compatibilité sur la tranche principale (P25, P50, P100, P250, P500, P1000): un cran d'écart au plus, et une joueuse ne joue pas avec un homme d'une tranche supérieure (`constants.compatible`). Le +/- affine le classement des suggestions.
- Exercices: ceux de l'application (`services/exercises_catalog.py`, `coach_id` nul, non modifiables) + ceux du coach. Préparation de séance (`services/planner.py`): thèmes recommandés d'après les coups notés ≤ 2 (ou 3) et les notes « à retravailler », plan minuté échauffement → exercices → jeu → retour au calme selon la durée et le nombre de joueurs, enregistré dans `TrainingSession.plan` (JSON).
- Multi-coachs: un joueur voit tous les coachs et réserve chez n'importe lequel. Une fiche `Player` par coach; les fiches chez d'autres coachs sont reliées au compte par `Player.account_id` (`services/accounts.py`: `linked`, `row_for_coach`). Les routes `/me` regroupent toutes les fiches du compte. Crédits propres à chaque coach.
- Réservation joueur: crédits débités s'il y en a assez chez ce coach, sinon séance due et réglée sur place (`Booking.charged_millimes = 0`, la séance garde le prix du coach). Recherche par jour (`services/marketplace.offers`): groupes à rejoindre, puis créneaux avec terrain déjà réservé, puis les autres.
- Formules: durée par formule (`slot_minutes` = individuel, `duration_duo`, `duration_groupe`; grille des débuts = PGCD des durées) et prix par joueur. Prix d'une nouvelle séance = `services/pricing.quote`: la plus forte remise entre happy hour (`HappyHour`) et promotion (`Promotion` sur un terrain réservé libre) s'applique; prix convenu gardé dans `Booking.price_millimes`. Le joueur coche une ou plusieurs formules: `Booking.accepted_kinds` est montré au coach.
- Promotion: notifie une fois chaque compte joueur du coach (moyen de contact choisi), s'arrête quand le terrain est pris.
- Séance payée avec des crédits = `Attendance.credit_paid_millimes > 0`: jamais facturée une seconde fois.
- Recharge de crédits = `Payment(kind="credit")` + `CreditTx`; elle compte dans l'encaissé mais pas dans les paiements de séances.
- Les relances manuelles du coach sont des liens `sms:` / `wa.me` / `mailto:` pré-remplis.
- Seule exception: les rappels automatiques de séance (24 h et 2 h avant, `services/session_reminders.py`, une fois chacun) partent par le moyen choisi par le joueur (`Player.contact_channel`) via `app/notify.py`: SMS par `SmsProvider` (fake = journal), e-mail par SMTP si `SMTP_HOST` est réglé, WhatsApp journalisé tant qu'aucune passerelle n'est branchée.
- Paiement de séance: `Payment.session_id` le rattache à une séance; sans séance, il couvre les plus anciennes séances effectuées encore dues.
- Garder le code simple, commentaires en français, pas de dépendances inutiles.
