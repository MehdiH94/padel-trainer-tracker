# À faire (Mehdi)

Liste à cocher, mise à jour par Claude. Rien ici ne demande de coder : ce sont des comptes à créer et des réglages.

## 1. Être prévenu si le site tombe — UptimeRobot (gratuit, 10 min)
- [ ] Créer un compte sur uptimerobot.com (offre gratuite).
- [ ] « Add New Monitor » : type **Keyword**, nom `Padel Boost prod`, URL `https://padel-boost.net/api/health`,
      mot-clé `"ok":true`, alerte si le mot est **absent**, toutes les 5 minutes.
- [ ] Deuxième monitor (type HTTP) : `https://signature.mehdi-saas.duckdns.org` (page de signature des mises en prod).
- [ ] Installer l'appli UptimeRobot sur le téléphone (notifications gratuites ; les SMS sont payants).
- [ ] Facultatif : une « Status Page » publique.

## 2. OVH
- [ ] Bare Metal Cloud → VPS → ton VPS → Accueil : activer **« Monitoring par OVHcloud »** s'il est proposé.
- [ ] Mon compte → Mes informations : vérifier l'e-mail de contact (alertes et maintenances).
- [ ] Installer l'appli **OVHcloud** sur le téléphone.
- [ ] **Important** — Web Cloud → Noms de domaine → `padel-boost.net` : **renouvellement automatique** activé.
- [ ] **Important** — sauvegarde **hors du serveur** : aujourd'hui la base est sauvegardée sur la même machine.
      Prendre l'option « Sauvegarde automatique » du VPS chez OVH (quelques euros par mois), ou demander à Claude
      de préparer une copie quotidienne vers un stockage externe (à installer par toi, en root).

## 3. Conditions d'utilisation
- [ ] Compléter sur `/conditions` : nom ou raison sociale de l'éditeur, adresse, e-mail de contact
      (à donner à Claude, qui remplace l'encadré gris).
- [ ] Faire relire le texte (Claude n'est pas juriste).

## 4. Si des robots s'inscrivent malgré tout — Cloudflare Turnstile (gratuit)
- [ ] Créer un compte Cloudflare → Turnstile → ajouter `padel-boost.net` → donner la **clé de site** à Claude
      (la clé secrète ira dans les réglages de prod, jamais dans le chat). Détails : `docs/anti-robots.md`.

## 5. Rappels par WhatsApp (plus tard, si tu le veux)
- [ ] L'envoi automatique par WhatsApp passe par l'API WhatsApp Business de Meta : compte Meta Business vérifié,
      un numéro dédié, des modèles de messages validés par Meta, et un coût par conversation. En attendant :
      e-mail + notifications du téléphone (gratuites, déjà en place).

## 6. Avant chaque mise en prod
- [ ] Regarder sur GitHub (onglet Actions) que les tests sont verts, puis signer sur
      https://signature.mehdi-saas.duckdns.org

## Fonctions de l'appli (état)
| Fonction | État |
|---|---|
| Mot de passe oublié (coachs et joueurs) | fait (sandbox) |
| Page d'accueil publique du site, annuaire des coachs, page publique de chaque coach | fait (sandbox) |
| Avis des joueurs sur les coachs (après une séance) | fait (sandbox) |
| Suppression de son compte par le joueur | fait (sandbox) |
| Notifications du téléphone (Android, iPhone avec l'appli sur l'écran d'accueil) | fait (sandbox) |
| Liste d'attente des séances complètes | fait (sandbox) |
| Packs de crédits du coach (ex. 10 séances) | fait (sandbox) |
| Paiement en ligne | abandonné : tout est gratuit, les joueurs paient leur coach directement |
| Rappels par WhatsApp | en attente (voir point 5) |
| Version en arabe | à faire (gros travail de traduction : à planifier) |
| Espace club, synchronisation Google Agenda, reçus, statistiques partageables | plus tard |
