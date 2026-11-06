import { useState } from "react";
import { api, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, toast, toastError } from "./feedback.jsx";
import { PlayerTag } from "./ui.jsx";

// Reste à régler par un joueur pour une séance effectuée
export const leftToPay = (x) => Math.max(0, x.due_millimes - x.paid_millimes);

// Résumé court: « Tout réglé » ou « Reste 40,000 TND »
export function PaySummary({ s }) {
  if (!s.payments?.length) return null;
  const left = s.payments.reduce((a, x) => a + leftToPay(x), 0);
  return left > 0
    ? <span className="paytag ko">Reste {tnd(left)}</span>
    : <span className="paytag ok"><Icon name="check" size={12} /> Tout réglé</span>;
}

// Choix du joueur affiché (un seul à la fois): pastilles + « Joueur 2/3 » avec flèches
export function PlayerSwitch({ ids, cur, setCur, byId, name, mark }) {
  if (ids.length < 2) return null;
  const i = Math.max(0, ids.indexOf(cur));
  return (
    <div className="pswitch">
      <div className="pswitch-nav">
        <button className="small sec iconbtn" aria-label="Joueur précédent" disabled={i === 0} onClick={() => setCur(ids[i - 1])}><Icon name="chevL" size={16} /></button>
        <span>Joueur <b>{i + 1}</b> / {ids.length}</span>
        <button className="small sec iconbtn" aria-label="Joueur suivant" disabled={i === ids.length - 1} onClick={() => setCur(ids[i + 1])}><Icon name="chevR" size={16} /></button>
      </div>
      <div className="chips" role="tablist" aria-label="Joueurs de la séance">
        {ids.map((id) => (
          <button key={id} role="tab" aria-selected={id === cur} className={"chip small" + (id === cur ? " on" : "")} onClick={() => setCur(id)}>
            {byId?.(id) ? <PlayerTag p={byId(id)} first /> : name(id).split(" ")[0]}{mark?.(id) ? " •" : ""}
          </button>
        ))}
      </div>
    </div>
  );
}

// Séance effectuée: règlement d'UN joueur à la fois (playerId imposé par le panneau de la séance, sinon choix ici):
// ce qu'il a réglé, « Encaisser » le reste, ou « Absent ? Rembourser » (avec confirmation)
export default function SessionPayments({ s, name, byId, onPaid, playerId }) {
  const ids = s.payments.map((x) => x.player_id);
  const [own, setOwn] = useState(ids[0]);
  const cur = playerId ?? (ids.includes(own) ? own : ids[0]);
  const [form, setForm] = useState(null); // { amount, method }
  const [err, setErr] = useState("");
  const x = s.payments.find((p) => p.player_id === cur);
  if (!x) return null;
  const first = name(cur).split(" ")[0];
  const left = leftToPay(x);
  async function save(e) {
    e.preventDefault();
    try {
      await api("/payments", { method: "POST", body: { player_id: cur, session_id: s.id, amount_millimes: Math.round(Number(String(form.amount).replace(",", ".")) * 1000), method: form.method } });
      toast(`Paiement de ${first} enregistré`);
      setForm(null);
      setErr("");
      onPaid?.();
    } catch (y) {
      setErr(y.message);
    }
  }
  // Joueur absent: le coach peut le rembourser (ses crédits lui reviennent, la séance ne lui est plus facturée)
  const paid = x.credit_millimes + x.paid_millimes; // ce qu'il a payé pour la séance: rendu en entier (jamais une partie)
  async function refund() {
    const ok = await confirmDialog({
      title: paid > 0 ? `Êtes-vous sûr de vouloir rembourser ${tnd(paid)} à ${name(cur)} ?` : `Êtes-vous sûr de vouloir rembourser ${name(cur)} ?`,
      message: paid > 0 ? "Tout ce qu'il a payé pour cette séance revient sur ses crédits chez vous, et elle ne lui est plus facturée." : "Il n'a rien payé : la séance ne lui sera simplement plus facturée.",
      confirm: "Oui, rembourser", cancel: "Non", danger: true,
    });
    if (!ok) return;
    api(`/sessions/${s.id}/refund/${cur}`, { method: "POST" })
      .then(() => { toast(paid > 0 ? `${tnd(paid)} remboursés à ${first}` : `${first} : séance plus facturée`); onPaid?.(); })
      .catch(toastError);
  }
  return (
    <div className="paybox">
      {playerId == null && <PlayerSwitch ids={ids} cur={cur} setCur={(id) => { setOwn(id); setForm(null); }} byId={byId} name={name} mark={(id) => leftToPay(s.payments.find((p) => p.player_id === id)) > 0} />}
      <div className="paycard">
        <div className="paycard-head">
          <b>{byId?.(cur) ? <PlayerTag p={byId(cur)} /> : name(cur)}</b>
          {x.refunded ? <span className="paytag">Absent · remboursé</span>
            : x.credit_millimes > 0 ? <span className="paytag ok">Payé en crédits · {tnd(x.credit_millimes)}</span>
              : <span className={"paytag " + (left ? "ko" : "ok")}>Réglé {tnd(x.paid_millimes)} / {tnd(x.due_millimes)}</span>}
        </div>
        {!x.refunded && !form && (
          <div className="pay-actions">
            {left > 0 && <button className="small" onClick={() => setForm({ amount: (left / 1000).toFixed(3), method: "especes" })}><Icon name="wallet" size={15} /> Encaisser {tnd(left)}</button>}
            <button className="small sec" onClick={refund}><Icon name="x" size={15} /> Absent ? Rembourser{paid > 0 ? ` ${tnd(paid)}` : ""}</button>
          </div>
        )}
        {form && (
          <form className="payform" onSubmit={save}>
            <span className="inputunit"><input inputMode="decimal" aria-label="Montant encaissé" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /><em>TND</em></span>
            <select aria-label="Moyen de paiement" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}><option value="especes">Espèces</option><option value="virement">Virement</option></select>
            <div className="pay-actions">
              <button className="small">Enregistrer</button>
              <button type="button" className="small sec" onClick={() => setForm(null)}>Annuler</button>
            </div>
          </form>
        )}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
