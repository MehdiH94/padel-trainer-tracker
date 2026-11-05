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

// Séance effectuée: ce que chaque joueur a réglé, et encaissement du reste
export default function SessionPayments({ s, name, byId, onPaid }) {
  const [form, setForm] = useState(null); // { player_id, amount, method }
  const [err, setErr] = useState("");
  async function save(e) {
    e.preventDefault();
    try {
      await api("/payments", { method: "POST", body: { player_id: form.player_id, session_id: s.id, amount_millimes: Math.round(Number(String(form.amount).replace(",", ".")) * 1000), method: form.method } });
      toast(`Paiement de ${name(form.player_id).split(" ")[0]} enregistré`);
      setForm(null);
      setErr("");
      onPaid?.();
    } catch (x) {
      setErr(x.message);
    }
  }
  // Joueur absent: le coach peut le rembourser (ses crédits lui reviennent, la séance ne lui est plus facturée)
  async function refund(pid) {
    const first = name(pid).split(" ")[0];
    const ok = await confirmDialog({ title: `Rembourser ${first} ?`, message: `${first} n'est pas venu : ce qu'il a payé pour cette séance lui revient en crédits, et elle ne lui est plus facturée.`, confirm: "Rembourser", cancel: "Retour" });
    if (!ok) return;
    api(`/sessions/${s.id}/refund/${pid}`, { method: "POST" }).then(() => { toast(`${first} remboursé`); onPaid?.(); }).catch(toastError);
  }
  return (
    <div className="paylist">
      {s.payments.map((x) => {
        const left = leftToPay(x);
        return (
          <div key={x.player_id}>
            <div className="payrow">
              <b>{byId?.(x.player_id) ? <PlayerTag p={byId(x.player_id)} /> : name(x.player_id)}</b>
              {x.refunded ? (
                <span className="paytag">Absent · remboursé</span>
              ) : x.credit_millimes > 0 ? (
                <span className="paytag ok">Payé en crédits · {tnd(x.credit_millimes)}</span>
              ) : (
                <span className={"paytag " + (left ? "ko" : "ok")}>Réglé {tnd(x.paid_millimes)} / {tnd(x.due_millimes)}</span>
              )}
              {!x.refunded && <button className="small sec" onClick={() => refund(x.player_id)}>Absent ? Rembourser</button>}
              {left > 0 && form?.player_id !== x.player_id && (
                <button className="small sec" onClick={() => setForm({ player_id: x.player_id, amount: (left / 1000).toFixed(3), method: "especes" })}>Encaisser</button>
              )}
            </div>
            {form?.player_id === x.player_id && (
              <form className="payform" onSubmit={save}>
                <span className="inputunit"><input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /><em>TND</em></span>
                <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}><option value="especes">Espèces</option><option value="virement">Virement</option></select>
                <button className="small">OK</button>
                <button type="button" className="small sec iconbtn" aria-label="Annuler" onClick={() => setForm(null)}><Icon name="x" size={14} /></button>
              </form>
            )}
          </div>
        );
      })}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
