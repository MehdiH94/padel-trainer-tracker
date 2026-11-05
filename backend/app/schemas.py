import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from .constants import CATEGORIES, normalize_category

CHANNELS = ("whatsapp", "sms", "email")  # moyens de contact pour les rappels


def normalize_tn_phone(raw: str) -> str:
    digits = re.sub(r"[\s.\-()]", "", raw)
    if digits.startswith("+216"):
        digits = digits[4:]
    elif digits.startswith("00216"):
        digits = digits[5:]
    if not re.fullmatch(r"\d{8}", digits):
        raise ValueError("Numéro de téléphone invalide : il faut 8 chiffres (ex. 22 123 456), éventuellement précédés de +216")
    return "+216" + digits


class Creds(BaseModel):
    email: str
    password: str
    name: str = ""


class PlayerIn(BaseModel):
    name: str
    phone: str
    email: str | None = None
    gender: str = "M"
    category: str = "P100-"
    pref_kinds: str = "individuel,duo,groupe"
    dominant_hand: str = "droitier"
    side: str = "drive"
    goals: str = ""
    notes: str = ""
    contact_channel: str | None = None  # whatsapp / sms / email

    @field_validator("contact_channel")
    @classmethod
    def _channel(cls, v: str | None) -> str | None:
        if v and v not in CHANNELS:
            raise ValueError("Moyen de contact invalide")
        return v or None

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_tn_phone(v)

    @field_validator("gender")
    @classmethod
    def _gender(cls, v: str) -> str:
        if v not in ("M", "F"):
            raise ValueError("Genre invalide")
        return v

    @field_validator("category")
    @classmethod
    def _category(cls, v: str) -> str:
        v = normalize_category(v.strip().upper())
        if v not in CATEGORIES:
            raise ValueError("Niveau invalide : choisissez un niveau de P25- à P1000+")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str | None) -> str | None:
        v = (v or "").strip().lower()
        if v and "@" not in v:
            raise ValueError("Adresse e-mail invalide : elle doit contenir un @ (ex. nom@gmail.com)")
        return v or None


class PlayerOut(PlayerIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    has_account: bool = False
    email_verified: bool = False  # e-mail du compte vérifié (DP-002)
    credits_millimes: int = 0
    invite_path: str | None = None  # lien d'inscription pré-rempli (joueur sans compte)
    signup_status: str | None = None  # inscription à confirmer par l'administrateur


class SessionIn(BaseModel):
    start: datetime
    duration_min: int = 60
    kind: str = "individuel"
    level: str = ""
    club: str = ""
    club_id: int | None = None
    court_booked: bool = False  # terrain déjà réservé à la main: aucun SMS au club
    open: bool = False  # places libres proposées aux autres joueurs
    court: str = ""
    price_millimes: int = 0
    price_mode: str = "par_joueur"  # par_joueur: prix pour chacun / groupe: prix total partagé
    # Prix fixé par les réglages du coach (prix par joueur de la formule), moins cette promotion en %.
    # None = ancien fonctionnement (prix saisi dans price_millimes).
    discount_pct: int | None = None
    discount_millimes: int | None = None  # réduction en dinars par joueur (remplace discount_pct)
    player_ids: list[int] = []
    repeat_weeks: int = 1  # >1 crée une série hebdomadaire


class SessionPatch(BaseModel):
    start: datetime | None = None
    status: str | None = None  # prevue / effectuee / annulee


class PlayerPaymentOut(BaseModel):
    player_id: int
    due_millimes: int  # part due pour cette séance (0 si payée avec les crédits)
    credit_millimes: int  # payé avec les crédits
    paid_millimes: int  # paiements enregistrés pour cette séance


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    start: datetime
    duration_min: int
    kind: str
    level: str
    club: str
    club_id: int | None = None
    court_status: str | None = None
    open: bool = False
    feedback_missing: bool = False  # séance terminée sans aucun retour du coach
    has_plan: bool = False  # plan de séance (exercices) enregistré
    min_players: int = 1  # nombre de joueurs voulu par tous pour que la séance soit confirmée
    max_players: int = 4  # places au total (services/groups)
    court: str
    status: str
    price_millimes: int
    price_mode: str
    recurrence_id: str | None
    player_ids: list[int] = []
    payments: list[PlayerPaymentOut] = []  # séance effectuée: ce que chaque joueur a réglé


class PaymentIn(BaseModel):
    player_id: int
    amount_millimes: int
    method: str = "especes"
    session_id: int | None = None
    paid_at: datetime | None = None  # par défaut: maintenant


class PaymentOut(PaymentIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    paid_at: datetime
