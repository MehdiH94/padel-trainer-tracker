import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { Modal, toast, toastError } from "./feedback.jsx";
import { Avatar, CategoryBadge } from "./ui.jsx";

// Le coach prévient ses joueurs qu'il reste de la place: joueurs déjà entraînés chez lui, de niveau compatible,
// tous cochés au départ (il décoche ceux qu'il veut exclure). Chacun reçoit un message et une proposition dans son appli.
// Avec courtId: annonce d'un terrain libre à ses joueurs (ceux qui ont un compte cochés au départ).
export default function InvitePlayers({ sessionId, courtId, onClose, onDone }) {
  const list = courtId ? `/court-bookings/${courtId}/announce` : `/sessions/${sessionId}/invitable`;
  const sendTo = courtId ? `/court-bookings/${courtId}/announce` : `/sessions/${sessionId}/invite`;
  const [data, setData] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(list).then((d) => { setData(d); setChosen(d.players.filter((p) => !courtId || p.has_account).map((p) => p.id)); setMessage(d.message); }).catch(toastError);
  }, [list]);
  const toggle = (id) => setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api(sendTo, { method: "POST", body: { player_ids: chosen, message } });
      toast(`${r.sent} joueur${r.sent > 1 ? "s" : ""} prévenu${r.sent > 1 ? "s" : ""}`);
      onDone?.();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={courtId ? "Annoncer ce créneau" : "Compléter la séance"}>
      <div className="row"><b className="sheet-title">{courtId ? "Annoncer ce créneau libre" : "Compléter la séance"}</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      {!data ? <div className="skel" style={{ height: 120 }} /> : (
        <>
          {courtId
            ? <p className="mut small-p">Choisissez les joueurs à prévenir de ce créneau libre. Ils reçoivent un e-mail et réservent dans l'application.</p>
            : <p className="mut small-p">{data.spots_left} place{data.spots_left > 1 ? "s" : ""} libre{data.spots_left > 1 ? "s" : ""}. Joueurs déjà entraînés chez vous, de niveau compatible : décochez ceux que vous ne voulez pas prévenir.</p>}
          {data.players.length === 0 && <div className="card mut">{courtId ? "Vous n'avez pas encore de joueurs." : "Aucun joueur compatible ne s'est encore entraîné avec vous."}</div>}
          {data.players.length > 0 && (
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="mut small-p">{chosen.length}/{data.players.length} sélectionné{chosen.length > 1 ? "s" : ""}</span>
              <button className="link" onClick={() => setChosen(chosen.length ? [] : data.players.map((p) => p.id))}>{chosen.length ? "Tout décocher" : "Tout cocher"}</button>
            </div>
          )}
          <div className="searchlist">
            {data.players.map((p) => (
              <label key={p.id} className="searchrow pick">
                <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
                <Avatar name={p.name} size={30} />
                <span>{p.name}<small>{p.has_account ? "par e-mail" : "sans compte : pas d'e-mail"}</small></span>
                <CategoryBadge category={p.category} />
              </label>
            ))}
          </div>
          <label className="field" style={{ marginTop: 8 }}><span className="mut">Message</span><textarea className="msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
          <div className="actions"><button className="sec" onClick={onClose}>Annuler</button><button disabled={busy || !chosen.length} onClick={send}><Icon name="send" size={15} /> Prévenir {chosen.length} joueur{chosen.length > 1 ? "s" : ""}</button></div>
        </>
      )}
    </Modal>
  );
}
