import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { Modal, toast, toastError } from "./feedback.jsx";
import { Avatar, CategoryBadge, dinars } from "./ui.jsx";

// Séance incomplète: le coach écrit aux inscrits (« on n'arrive pas à être complet, partants quand même à deux ? »),
// avec une remise facultative sur la séance (crédits déjà débités: la différence est rendue).
export default function MessagePlayers({ sessionId, onClose, onDone }) {
  const url = `/sessions/${sessionId}/message`;
  const [data, setData] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [message, setMessage] = useState("");
  const [edited, setEdited] = useState(false);
  const [pct, setPct] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(url).then((d) => { setData(d); setChosen(d.players.map((p) => p.id)); setMessage(d.message); }).catch(toastError);
  }, [url]);
  const choosePct = (v) => {
    setPct(v);
    if (!edited) api(`${url}?discount_millimes=${v}`).then((d) => setMessage(d.message)).catch(() => {});
  };
  const toggle = (id) => setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api(url, { method: "POST", body: { player_ids: chosen, message, discount_millimes: pct } });
      toast(`Message envoyé à ${r.sent} joueur${r.sent > 1 ? "s" : ""}${pct ? ` · réduction de ${dinars(pct)} appliquée` : ""}`);
      onDone?.();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Écrire aux inscrits">
      <div className="row"><b className="sheet-title">Écrire aux inscrits</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      {!data ? <div className="skel" style={{ height: 120 }} /> : (
        <>
          <p className="mut small-p">La séance n'est pas complète{data.min_players > 1 ? ` (minimum voulu : ${data.min_players} joueurs)` : ""}. Demandez aux inscrits s'ils sont partants quand même, avec une remise si vous voulez. Ils peuvent changer de formule dans l'application.</p>
          <div className="searchlist">
            {data.players.map((p) => (
              <label key={p.id} className="searchrow pick">
                <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
                <Avatar name={p.name} size={30} />
                <span>{p.name}<small>{p.has_account ? "par e-mail" : "sans compte : pas d'e-mail"}</small></span>
                <CategoryBadge category={p.category} gender={p.gender} />
              </label>
            ))}
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <span className="mut">Réduction par joueur (facultatif)</span>
            <div className="seg mini">
              {[0, 5000, 10000, 20000].map((v) => <button type="button" key={v} className={pct === v ? "on" : ""} onClick={() => choosePct(v)}>{v ? `−${dinars(v)}` : "Aucune"}</button>)}
            </div>
          </div>
          <label className="field" style={{ marginTop: 8 }}><span className="mut">Message</span><textarea className="msg" rows={6} value={message} onChange={(e) => { setMessage(e.target.value); setEdited(true); }} /></label>
          <div className="actions"><button className="sec" onClick={onClose}>Annuler</button><button disabled={busy || !chosen.length} onClick={send}><Icon name="send" size={15} /> Envoyer</button></div>
        </>
      )}
    </Modal>
  );
}
