## Mise en prod du 2026-11-10 : Padel Trainer Tracker (première mise en prod)
Ce qui change pour les utilisateurs : l'application devient accessible sur https://padel-boost.net, avec de vrais comptes (coachs et joueurs), sans données de démo. L'ancienne adresse sandbox reste séparée.
Tickets inclus : aucun (première mise en ligne de la version de la sandbox)
Migrations de données : aucune (base PostgreSQL neuve en prod)
Risques et retour arrière : base vide au départ ; sauvegarde et retour à la version précédente gérés par le déployeur. La clé secrète et le secret du webhook SMS sont désormais obligatoires en prod (plus de valeur par défaut dans le code). ADMIN_EMAILS doit être rempli par Mehdi dans /etc/usine-prod/padel-trainer-tracker.reglages ; les e-mails (SMTP) sont facultatifs et peuvent rester vides.
Vérifications : usine tester OK (tests et build du front). Deuxième demande : la première avait échoué avant tout déploiement (déployeur corrigé), rien n'a changé en prod.
Domaine : padel-boost.net (enregistrement A vers 141.95.86.176, vérifié)
