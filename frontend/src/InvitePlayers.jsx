import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { Modal, toast, toastError } from "./feedback.jsx";
import { Avatar, CategoryBadge } from "./ui.jsx";

// Le coach prévient ses joueurs qu'il reste de la place: joueurs déjà entraînés chez lui, de niveau compatible,
// tous cochés au départ (il décoche ceux qu'il veut exclure). Chacun reçoit un message et une proposition dans son appli.
export default function InvitePlayers({ sessionId, onClose, onDone }) {
  const [data, setData] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/sessions/${sessionId}/invitable`).then((d) => { setData(d); setChosen(d.players.map((p) => p.id)); setMessage(d.message); }).catch(toastError);
  }, [sessionId]);
  const toggle = (id) => setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api(`/sessions/${sessionId}/invite`, { method: "POST", body: { player_ids: chosen, message } });
      toast(`${r.sent} joueur${r.sent > 1 ? "s" : ""} prévenu${r.sent > 1 ? "s" : ""}`);
      onDone?.();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Notifier mes joueurs">
      <div className="row"><b className="sheet-title">Notifier mes joueurs</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      {!data ? <div className="skel" style={{ height: 120 }} /> : (
        <>
          <p className="mut small-p">{data.spots_left} place{data.spots_left > 1 ? "s" : ""} libre{data.spots_left > 1 ? "s" : ""}. Joueurs déjà entraînés chez vous, de niveau compatible : décochez ceux que vous ne voulez pas prévenir.</p>
          {data.players.length === 0 && <div className="card mut">Aucun joueur compatible ne s'est encore entraîné avec vous.</div>}
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
