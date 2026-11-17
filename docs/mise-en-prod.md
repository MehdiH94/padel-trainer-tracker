## Mise en prod du 2026-11-17 : inscription par le lien général du coach sans attente de l'admin
Ce qui change pour les utilisateurs : un joueur qui crée son compte avec le lien d'inscription général d'un coach (Joueurs › « Mon lien d'inscription ») utilise l'application tout de suite, comme avec le lien personnel ; l'administrateur est toujours prévenu par e-mail et vérifie après coup dans Administration › Inscriptions (il peut encore refuser). Le lien public (« Joueur ? Créer mon compte », sans coach) attend toujours la confirmation de l'administrateur ; la confirmation de l'e-mail reste demandée avant de réserver.
Tickets inclus : aucun (1dc5ad5)
Migrations de données : aucune
Risques et retour arrière : faible (une seule règle, signups.player_pending) ; les joueurs déjà inscrits par le lien général et encore en attente accèdent à l'application dès la mise en prod. Sauvegarde de la base et retour à dad91e9 gérés par le déployeur. Réglages de prod (.env.prod.example) inchangés : rien à remplir.
Vérifications : usine tester OK (162 tests backend, build du front) ; sandbox relancée ; tests GitHub (e2e compris) non vérifiés depuis le VPS.
Domaine : padel-boost.net (enregistrement A vers 141.95.86.176)
