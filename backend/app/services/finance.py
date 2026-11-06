from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Attendance, Booking, CreditTx, Payment, TrainingSession


def share(s: TrainingSession, index: int) -> int:
    """Part due par le joueur n°index (0-based) d'une séance, en millimes."""
    if s.attendances[index].credit_paid_millimes > 0 or s.attendances[index].refunded:  # payé en crédits, ou absent remboursé
        return 0
    if s.price_mode == "groupe":
        n = len(s.attendances) or 1
        # prix total partagé; le reste de la division va aux premiers joueurs
        return s.price_millimes // n + (1 if index < s.price_millimes % n else 0)
    return s.price_millimes


def billed_by_player(sessions: list[TrainingSession]) -> dict[int, int]:
    """Montant facturé par joueur (séances effectuées, hors séances prépayées)."""
    out: dict[int, int] = {}
    for s in sessions:
        if s.status != "effectuee":
            continue
        for i, a in enumerate(s.attendances):
            out[a.player_id] = out.get(a.player_id, 0) + share(s, i)
    return out


def paid_by_player(db: Session, coach_id: int) -> dict[int, int]:
    """Paiements de séances. Les recharges de crédits sont exclues: elles servent aux réservations."""
    out: dict[int, int] = {}
    for p in db.scalars(select(Payment).where(Payment.coach_id == coach_id, Payment.kind == "seance")):
        out[p.player_id] = out.get(p.player_id, 0) + p.amount_millimes
    return out


def credit_balance(db: Session, player_id: int) -> int:
    return db.scalar(select(func.coalesce(func.sum(CreditTx.amount_millimes), 0)).where(CreditTx.player_id == player_id))


def debts(db: Session, coach_id: int) -> dict[int, int]:
    """Soldes de crédits négatifs (séances validées au-delà de ce qui a été prépayé): ce que le joueur doit au coach.
    Ces séances sont marquées payées en crédits, elles ne comptent donc pas aussi dans billed_by_player."""
    rows = db.execute(select(CreditTx.player_id, func.sum(CreditTx.amount_millimes)).where(CreditTx.coach_id == coach_id).group_by(CreditTx.player_id))
    return {pid: -total for pid, total in rows if total < 0}


def amounts_due(db: Session, coach_id: int, sessions: list[TrainingSession]) -> dict[int, int]:
    """Total dû par joueur: séances facturées non réglées + solde de crédits négatif."""
    billed, paid = billed_by_player(sessions), paid_by_player(db, coach_id)
    out = {pid: amt - paid.get(pid, 0) for pid, amt in billed.items() if amt - paid.get(pid, 0) > 0}
    for pid, debt in debts(db, coach_id).items():
        out[pid] = out.get(pid, 0) + debt
    return out


def session_payments(db: Session, coach_id: int) -> dict[tuple[int, int], int]:
    """Montant réglé par (séance, joueur). Un paiement rattaché à une séance compte pour elle; un paiement
    saisi sans séance (depuis la fiche joueur) couvre les plus anciennes séances effectuées encore dues."""
    out: dict[tuple[int, int], int] = {}
    loose: dict[int, int] = {}  # paiements sans séance, par joueur
    for p in db.scalars(select(Payment).where(Payment.coach_id == coach_id, Payment.kind == "seance")):
        if p.session_id is None:
            loose[p.player_id] = loose.get(p.player_id, 0) + p.amount_millimes
        else:
            out[(p.session_id, p.player_id)] = out.get((p.session_id, p.player_id), 0) + p.amount_millimes
    if loose:
        q = select(TrainingSession).where(TrainingSession.coach_id == coach_id, TrainingSession.status == "effectuee")
        for s in db.scalars(q.order_by(TrainingSession.start)):
            for i, a in enumerate(s.attendances):
                left = share(s, i) - out.get((s.id, a.player_id), 0)
                use = min(left, loose.get(a.player_id, 0))
                if use > 0:
                    out[(s.id, a.player_id)] = out.get((s.id, a.player_id), 0) + use
                    loose[a.player_id] -= use
    return out


def unpaid_sessions(db: Session, p) -> int:
    """Séances effectuées de ce joueur (fiche chez un coach) qui restent à régler."""
    q = select(TrainingSession).join(Attendance).where(
        TrainingSession.coach_id == p.coach_id, TrainingSession.status == "effectuee", Attendance.player_id == p.id)
    billed = billed_by_player(list(db.scalars(q).unique())).get(p.id, 0)
    paid = db.scalar(select(func.coalesce(func.sum(Payment.amount_millimes), 0)).where(
        Payment.coach_id == p.coach_id, Payment.player_id == p.id, Payment.kind == "seance"))
    return max(billed - paid, 0)


def net_balance(db: Session, p) -> int:
    """Solde unique du joueur chez ce coach: positif = crédits restants, négatif = impayé."""
    return credit_balance(db, p.id) - unpaid_sessions(db, p)


def settle(db: Session, coach_id: int, player_ids) -> None:
    """Les crédits paient automatiquement les séances effectuées encore dues (les plus anciennes d'abord).
    Tant que le solde est positif, la séance entière est payée en crédits, quitte à passer dans le rouge
    (dette comptée dans les impayés): le joueur a soit un solde, soit un impayé, jamais les deux."""
    bal = {pid: credit_balance(db, pid) for pid in set(player_ids)}
    if not any(v > 0 for v in bal.values()):
        return
    paid = session_payments(db, coach_id)
    q = select(TrainingSession).where(TrainingSession.coach_id == coach_id, TrainingSession.status == "effectuee")
    for s in db.scalars(q.order_by(TrainingSession.start)):
        for i, a in enumerate(s.attendances):
            if bal.get(a.player_id, 0) <= 0 or paid.get((s.id, a.player_id), 0) > 0:
                continue
            due = share(s, i)
            if due <= 0:
                continue
            db.add(CreditTx(coach_id=coach_id, player_id=a.player_id, amount_millimes=-due, reason="seance", session_id=s.id))
            a.credit_paid_millimes = due
            bal[a.player_id] -= due
    db.flush()


def _credit_part(db: Session, s: TrainingSession, a: Attendance, mark: bool = False) -> int:
    """Crédits débités pour cette séance (débits à la validation, séance payée en crédits, ajustements de prix).
    mark: ces débits sont marqués pour ne pas être rendus une seconde fois (unsettle)."""
    amount = 0
    for t in db.scalars(select(CreditTx).where(CreditTx.player_id == a.player_id, CreditTx.reason.in_(("seance", "reservation", "ajustement")))):
        b = db.get(Booking, t.booking_id) if t.booking_id else None
        if t.session_id == s.id or (b and b.session_id == s.id):
            amount -= t.amount_millimes
            if mark:
                t.reason = {"seance": "seance_annulee"}.get(t.reason, t.reason)
    return amount


def refund_absent(db: Session, s: TrainingSession, a: Attendance) -> int:
    """Joueur absent d'une séance effectuée: le coach le rembourse. Ce qu'il a payé pour elle (crédits débités,
    argent réglé pour cette séance) lui revient en crédits, toujours en entier (tout ou rien),
    et la séance ne lui est plus facturée. Rend le montant remboursé."""
    if a.refunded:
        return 0
    cash = session_payments(db, s.coach_id).get((s.id, a.player_id), 0)  # argent réglé pour la séance (rattaché ou non)
    amount = _credit_part(db, s, a, mark=True) + cash
    attached = 0
    for p in db.scalars(select(Payment).where(Payment.session_id == s.id, Payment.player_id == a.player_id, Payment.kind == "seance")):
        attached += p.amount_millimes
        p.kind = "credit"  # l'argent versé pour la séance devient des crédits
    loose = cash - attached  # versement sans séance qui couvrait celle-ci: il devient lui aussi des crédits
    if loose > 0:
        db.add(Payment(coach_id=s.coach_id, player_id=a.player_id, amount_millimes=-loose, kind="seance"))
        db.add(Payment(coach_id=s.coach_id, player_id=a.player_id, amount_millimes=loose, kind="credit"))
    a.refunded, a.credit_paid_millimes = True, 0
    amount = max(amount, 0)
    if amount > 0:
        db.add(CreditTx(coach_id=s.coach_id, player_id=a.player_id, amount_millimes=amount, reason="remboursement", session_id=s.id))
    db.flush()
    return amount


def unsettle(db: Session, s: TrainingSession) -> None:
    """Séance remise à « prévue »: les crédits débités pour elle sont rendus."""
    for t in db.scalars(select(CreditTx).where(CreditTx.session_id == s.id, CreditTx.reason == "seance")):
        db.add(CreditTx(coach_id=t.coach_id, player_id=t.player_id, amount_millimes=-t.amount_millimes, reason="remboursement", session_id=s.id))
        for a in s.attendances:
            if a.player_id == t.player_id:
                a.credit_paid_millimes = 0
        t.reason = "seance_annulee"  # déjà rendu: ne plus le rendre une seconde fois
