#!/usr/bin/env bash
# Met à jour l'application sur le serveur: sauvegarde la base, récupère le code, reconstruit, vérifie.
# Lancé à la main (bash ~/padel/deploy/update.sh) ou automatiquement par GitHub Actions.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Sauvegarde de la base"
mkdir -p ~/backups
(cd deploy && docker compose cp app:/data/padel.db ~/backups/padel-$(date +%F-%H%M).db) 2>/dev/null || echo "   (pas de base à sauvegarder)"
ls -t ~/backups/padel-*.db 2>/dev/null | tail -n +15 | xargs -r rm   # garde les 14 dernières

echo "==> Récupération du code"
git pull --ff-only

echo "==> Reconstruction"
cd deploy
docker compose up -d --build
docker image prune -f >/dev/null

echo "==> Vérification"
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8081/api/health >/dev/null 2>&1; then
    echo "OK: application en ligne"
    # Demandé par le workflow « Ajouter les coachs de démo » (commande SSH « seed-coaches »): sans effet s'ils existent déjà
    if [ "${SSH_ORIGINAL_COMMAND:-}" = "seed-coaches" ] || [ "${1:-}" = "seed-coaches" ]; then
      echo "==> Coachs de démo"
      docker compose exec -T -e API_URL=http://127.0.0.1:8000/api app python seed_more_coaches.py
    fi
    exit 0
  fi
  sleep 2
done
echo "ERREUR: l'application ne répond pas"; docker compose logs --tail 40 app; exit 1
