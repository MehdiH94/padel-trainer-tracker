# Déploiement sur le VPS OVH (Docker)

> **Aujourd'hui** : l'application tourne dans la sandbox de l'usine à SaaS (`docker-compose.sandbox.yml`, Docker de l'utilisateur `claude`, `https://padel-trainer-tracker-sandbox.mehdi-saas.duckdns.org`), relancée par `usine relancer padel-trainer-tracker` (voir `.claude/commands/deploy.md`). La suite de ce document décrit l'ancienne installation autonome (`deploy/`), gardée pour mémoire ; la mise en prod passera par `usine prod`.

Prérequis: Docker + Docker Compose sur le VPS, un nom de domaine qui pointe vers l'IP du VPS (nécessaire pour le HTTPS, donc pour installer l'app sur l'écran d'accueil du téléphone).

```bash
git clone <url-du-depot> padel && cd padel/deploy
cp .env.example .env && nano .env        # domaine + deux secrets (openssl rand -hex 32)
docker compose up -d --build              # construit le front, lance l'API et Caddy (HTTPS)
# Données de démo (facultatif, base vide uniquement):
docker compose exec -e API_URL=http://127.0.0.1:8000/api app python seed_demo.py
```
L'application est servie sur `https://<domaine>`; l'API sous `/api`.

- **Mise à jour**: `git pull && docker compose up -d --build` (la base est conservée dans le volume `data`).
- **Sauvegarde**: `docker compose cp app:/data/padel.db ./sauvegarde-$(date +%F).db` (à planifier avec cron).
- **Sans domaine**: laissez `DOMAIN=:80` pour tester en HTTP sur `http://<ip-du-vps>` (pas d'installation PWA).
- Le schéma est créé automatiquement au premier démarrage. Après un changement de modèle en développement, il faut migrer ou recréer la base (pas d'outil de migration pour l'instant).

## Serveur qui a déjà un proxy (Caddy/nginx sur les ports 80 et 443)
`docker compose up -d --build` lance seulement l'application, qui écoute en local sur `127.0.0.1:8081`. Ajoutez un bloc au Caddyfile du serveur (`/etc/caddy/Caddyfile`), puis `sudo systemctl reload caddy`:

```
padel.mondomaine.tn {          # HTTPS automatique avec un domaine
	reverse_proxy 127.0.0.1:8081
}
# ou, sans domaine, sur un port libre:
:8080 {
	reverse_proxy 127.0.0.1:8081
}
```
Pour utiliser le Caddy intégré à la place (ports 80/443 libres): `docker compose --profile caddy up -d --build`.

## Domaine définitif et e-mails
Voir `docs/DOMAINE.md` (DNS, HTTPS, redirection de l'ancienne adresse avec `CANONICAL_HOST`, SMTP, SPF/DKIM/DMARC, vérifications).

## Comptes test (agents de test quotidiens)
Les agents qui testent l'appli chaque matin utilisent des comptes ordinaires (un coach, un joueur), marqués « test » côté serveur seulement, dans `deploy/.env`:

```bash
TEST_ACCOUNT_EMAILS=coach.test@exemple.tn,joueur.test@exemple.tn   # e-mails de connexion, séparés par des virgules
```
puis `cd deploy && docker compose up -d` (relit `.env`; `update.sh` le fait aussi à chaque déploiement). Rien n'est modifiable depuis l'appli et rien n'est écrit en base: retirer une adresse de la liste suffit à « démarquer » le compte.

Effet (`backend/app/services/isolation.py`), deux mondes étanches:
- un vrai joueur ne voit jamais un coach test (liste des coachs, page du coach, clubs, recherche de créneaux, séances à rejoindre) et ne peut ni réserver chez lui, ni rejoindre ses séances;
- un joueur test ne voit que les coachs test et ne peut réserver chez un vrai coach (ni par une proposition, ni par un lien « remplacez-moi »): un vrai coach ne reçoit jamais sa demande;
- promotions, annonces de terrain libre et invitations d'un coach ne partent qu'aux joueurs de son monde;
- Administration › Coachs et Joueurs: champ `is_test` dans les réponses, à exclure de toute statistique de la plateforme.

Vérifier après le déploiement: connecté avec un vrai compte joueur, le coach test n'apparaît pas dans « Coachs » ni dans la recherche; connecté avec le joueur test, seul le coach test apparaît.
