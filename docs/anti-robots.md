# Protection contre les robots

## En place (sans service externe)
- **Champ piège** sur les trois inscriptions (coach, joueur par lien public ou lien du coach, invitation) : un champ
  `website` invisible pour une personne. Un robot qui remplit tous les champs est refusé (400).
- **Limites par appareil (adresse IP)** : 5 inscriptions par heure, 20 tentatives de connexion en 10 minutes,
  renvoi du lien de vérification au plus une fois par minute (`services/antibot.py`). Au-delà : 429
  « Trop de tentatives depuis cet appareil ».
- **Conditions d'utilisation** à accepter (case obligatoire, date gardée : `terms_accepted_at`).
- **E-mail à confirmer** avant de réserver : un faux compte ne peut rien réserver.

## Étape suivante si des robots passent quand même : Cloudflare Turnstile
Gratuit, sans changer le DNS (le domaine reste chez OVH) et sans énigme pour les vrais utilisateurs.
1. Créer un compte Cloudflare (gratuit) → Turnstile → « Ajouter un site » : `padel-boost.net` (et le domaine de la sandbox).
2. Récupérer la **clé de site** (publique) et la **clé secrète** (à garder dans les réglages de prod, jamais dans le dépôt).
3. Côté appli (à coder) : le petit widget Turnstile sur les formulaires d'inscription, et la vérification du jeton
   par le serveur (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) avant de créer le compte.

Mettre tout le site derrière Cloudflare (proxy, protection DDoS) est possible aussi, mais demande de déplacer le DNS
du domaine chez Cloudflare : à garder pour plus tard, si le trafic le justifie.
