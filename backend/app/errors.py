"""Messages d'erreur compréhensibles: les données refusées (formulaires) sont expliquées en français,
champ par champ, au lieu d'une liste technique (« 422 »)."""
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

LABELS = {
    "name": "Nom", "phone": "Téléphone", "email": "E-mail", "password": "Mot de passe", "gender": "Genre",
    "category": "Niveau", "level": "Niveau", "start": "Date et heure", "duration_min": "Durée", "kind": "Formule",
    "price_millimes": "Prix", "amount_millimes": "Montant", "club_id": "Club", "coach_id": "Coach", "player_id": "Joueur",
    "player_ids": "Joueurs", "message": "Message", "discount_pct": "Remise", "court_label": "Terrain", "until": "Date de fin",
    "start_time": "Heure de début", "end_time": "Heure de fin", "slot_minutes": "Durée d'une séance", "contact_channel": "Moyen de contact",
}


def explain(err: dict) -> str:
    field = next((str(x) for x in reversed(err.get("loc", [])) if isinstance(x, str) and x != "body"), "")
    label = LABELS.get(field, field.replace("_", " ").capitalize() or "Donnée")
    kind, msg = err.get("type", ""), err.get("msg", "")
    if kind == "value_error":  # nos propres messages (téléphone tunisien, e-mail…): déjà en français
        return msg.removeprefix("Value error, ").rstrip(".") + "."
    if kind == "missing":
        return f"{label} : ce champ est obligatoire."
    if kind.startswith(("int_", "float_")):
        return f"{label} : un nombre est attendu."
    if kind.startswith(("datetime", "date", "time")):
        return f"{label} : date ou heure invalide."
    if kind.startswith("string_too_short"):
        return f"{label} : trop court."
    if kind.startswith("string_too_long"):
        return f"{label} : trop long."
    if kind.startswith(("bool_",)):
        return f"{label} : valeur oui/non attendue."
    if kind == "json_invalid":
        return "Les données envoyées sont illisibles. Rechargez la page et réessayez."
    return f"{label} : valeur invalide."


async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    messages = list(dict.fromkeys(explain(e) for e in exc.errors()))  # sans doublons
    return JSONResponse(status_code=422, content={"detail": " ".join(messages), "errors": messages})


def check_fields(*, name: str | None = None, email: str | None = None, password: str | None = None,
                 email_required: bool = True, password_required: bool = True) -> None:
    """Vérifie nom, e-mail et mot de passe et explique précisément ce qui ne va pas (un problème à la fois)."""
    from fastapi import HTTPException
    if name is not None and not name.strip():
        raise HTTPException(422, "Nom : ce champ est obligatoire.")
    if email is not None or email_required:
        e = (email or "").strip()
        if not e and email_required:
            raise HTTPException(422, "E-mail : ce champ est obligatoire.")
        if e and ("@" not in e or "." not in e.split("@")[-1] or " " in e):
            raise HTTPException(422, "Adresse e-mail invalide : elle doit être de la forme nom@exemple.com.")
    if password is not None or password_required:
        if not password and password_required:
            raise HTTPException(422, "Mot de passe : ce champ est obligatoire.")
        if password and len(password) < 6:
            raise HTTPException(422, "Mot de passe trop court : 6 caractères minimum.")
