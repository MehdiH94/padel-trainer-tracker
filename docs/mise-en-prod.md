## Mise en prod du 2026-11-12 : expéditeur des e-mails corrigé (Brevo)
Ce qui change pour les utilisateurs : les e-mails partent enfin (lien de vérification, confirmations, rappels, invitations), avec l'expéditeur « Padel Boost <noreply@padel-boost.net> ». La version précédente refusait l'envoi : l'adresse d'expéditeur arrivait sans son adresse (« Padel Boost » seul), Brevo répondait 501.
Tickets inclus : aucun (correctif : notify.sender_address ajoute le nom « Padel Boost » à une adresse seule et accepte « Nom <adresse> », avec ou sans guillemets)
Migrations de données : aucune
Risques et retour arrière : faible, une seule fonction d'envoi change (test ajouté, 156 tests). Réglage à corriger par Mehdi avant de signer : SMTP_FROM=noreply@padel-boost.net (l'adresse seule). Les joueurs inscrits avant ont un e-mail non vérifié : bouton « Renvoyer le lien » dans l'appli.
Vérifications : usine tester OK (156 tests) ; connexion SMTP à Brevo acceptée depuis le VPS (identifiants bons, seule l'adresse d'expéditeur était refusée) ; après la mise en prod : « Renvoyer le lien » sur un compte test, e-mail reçu dans Gmail.
Domaine : padel-boost.net (enregistrement A vers 141.95.86.176)
