# Padel Trainer Tracker — plan court

## Décisions (validées)
- **Mobile** : PWA React (installable, hors-ligne via service worker pour le planning du jour).
- **Backend** : FastAPI + SQLAlchemy 2, SQLite en dev, PostgreSQL sur le VPS OVH. Auth JWT, un coach par compte, `coach_id` sur toutes les tables (multi-coach possible plus tard sans migration lourde).
- **SMS** : interface `SmsProvider` ; `FakeSmsProvider` (journalise) en dev, `AndroidGatewaySmsProvider` ensuite (téléphone du coach comme passerelle). Twilio / passerelle locale = nouvelles classes, pas de changement métier.
- **Périmètre MVP** : planning (séances + récurrence), joueurs, packs et paiements, dashboard de base.
- **Conventions** : numéros normalisés `+216XXXXXXXX`, heures stockées en UTC et affichées en Africa/Tunis, montants en millimes (entiers) pour éviter les erreurs de flottants sur le TND à 3 décimales, textes en français via clés i18n (RTL arabe plus tard).

## Modèle de données (MVP)
`Coach` 1—n `Player`, `Court`/`Club`, `Session`, `Pack`, `Payment`
- `Session` : coach, club, terrain, début, durée, type (individuel/duo/groupe), niveau, statut (prévue/effectuée/annulée), `recurrence_id` ; n—n `Player` via `Attendance`.
- `Pack` : joueur, séances totales/restantes, prix. `Attendance` décrémente le pack automatiquement.
- `Payment` : joueur, montant (millimes), moyen (espèces/virement), session ou pack lié.

## Phases
1. **MVP** (en cours) : auth, joueurs, séances + récurrence, packs/paiements, dashboard, abstraction SMS (fake). Front PWA.
2. **V2** : réservation de terrains par SMS (modèle par club, parsing des réponses), fiche joueur partageable, reçus PDF, rappels veille de séance, matériel.
3. **V3** : prise de RDV par SMS/WhatsApp, tournois, liste d'attente, multi-coach, arabe/RTL.

## Risques
- **SMS clubs** : réponses non standard → toujours une confirmation manuelle de repli. À valider par quelques appels aux clubs avant la V2.
- **Données personnelles** (loi tunisienne 2004-63) : consentement des joueurs, lien public révocable, pas de données sensibles dans les SMS.
- **Adoption** : saisie rapide (3 taps pour une séance) et mode hors-ligne.

## Mise à jour (session 4) — pivot
- **Abandonné** : bot de réservation par SMS/appel entrant et lien public sans compte. On connaît les joueurs: ils ont un compte.
- **Deux applications dans une** (même PWA, rôle dans le jeton) : *coach* (gestion complète) et *joueur* (solde de crédits, réservation, séances, progression). Le joueur crée son compte via un lien d'invitation à usage unique généré par le coach.
- **Crédits** : le joueur paie à l'avance (espèces/virement saisis par le coach) → recharge = encaissement + crédits. Réserver débite le prix d'une séance; séance « prépayée » non facturée une 2e fois. Annulation remboursée si faite au moins N heures avant (réglage, 24 h par défaut), refus ou annulation par le coach = remboursement intégral. Confirmation auto ou manuelle (réglage).
- **Relances** : page dédiée (impayés, séances de demain, invitations, crédits bas). Chaque relance = message pré-rédigé et modifiable + liens `sms:`, `wa.me`, `mailto:`; l'ouverture est tracée (« WhatsApp il y a 2 j »). Pas d'envoi serveur: aucun SMS/e-mail sortant automatique sans passerelle (voir ci-dessous).
- **Terrains par SMS** : clubs (numéro + modèle de message avec variables), une demande par séance (statuts à envoyer / en attente / confirmée / refusée), envoi automatique à la création si la séance a lieu dans moins de 7 jours (sinon une tâche de fond envoie quand l'échéance approche), analyse de la réponse (collée par le coach ou reçue par webhook `POST /courts/inbound`), repli manuel, SMS d'annulation au club si la séance est annulée.
- **Reste à brancher** : fournisseur SMS réel (passerelle Android ou locale) derrière `SmsProvider` — aujourd'hui `FakeSmsProvider` journalise seulement; notifications push/e-mail au joueur et au coach; paiement en ligne des recharges (aujourd'hui saisi par le coach).

## Mise à jour (session 5)
- **Classement** : chaque joueur a un genre (M/F) et une catégorie P50 < P100 < P250 < P500 < P1000 (P50 = niveau d'entrée, P1000 = le plus fort; modifiable depuis la fiche). Sert à composer les groupes.
- **Types de séance** : individuel (1), duo (2), groupe (3-4, capacité 4). Prix distincts par joueur (réglages).
- **Réservation joueur** : il coche un ou plusieurs types (ou « pas de préférence »), voit d'abord les séances déjà montées compatibles (niveau ±1 « idéal », jusqu'à ±2 ou autre type « proche »), peut les rejoindre; sinon il choisit un nouveau créneau. Ses préférences sont mémorisées.
- **Groupes automatiques** : onglet Demandes → Groupes à compléter: pour chaque séance ouverte avec des places libres, joueurs compatibles (niveau, type souhaité); le coach propose, le joueur accepte/refuse dans son app.
- **Terrains** : saisie manuelle de terrains déjà réservés (libres) ou « terrain déjà réservé » à la création d'une séance. Chaque demande de réservation indique si un terrain libre couvre le créneau: accepter avec ce terrain, ou accepter en attendant la confirmation (SMS au club); la confirmation du club génère un message de validation à envoyer au joueur (SMS/WhatsApp/e-mail).
- **Demandes** : onglet dédié avec badge rouge (demandes à traiter + confirmations à envoyer).
- **Design** : thème bleu, icônes SVG, graphique en araignée pour l'évaluation technique.

## Mise à jour (session 6)
- **Règle de niveau** (`constants.compatible`) : au plus un cran d'écart (P250 avec P100 ou P500), avec chaque joueur de la séance. Une joueuse ne joue pas avec un homme de catégorie supérieure à la sienne (P1000 dame avec P500 homme: oui; P500 dame avec P1000 homme: non). Appliquée aux suggestions des joueurs, aux candidats proposés par le coach et au refus d'une inscription incompatible.
- **Fiches joueurs modifiables** (nom, téléphone, e-mail, genre, classement, main, côté, objectifs, notes privées).
- **Accueil en agenda** : bande de 14 jours à faire défiler, séances à venir seulement (terminées et annulées masquées), note du coach modifiable sur chaque séance (aussi visible dans le planning).

## Mise à jour (session 7)
- **Règlements par séance** : chaque séance effectuée montre, par joueur, la part due, ce qui a été réglé (paiements rattachés à la séance, ou paiements libres imputés aux plus anciennes séances) ou « payé en crédits », avec un bouton « Encaisser » pour le reste (planning et accueil).
- **Planning** : les séances effectuées du jour sont regroupées dans une liste compacte qui défile (une ligne par séance, dépliable).
- **Rappels automatiques** : 24 h et 2 h avant chaque séance prévue, par le moyen choisi par le joueur (WhatsApp / SMS / e-mail), demandé à la création du compte et, pour les comptes existants, à la première connexion (modifiable ensuite par le joueur ou par le coach sur la fiche). Tâche de fond toutes les 5 min, chaque rappel n'est envoyé qu'une fois (`session_reminders`).
- **Reste à brancher** : passerelle SMS réelle, passerelle WhatsApp (API WhatsApp Business), réglages SMTP sur le VPS pour les e-mails.

## Mise à jour (session 8) — ergonomie
- **Sécurité des gestes** : annulation de séance, refus de demande et suppression de terrain demandent confirmation; « Effectuée » peut être annulée quelques secondes (retour à « prévue » tant que rien n'est encaissé pour la séance). Messages de confirmation (toasts) au lieu des fenêtres du navigateur.
- **Navigation** : 5 onglets (Terrains s'ouvre depuis le Planning), adresses par écran (`#/planning`, `#/players/12`…) pour le bouton retour et les liens directs, recherche de joueur depuis tous les écrans, menu latéral sur ordinateur.
- **Fluidité** : blocs de chargement, mode hors-ligne (service worker `public/sw.js`: dernières données consultables, bandeau « Hors connexion »), proposition d'installation sur l'écran d'accueil.
- **Raccourcis coach** : copier une séance à la semaine suivante, ajouter un joueur à une séance depuis sa fiche, encaisser depuis « À relancer », guide « Bien démarrer » (prix, disponibilités, premier joueur).

## Mise à jour (session 9) — niveaux fins, exercices, préparation de séance
- **Classement** : 12 niveaux, de P25- à P1000+, pour les hommes comme pour les dames. Les règles de compatibilité restent sur la tranche principale (comportement inchangé); le +/- sert au classement des suggestions. Les anciens niveaux deviennent « - » (P100 → P100-).
- **Bibliothèque d'exercices** (Planning › Exercices) : 32 exercices proposés par l'application, classés par thèmes (coups, déplacements, tactique, physique, échauffement, jeu, retour au calme); le coach ajoute, modifie et supprime les siens.
- **Préparer la séance** (bouton sur chaque séance) : points faibles de chaque joueur (coups notés bas, notes « à retravailler »), thèmes recommandés ou choisis par le coach (3 max), puis plan minuté dessiné selon la durée et le nombre de joueurs (frise + liste d'exercices), « Autre proposition », enregistrement.
