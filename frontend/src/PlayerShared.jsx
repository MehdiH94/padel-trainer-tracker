import { useState } from "react";
import { api, dayLabel, hhmm, tnd, toDate } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { Avatar, KIND } from "./ui.jsx";

// Morceaux communs aux écrans du joueur (accueil, planning): carte d'une séance, annulation, remplacement
export const TZ = "Africa/Tunis";
export const REASONS = { recharge: "Recharge", reservation: "Réservation", remboursement: "Remboursement", ajustement: "Ajustement", seance: "Séance effectuée", seance_annulee: "Séance effectuée" };
export const STATUS_TXT = { en_attente: "En attente du coach", contre_proposition: "Le coach propose un autre horaire", attente_joueurs: "En attente d'autres joueurs", acceptee: "Terrain à confirmer", confirmee: "Confirmée" };
export const statusText = (s) => (s.status === "attente_joueurs" ? `En attente d'autres joueurs (${s.players_count}/${s.min_needed})` : STATUS_TXT[s.status] ?? "Confirmée");
export const HOW = { individuel: "Seul", duo: "À deux", groupe: "En groupe" };

// Groupe pas encore formé: le joueur peut passer à une autre formule (ex. seul) ou annuler (remboursé)
export function Reconsider({ s, reload }) {
  const [open, setOpen] = useState(false);
  const change = (kind) => api(`/me/bookings/${s.booking_id}/formula`, { method: "POST", body: { kind } })
    .then((r) => { toast(r.status === "confirmee" ? `Séance confirmée · ${tnd(r.price_millimes)}` : `Formule ajoutée · prix actuel ${tnd(r.price_millimes)}`); setOpen(false); reload(); })
    .catch(toastError);
  if (s.status !== "attente_joueurs") return null;
  return (
    <div className="reconsider-box">
      <div className="small-p">Pas encore assez de joueurs. Vous pouvez attendre, accepter une autre formule (ex. seul) ou annuler (remboursé). Le prix suit la formule réellement jouée.</div>
      {!open ? <button className="small sec" onClick={() => setOpen(true)}>Accepter une autre formule</button> : (
        <div className="chips">{Object.keys(HOW).filter((k) => !(s.accepted_kinds ?? []).includes(k)).map((k) => <button key={k} className="chip small" onClick={() => change(k)}>Accepter aussi : {HOW[k].toLowerCase()}</button>)}</div>
      )}
    </div>
  );
}
export const fmt = (iso, o) => toDate(iso).toLocaleDateString("fr-FR", { ...o, timeZone: TZ });

export function DateBlock({ iso }) {
  return (
    <div className="dateblock">
      <span>{fmt(iso, { weekday: "short" }).replace(".", "")}</span>
      <b>{fmt(iso, { day: "numeric" })}</b>
      <span>{fmt(iso, { month: "short" }).replace(".", "")}</span>
    </div>
  );
}

export function KindPill({ kind }) {
  const k = KIND[kind];
  return <span className="kind-pill" style={{ background: k.color + "1a", color: k.color }}><Icon name={k.icon} size={13} /> {k.label}</span>;
}

async function cancelBooking(b, reload) {
  const ok = await confirmDialog({
    title: "Annuler cette séance ?",
    message: b.status === "en_attente" ? "Votre demande sera retirée." : "Vos crédits vous seront remboursés.",
    confirm: "Annuler la séance", cancel: "Garder ma séance",
  });
  if (!ok) return;
  try {
    const r = await api(`/me/bookings/${b.booking_id}/cancel`, { method: "POST" });
    toast(r.refunded_millimes ? `Séance annulée · ${tnd(r.refunded_millimes)} remboursés` : "Séance annulée");
    reload();
  } catch (x) {
    toastError(x);
  }
}


// Annulation: jusqu'à 24 h avant (seul) ou 48 h avant (à deux, en groupe). Après, le bouton reste visible (autre couleur):
// un clic explique le délai et propose d'envoyer un lien pour qu'un autre joueur prenne sa place (ses crédits lui sont alors rendus).
export function CancelBox({ s, reload }) {
  const [url, setUrl] = useState(null);
  const [open, setOpen] = useState(false); // explication affichée seulement si le joueur clique sur « Annuler »
  if (!s.booking_id && !s.session_id) return null;
  // Séance montée par le coach: la réservation est créée au moment d'annuler ou de céder sa place
  const bookingId = async () => s.booking_id ?? (await api(`/me/sessions/${s.session_id}/booking`, { method: "POST" })).booking_id;
  const when = (iso) => `${dayLabel(iso)} à ${hhmm(iso)}`;
  if (s.can_cancel) {
    return (
      <div className="cancel-row">
        <button className="small sec" onClick={async () => { try { cancelBooking({ ...s, booking_id: await bookingId() }, reload); } catch (x) { toastError(x); } }}>Annuler</button>
        {s.cancel_until && <small className="mut">Annulable jusqu'au {when(s.cancel_until)}</small>}
      </div>
    );
  }
  const h = s.booking_kind === "individuel" ? 24 : 48;
  const get = () => bookingId().then((id) => api(`/me/bookings/${id}/replacement`, { method: "POST" })).then((r) => setUrl(location.origin + r.path)).catch(toastError);
  const msg = url && `Je ne peux plus venir à ma séance de padel du ${when(s.start)} avec ${s.coach_name}${s.club ? ` (${s.club})` : ""}. Tu veux prendre ma place ? ${url}`;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ text: msg });
      else { await navigator.clipboard.writeText(msg); toast("Message copié"); }
    } catch { /* partage annulé */ }
  };
  return (
    <div className="cancel-row">
      <button className="small sec late-btn" onClick={() => setOpen(true)}>Annuler</button>
      {open && (
        <Modal onClose={() => setOpen(false)} label="Annulation impossible">
          <div className="row"><b className="sheet-title">Trop tard pour annuler</b><button className="small sec iconbtn" aria-label="Fermer" onClick={() => setOpen(false)}><Icon name="x" size={15} /></button></div>
          <p className="small-p">Une séance {s.booking_kind === "individuel" ? "seul" : "à deux ou en groupe"} s'annule au plus tard {h} h avant son début.</p>
          <p className="small-p">Vous pouvez quand même vous faire remplacer : envoyez le lien de la séance à un ami. Dès qu'il prend votre place, vos crédits vous sont rendus.</p>
          {!url ? (
            <div className="actions" style={{ flexDirection: "column" }}>
              <button onClick={get}><Icon name="users" size={15} /> Me faire remplacer</button>
              <button className="sec" onClick={() => setOpen(false)}>Garder ma séance</button>
            </div>
          ) : (
            <div className="replace-share">
              <input readOnly value={url} aria-label="Lien de la séance" onFocus={(e) => e.target.select()} />
              <div className="actions">
                <a className="btnlink wa" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={15} /> WhatsApp</a>
                <button className="small sec" onClick={share}><Icon name="send" size={14} /> Partager</button>
                <button className="small sec" onClick={() => navigator.clipboard?.writeText(url).then(() => toast("Lien copié"))}><Icon name="copy" size={14} /> Copier</button>
              </div>
              <small className="mut">Vous serez prévenu dès que quelqu'un prend votre place.</small>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}


// Carte d'une séance à venir (date, formule, coach, statut, annulation)
export function SessionTicket({ s, reload }) {
  return (
    <div className="card ticket">
      <DateBlock iso={s.start} />
      <div style={{ flex: 1 }}>
        <div className="time">{hhmm(s.start)} <span className="mut">· {s.duration_min} min</span></div>
        <KindPill kind={s.kind} />
        <div className="mut" style={{ marginTop: 4 }}><Icon name="user" size={13} /> {s.coach_name}{s.club && <> · <Icon name="pin" size={13} /> {s.club}</>}</div>
        {s.partners?.length > 0 && <div className="partners">{s.partners.map((x) => <span key={x.name} className="partner"><Avatar name={x.name} size={20} /> {x.name.split(" ")[0]}</span>)}</div>}
        <div className={"status-line " + s.status}>{statusText(s)}</div>
        <Reconsider s={s} reload={reload} />
        <CancelBox s={s} reload={reload} />
      </div>
    </div>
  );
}
