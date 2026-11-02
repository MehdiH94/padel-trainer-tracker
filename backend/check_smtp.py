"""Teste l'envoi d'e-mail avec les réglages SMTP du serveur et affiche la réponse exacte du serveur d'e-mail.
Usage (sur le VPS): docker compose exec app python check_smtp.py [adresse_destinataire]"""
import os
import smtplib
import sys

host, port = os.getenv("SMTP_HOST"), int(os.getenv("SMTP_PORT", "587"))
user, password = os.getenv("SMTP_USER", ""), os.getenv("SMTP_PASSWORD", "")
sender = os.getenv("SMTP_FROM") or user
to = sys.argv[1] if len(sys.argv) > 1 else user
print(f"SMTP_HOST={host!r}  SMTP_PORT={port}  SMTP_USER={user!r}  SMTP_FROM={sender!r}")
print(f"SMTP_PASSWORD: {len(password)} caractères{' (contient des espaces !)' if ' ' in password else ''}"
      f"{' (contient des guillemets !)' if any(q in password for q in '\"' + chr(39)) else ''}")
if not host:
    sys.exit("SMTP_HOST est vide: les lignes SMTP_… ne sont pas dans deploy/.env, ou l'application n'a pas été relancée.")
try:
    smtp = smtplib.SMTP_SSL(host, port, timeout=20) if port == 465 else smtplib.SMTP(host, port, timeout=20)
    if port != 465:
        smtp.starttls()
    print("Connexion au serveur d'e-mail: OK")
    smtp.login(user, password)
    print("Identifiant et mot de passe: OK")
    smtp.sendmail(user, [to], f"From: {sender}\r\nTo: {to}\r\nSubject: Test Padel Coach\r\n\r\nLes e-mails de Padel Coach fonctionnent.")
    smtp.quit()
    print(f"ENVOI OK vers {to} (regardez aussi dans les spams)")
except Exception as e:  # message exact du serveur d'e-mail
    print(f"ÉCHEC: {type(e).__name__}: {e}")
