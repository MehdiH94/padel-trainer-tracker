---
description: Valide, teste puis relance l'application dans la sandbox de l'usine (VPS)
---

Déploie l'application dans la sandbox de l'usine. Se lance sur le VPS, dans `~/projets/padel-trainer-tracker` (session Remote Control, `whoami` = `claude`).

1. `git status` : s'il y a des changements non validés, les résumer, puis les valider sur `main` avec un message clair (en français).
2. Tests : `usine tester padel-trainer-tracker` (pytest et build du front, dans des conteneurs). S'ils échouent, s'arrêter et expliquer, ne pas relancer.
3. `usine relancer padel-trainer-tracker` : reconstruit l'image, redémarre le conteneur et attend qu'il soit en bonne santé (journaux affichés sinon).
4. Pousser sur GitHub (`git push origin main`) si la clé du VPS le permet : le push lance seulement les tests GitHub (y compris Playwright).
5. Vérifier `curl -fsS https://padel-trainer-tracker-sandbox.mehdi-saas.duckdns.org/api/health`.
6. Résumer en quelques lignes : ce qui a été relancé, résultat des tests, état de l'application.

Règles de sécurité :
- Jamais de `docker compose down -v`, de `seed_demo.py` ni de suppression de la base sans demande explicite de l'utilisateur.
- Si un changement de modèle de données (nouvelle colonne, table modifiée) est inclus, le signaler AVANT de relancer : il n'y a pas de migration automatique, la base existante n'est pas modifiée par `create_all`.
- Sauvegarde avant un changement risqué : `docker compose -p padel-trainer-tracker-sandbox -f docker-compose.sandbox.yml --env-file .env.sandbox exec -T db pg_dump -U app app | gzip > ~/sauvegardes/padel-$(date +%F-%H%M).sql.gz`.
