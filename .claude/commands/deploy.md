---
description: Valide, pousse sur GitHub puis déploie sur le VPS (tests d'abord)
---

Déploie l'application. Le code passe TOUJOURS par Git avant le serveur: ne jamais modifier de fichiers directement sur le VPS.

1. `git status` : s'il y a des changements non validés, les résumer, puis les valider avec un message clair (en français).
2. Lancer les tests (`python -m pytest -q` dans `backend/`). S'ils échouent, s'arrêter et expliquer, ne pas déployer.
3. Si on est sur une branche autre que `main` : ouvrir une pull request vers `main` et la fusionner (`gh pr merge --squash`) si `gh` est disponible. Sinon, donner le lien de la PR et demander à l'utilisateur de la fusionner. Ne jamais forcer (`--force`).
4. Pousser sur `main` (`git push origin main`). Cela déclenche le workflow GitHub « Tests et déploiement » : il relance les tests puis met à jour le VPS via SSH (`deploy/update.sh` : sauvegarde de la base, `git pull`, `docker compose up -d --build`, vérification de santé).
5. Suivre le résultat : `gh run watch` si disponible, sinon indiquer à l'utilisateur de regarder l'onglet Actions. Puis vérifier `curl -fsS http://141.95.86.176:8090/api/health`.
6. Résumer en quelques lignes : ce qui a été déployé, résultat des tests, état de l'application.

Règles de sécurité :
- Jamais de `docker compose down -v`, de `seed_demo.py` ni de suppression de la base sur le VPS sans demande explicite de l'utilisateur.
- Si un changement de modèle de données (nouvelle colonne, table modifiée) est inclus, le signaler AVANT de déployer : il n'y a pas de migration automatique, la base existante n'est pas modifiée par `create_all`.
- Si le workflow GitHub est indisponible et que l'utilisateur est sur son PC, le déploiement manuel est `ssh ubuntu@141.95.86.176 "bash ~/padel/deploy/update.sh"`. Demander confirmation avant de le lancer.
