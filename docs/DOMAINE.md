# Passer sur le domaine définitif (DP-003) et envoyer les e-mails (DP-002)

À faire **avant le vendredi 6 novembre**, une fois le nom choisi (remplacer `padel.exemple.tn` partout).
Côté code, tout est prêt : il ne reste que de la configuration.

## 1. DNS du domaine (chez le registrar)
| Type | Nom | Valeur |
|------|-----|--------|
| A | `@` (ou le sous-domaine choisi) | IP du VPS OVH |
| AAAA | idem | IPv6 du VPS, seulement si elle est configurée |

Vérifier : `dig +short padel.exemple.tn` doit renvoyer l'IP du VPS (la propagation prend de quelques minutes à quelques heures).

## 2. HTTPS et redirection de l'ancienne adresse (sur le VPS)
Le serveur a déjà un proxy (Caddy) devant l'application. Dans `/etc/caddy/Caddyfile` :

```
padel.exemple.tn {
	reverse_proxy 127.0.0.1:8081
}

# Ancienne adresse: Caddy garde son certificat, l'application redirige vers le nouveau domaine
ancien-domaine.example {
	reverse_proxy 127.0.0.1:8081
}
```

Puis `sudo systemctl reload caddy`. Le certificat HTTPS du nouveau domaine est créé automatiquement.

Dans `~/padel/deploy/.env` :
```
DOMAIN=padel.exemple.tn
CANONICAL_HOST=padel.exemple.tn          # toute autre adresse (ancien domaine, IP) redirige ici (301)
APP_URL=https://padel.exemple.tn         # liens des e-mails (vérification, promotions)
```
Puis `bash ~/padel/deploy/update.sh` pour relancer l'application.

## 3. Envoi des e-mails (DP-002)
Utiliser un service d'envoi transactionnel (par exemple Brevo, Mailjet ou Amazon SES). Un VPS qui envoie lui-même finit souvent dans les spams. Dans le service :
1. Ajouter le domaine `padel.exemple.tn` et créer l'expéditeur `noreply@padel.exemple.tn`.
2. Ajouter dans le DNS les enregistrements que le service fournit :
   - **SPF** (TXT sur `@`), par exemple `v=spf1 include:<service> ~all` (un seul enregistrement SPF par domaine) ;
   - **DKIM** (TXT ou CNAME, nom et valeur donnés par le service) ;
   - **DMARC** (TXT sur `_dmarc`) : `v=DMARC1; p=none; rua=mailto:<votre e-mail>` pour commencer.
3. Dans `~/padel/deploy/.env` :
```
SMTP_HOST=<serveur SMTP du service>
SMTP_PORT=587                            # ou 465 (TLS direct)
SMTP_USER=<identifiant>
SMTP_PASSWORD=<mot de passe / clé SMTP>
SMTP_FROM=Padel Coach <noreply@padel.exemple.tn>
```
Dès que `SMTP_HOST` est réglé, la vérification de l'e-mail des nouveaux joueurs est exigée avant de réserver.

## 4. Vérifications (critères de DP-002 et DP-003)
- `https://padel.exemple.tn` s'ouvre avec le cadenas, et l'ancienne adresse redirige.
- Installation sur l'écran d'accueil : Android (Chrome › Installer) et iPhone (Safari › Partager › Sur l'écran d'accueil).
- Créer un joueur test par un lien d'invitation avec une adresse Gmail, puis une adresse Outlook : l'e-mail arrive en boîte de réception en quelques minutes, le lien marque le compte comme vérifié, et le renvoi fonctionne.
- mail-tester.com : envoyer l'e-mail de vérification à l'adresse donnée par le site, viser au moins 9/10.
