from datetime import date, datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, UTCDateTime


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Coach(Base):
    __tablename__ = "coaches"
    id: Mapped[int] = mapped_column(primary_key=True)
    join_token: Mapped[str | None] = mapped_column(String(32), nullable=True)  # lien d'inscription du coach (pour tous ses joueurs)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(120))
    # Réservation par les joueurs avec leurs crédits
    auto_confirm: Mapped[bool] = mapped_column(default=True)
    slot_minutes: Mapped[int] = mapped_column(Integer, default=60)  # ancien réglage (durées choisies par le joueur maintenant)
    hourly_prices: Mapped[bool] = mapped_column(default=True)  # prix par heure (anciens prix par séance convertis au démarrage)
    duration_duo: Mapped[int | None] = mapped_column(Integer, nullable=True)  # None = comme slot_minutes
    duration_groupe: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_individuel: Mapped[int] = mapped_column(Integer, default=0)  # prix par joueur, en millimes
    price_duo: Mapped[int] = mapped_column(Integer, default=0)
    price_groupe: Mapped[int] = mapped_column(Integer, default=0)
    # Durées proposées aux joueurs et prix par joueur pour chaque formule et durée (JSON {"duo": {"60": 40000, "90": 55000}}),
    # pas forcément au prorata; None = prix de l'heure ci-dessus (seul 1 h, à deux et en groupe 1 h ou 1 h 30 au prorata)
    price_grid: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Prix VIP (même forme que price_grid, mêmes durées): pour les joueurs de la liste VIP du coach; durée sans prix
    # VIP = prix standard
    vip_price_grid: Mapped[str | None] = mapped_column(Text, nullable=True)
    terms_accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # conditions d'utilisation acceptées
    # Les joueurs réservent au plus ce nombre de jours à l'avance (une semaine à 3 mois)
    booking_horizon_days: Mapped[int] = mapped_column(Integer, default=14)
    # Éviter les trous: aucun début proposé aux joueurs qui laisserait un bout de terrain (ou de disponibilité) de moins
    # d'1 h; sinon tout début possible, le coach est prévenu du temps perdu dans la demande
    avoid_gaps: Mapped[bool] = mapped_column(default=True)
    cancel_hours: Mapped[int] = mapped_column(Integer, default=24)  # remboursement si annulation >= N heures avant
    # Créneaux proposés aux joueurs: « terrains » = seulement sur ses terrains réservés libres (par défaut),
    # « disponibilites » = toutes ses plages de disponibilité (il réserve le terrain après coup)
    booking_mode: Mapped[str] = mapped_column(String(16), default="terrains")
    # Page publique vue par les joueurs
    bio: Mapped[str] = mapped_column(Text, default="")
    specialties: Mapped[str] = mapped_column(String(255), default="")  # thèmes séparés par des virgules
    phone: Mapped[str] = mapped_column(String(20), default="")
    # Critères de l'araignée (liste JSON); None = critères standards (coups du padel)
    criteria: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Administrateurs: e-mails de ADMIN_EMAILS (toujours) + coachs nommés par un administrateur
    is_admin: Mapped[bool] = mapped_column(default=False)
    # Coach inscrit lui-même: « a_valider » tant qu'un administrateur n'a pas confirmé (rien n'est possible avant),
    # « validee » ensuite, « refusee » si refusé; None = compte créé avant cette règle ou par un administrateur
    signup_status: Mapped[str | None] = mapped_column(String(12), nullable=True)
    signup_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    email_token: Mapped[str | None] = mapped_column(String(48), nullable=True)
    email_token_sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class Player(Base):
    __tablename__ = "players"
    id: Mapped[int] = mapped_column(primary_key=True)
    # Coach de cette fiche. None = compte créé par le lien d'inscription public (pas encore de coach):
    # une fiche chez un coach est ajoutée à sa première réservation (accounts.row_for_coach).
    coach_id: Mapped[int | None] = mapped_column(ForeignKey("coaches.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(20))  # +216XXXXXXXX
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)  # None = pas de compte
    invite_token: Mapped[str | None] = mapped_column(String(40), nullable=True, unique=True)
    gender: Mapped[str] = mapped_column(String(1), default="M")  # M / F
    category: Mapped[str] = mapped_column(String(6), default="P100-")  # P25- .. P1000+ (constants.CATEGORIES)
    pref_kinds: Mapped[str] = mapped_column(String(40), default="individuel,duo,groupe")  # types de séance souhaités
    open_signup: Mapped[bool] = mapped_column(default=False)  # inscrit seul (lien public ou lien général d'un coach): l'administrateur confirme avant tout
    fav_coaches: Mapped[str] = mapped_column(String(120), default="")  # coachs favoris (ids séparés par des virgules), choisis d'office dans Réserver
    fav_clubs: Mapped[str] = mapped_column(Text, default="")  # clubs favoris (noms séparés par « | »)
    dominant_hand: Mapped[str] = mapped_column(String(10), default="droitier")
    side: Mapped[str] = mapped_column(String(10), default="drive")
    goals: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    vip: Mapped[bool] = mapped_column(default=False)  # dans la liste VIP de ce coach (fiche du coach): prix VIP
    terms_accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # conditions d'utilisation acceptées
    # Critères de l'araignée propres à ce joueur (liste JSON); None = ceux du coach
    criteria: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Moyen choisi par le joueur pour les rappels automatiques: whatsapp / sms / email (None = pas encore choisi)
    contact_channel: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Un joueur peut réserver chez plusieurs coachs: une fiche par coach, reliées au compte (fiche avec mot de passe).
    # account_id = id de la fiche « compte »; None pour le compte lui-même et pour les joueurs sans compte.
    account_id: Mapped[int | None] = mapped_column(ForeignKey("players.id"), nullable=True, index=True)
    # Vérification de l'e-mail du compte (DP-002)
    email_verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    email_token: Mapped[str | None] = mapped_column(String(48), nullable=True, unique=True)
    email_token_sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # Inscription par le lien du coach: l'administrateur la confirme (niveau réel, pas de doublon).
    # a_valider / validee / refusee; None = rien à confirmer (fiche sans compte, comptes antérieurs)
    signup_status: Mapped[str | None] = mapped_column(String(12), nullable=True)
    invited_category: Mapped[str | None] = mapped_column(String(6), nullable=True)  # niveau saisi par le coach
    signup_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class SkillRating(Base):
    """Historique des évaluations (araignée) par critère: value de 0 à 100 = note de 0 à 10 au dixième.
    score = ancienne note de 1 à 5 (données d'avant), recopiée dans value (×20) au démarrage."""

    __tablename__ = "skill_ratings"
    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    stroke: Mapped[str] = mapped_column(String(40))
    score: Mapped[int] = mapped_column(Integer, default=0)
    value: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Attendance(Base):
    __tablename__ = "attendances"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    # Retour du coach sur ce joueur pour cette séance
    worked_on: Mapped[str] = mapped_column(Text, default="")  # étiquettes séparées par des virgules
    note: Mapped[str] = mapped_column(Text, default="")
    to_improve: Mapped[str] = mapped_column(Text, default="")
    credit_paid_millimes: Mapped[int] = mapped_column(Integer, default=0)  # payé avec les crédits: rien à facturer
    accepted_kinds: Mapped[str] = mapped_column(String(40), default="")  # formules acceptées (séance formée par les joueurs, services/groups)
    refunded: Mapped[bool] = mapped_column(default=False)  # absent, remboursé par le coach: rien à payer
    accepted_opts: Mapped[str] = mapped_column(String(120), default="")  # formules et durées acceptées (« duo:60,duo:90 »)
    price_millimes: Mapped[int | None] = mapped_column(Integer, nullable=True)  # prix propre à ce joueur (VIP) dans une séance du coach


class Club(Base):
    __tablename__ = "clubs"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(20), default="")  # numéro qui reçoit les SMS de réservation
    sms_template: Mapped[str] = mapped_column(Text, default="")  # vide = modèle par défaut
    auto_send: Mapped[bool] = mapped_column(default=True)  # envoyer le SMS dès la création de la séance
    active: Mapped[bool] = mapped_column(default=True)  # le coach entraîne dans ce club (Réglages › Mes clubs)
    removed: Mapped[bool] = mapped_column(default=False)  # retiré de l'application par un administrateur (historique gardé)


class TrainingSession(Base):
    __tablename__ = "sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    start: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    duration_min: Mapped[int] = mapped_column(Integer, default=60)
    kind: Mapped[str] = mapped_column(String(10), default="individuel")  # individuel/duo/groupe
    level: Mapped[str] = mapped_column(String(20), default="")
    club: Mapped[str] = mapped_column(String(120), default="")
    club_id: Mapped[int | None] = mapped_column(ForeignKey("clubs.id"), nullable=True)
    court: Mapped[str] = mapped_column(String(60), default="")
    status: Mapped[str] = mapped_column(String(10), default="prevue")  # prevue/effectuee/annulee
    price_millimes: Mapped[int] = mapped_column(Integer, default=0)
    price_mode: Mapped[str] = mapped_column(String(10), default="par_joueur")  # par_joueur / groupe
    open: Mapped[bool] = mapped_column(default=False)  # places libres proposées aux autres joueurs
    recurrence_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    plan: Mapped[str | None] = mapped_column(Text, nullable=True)  # plan de séance enregistré (JSON), voir services/planner.py
    attendances: Mapped[list[Attendance]] = relationship(cascade="all, delete-orphan")


class CourtBooking(Base):
    """Demande de réservation de terrain envoyée par SMS à un club."""

    __tablename__ = "court_bookings"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("sessions.id"), nullable=True, index=True)  # None = terrain libre
    club_id: Mapped[int] = mapped_column(ForeignKey("clubs.id"))
    start: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    duration_min: Mapped[int] = mapped_column(Integer, default=60)
    court_label: Mapped[str] = mapped_column(String(60), default="")
    source: Mapped[str] = mapped_column(String(10), default="sms")  # sms / manuel
    series_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)  # terrain réservé à la main qui se répète
    status: Mapped[str] = mapped_column(String(12), default="a_envoyer")  # a_envoyer/en_attente/confirmee/refusee/annulee
    message: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    reply: Mapped[str] = mapped_column(Text, default="")
    replied_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    amount_millimes: Mapped[int] = mapped_column(Integer)
    method: Mapped[str] = mapped_column(String(10), default="especes")  # especes/virement
    kind: Mapped[str] = mapped_column(String(10), default="seance")  # seance / credit (recharge prépayée)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("sessions.id"), nullable=True)
    paid_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class CreditTx(Base):
    """Mouvements du solde de crédits d'un joueur (en millimes de TND)."""

    __tablename__ = "credit_tx"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    amount_millimes: Mapped[int] = mapped_column(Integer)  # + recharge / remboursement, - réservation
    reason: Mapped[str] = mapped_column(String(20))  # recharge / reservation / remboursement / ajustement
    booking_id: Mapped[int | None] = mapped_column(ForeignKey("bookings.id"), nullable=True)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("sessions.id"), nullable=True)  # séance payée en crédits (« seance »)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class TimeOff(Base):
    """Absence du coach (vacances, indisponibilité): aucun créneau n'est proposé aux joueurs ces jours-là."""

    __tablename__ = "time_off"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    start_date: Mapped[date] = mapped_column()  # jours de Tunis, inclus
    end_date: Mapped[date] = mapped_column()
    reason: Mapped[str] = mapped_column(String(120), default="")


class Availability(Base):
    """Plage hebdomadaire pendant laquelle le coach accepte des réservations."""

    __tablename__ = "availabilities"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    weekday: Mapped[int] = mapped_column(Integer)  # 0 = lundi
    start_time: Mapped[str] = mapped_column(String(5))  # HH:MM, heure de Tunis
    end_time: Mapped[str] = mapped_column(String(5))


class Booking(Base):
    """Réservation d'un joueur (payée avec ses crédits)."""

    __tablename__ = "bookings"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    kind: Mapped[str] = mapped_column(String(10), default="individuel")
    accepted_kinds: Mapped[str] = mapped_column(String(40), default="")  # formules acceptées par le joueur (affichées au coach)
    accepted_opts: Mapped[str] = mapped_column(String(120), default="")  # formules et durées acceptées (« duo:60,duo:90,groupe:90 »)
    start: Mapped[datetime] = mapped_column(UTCDateTime)
    duration_min: Mapped[int] = mapped_column(Integer, default=60)
    # en_attente (à traiter) / acceptee (terrain à confirmer) / confirmee / refusee / annulee
    status: Mapped[str] = mapped_column(String(24), default="en_attente")
    notified_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # joueur prévenu de la confirmation
    charged_millimes: Mapped[int] = mapped_column(Integer, default=0)  # débité des crédits (0 = à régler sur place)
    price_millimes: Mapped[int] = mapped_column(Integer, default=0)  # prix actuel (formule réellement jouée, remise comprise)
    discount_pct: Mapped[int] = mapped_column(Integer, default=0)
    discount_millimes: Mapped[int] = mapped_column(Integer, default=0)  # réduction en dinars (heures creuses / promotion)
    proposed_start: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # autre horaire proposé par le coach
    proposed_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Réservation en groupe montée par un joueur: group_id = réservation de l'organisateur (la sienne comprise),
    # group_token = lien d'invitation (sur celle de l'organisateur); statuts en_formation / invitation avant le coach
    group_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)  # annulée par le joueur (montré au coach)
    group_token: Mapped[str | None] = mapped_column(String(24), nullable=True, unique=True)
    replace_token: Mapped[str | None] = mapped_column(String(40), nullable=True, unique=True)  # lien « remplacez-moi » (après le délai d'annulation)  # remise obtenue à la réservation (happy hour / promotion)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("sessions.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class ReminderLog(Base):
    """Trace des relances ouvertes par le coach (pour ne pas relancer deux fois de suite)."""

    __tablename__ = "reminder_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # impaye / seance / invitation / credits
    channel: Mapped[str] = mapped_column(String(10))  # sms / whatsapp / email
    sent_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Proposal(Base):
    """Le coach propose à un joueur de rejoindre une séance déjà montée; le joueur accepte ou refuse."""

    __tablename__ = "proposals"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    status: Mapped[str] = mapped_column(String(10), default="proposee")  # proposee / acceptee / refusee
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class SessionReminder(Base):
    """Rappel automatique envoyé à un joueur avant sa séance (24 h et 2 h avant), une seule fois chacun."""

    __tablename__ = "session_reminders"
    __table_args__ = (UniqueConstraint("session_id", "player_id", "kind"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    kind: Mapped[str] = mapped_column(String(4))  # 24h / 2h
    channel: Mapped[str] = mapped_column(String(10))  # whatsapp / sms / email
    message: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Exercise(Base):
    """Exercice d'entraînement. coach_id None = proposé par l'application (non modifiable par le coach)."""

    __tablename__ = "exercises"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int | None] = mapped_column(ForeignKey("coaches.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    themes: Mapped[str] = mapped_column(String(255), default="")  # thèmes séparés par des virgules
    min_players: Mapped[int] = mapped_column(Integer, default=1)
    max_players: Mapped[int] = mapped_column(Integer, default=4)
    duration_min: Mapped[int] = mapped_column(Integer, default=15)


class HappyHour(Base):
    """Plage horaire hebdomadaire à prix réduit (nouvelles séances qui commencent dans la plage)."""

    __tablename__ = "happy_hours"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    weekday: Mapped[int] = mapped_column(Integer)  # 0 = lundi
    start_time: Mapped[str] = mapped_column(String(5))  # HH:MM, heure de Tunis
    end_time: Mapped[str] = mapped_column(String(5))
    discount_pct: Mapped[int] = mapped_column(Integer, default=0)  # ancien fonctionnement (en %)
    discount_millimes: Mapped[int] = mapped_column(Integer, default=0)  # heures creuses: réduction en dinars par joueur


class Promotion(Base):
    """Promotion sur un terrain déjà réservé et encore libre; les joueurs du coach sont prévenus."""

    __tablename__ = "promotions"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    court_booking_id: Mapped[int] = mapped_column(ForeignKey("court_bookings.id"), index=True)
    discount_pct: Mapped[int] = mapped_column(Integer, default=0)  # ancien fonctionnement (en %)
    discount_millimes: Mapped[int] = mapped_column(Integer, default=0)  # réduction en dinars par joueur
    message: Mapped[str] = mapped_column(Text, default="")
    notified_count: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class PlayerEvent(Base):
    """Planning padel du joueur, en plus de ses entraînements: matchs amicaux et tournois. Après le match, il note
    son résultat et comment il a joué, et s'il a été coaché (par quel coach); ce coach peut ajouter son retour."""

    __tablename__ = "player_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)  # fiche compte du joueur
    kind: Mapped[str] = mapped_column(String(10), default="match")  # match (amical) / tournoi / autre (kiné, physique…: dans title)
    court_reserved: Mapped[bool] = mapped_column(default=False)  # le joueur a un terrain réservé pour ce match
    title: Mapped[str] = mapped_column(String(120), default="")
    start: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    duration_min: Mapped[int] = mapped_column(Integer, default=90)
    place: Mapped[str] = mapped_column(String(120), default="")
    result: Mapped[str] = mapped_column(String(10), default="")  # victoire / defaite / vide
    score: Mapped[str] = mapped_column(String(60), default="")
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)  # comment il a joué: 0-100 (= 0 à 10)
    comment: Mapped[str] = mapped_column(Text, default="")
    coach_id: Mapped[int | None] = mapped_column(ForeignKey("coaches.id"), nullable=True)  # coaché par
    coach_feedback: Mapped[str] = mapped_column(Text, default="")
    feedback_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class Notification(Base):
    """Notification dans l'appli du joueur (en plus de l'e-mail): message d'un coach (promotion, place libre,
    invitation, nouvel horaire proposé…) ou suivi d'une réservation. Rattachée à la fiche compte du joueur."""

    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    coach_id: Mapped[int | None] = mapped_column(ForeignKey("coaches.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(20), default="message")  # message / promo / invitation / contre_proposition / reservation
    title: Mapped[str] = mapped_column(String(160), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    booking_id: Mapped[int | None] = mapped_column(ForeignKey("bookings.id"), nullable=True)
    promotion_id: Mapped[int | None] = mapped_column(ForeignKey("promotions.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class CoachEvent(Base):
    """Autre chose qu'une séance sur le planning du coach (rendez-vous, tournoi, réunion…): bloque ce créneau
    (aucune séance ni réservation de joueur à ce moment-là)."""

    __tablename__ = "coach_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    title: Mapped[str] = mapped_column(String(120))
    start: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    duration_min: Mapped[int] = mapped_column(Integer, default=60)
    note: Mapped[str] = mapped_column(Text, default="")


class CourtExpense(Base):
    """Prix payé par le coach pour un terrain qu'il a réservé lui-même: déduit de ses revenus (Finance).
    Gardé à part du terrain (que les séances découpent ou réunissent): club, début et durée du terrain réservé."""

    __tablename__ = "court_expenses"
    id: Mapped[int] = mapped_column(primary_key=True)
    coach_id: Mapped[int] = mapped_column(ForeignKey("coaches.id"), index=True)
    club_id: Mapped[int] = mapped_column(ForeignKey("clubs.id"))
    start: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    duration_min: Mapped[int] = mapped_column(Integer, default=60)
    amount_millimes: Mapped[int] = mapped_column(Integer, default=0)
    series_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
