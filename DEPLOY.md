# Déploiement sur le VPS OVH (Docker)

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
