import { useEffect, useState } from "react";
import { api, peek } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import { Loading } from "./ui.jsx";

// Critères de l'araignée: ceux du coach (Réglages, url « /criteria ») ou ceux d'un joueur (sa fiche,
// url « /players/<id>/criteria »). Garder, renommer, retirer ou ajouter (3 à 12); « reset » revient aux critères
// par défaut (standards pour le coach, ceux du coach pour un joueur). Les notes déjà données restent.
export default function CriteriaEditor({ url, intro, reset, onSaved }) {
  const [c, setC] = useState(() => peek(url) ?? null);
  const [names, setNames] = useState(() => peek(url)?.names ?? []);
  const [fresh, setFresh] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => { api(url).then((r) => { setC(r); setNames(r.names); }).catch(() => {}); }, [url]);
  if (!c) return <Loading rows={1} />;
  const edit = (next) => { setNames(next); setDirty(true); };
  const add = () => { const n = fresh.trim(); if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) edit([...names, n]); setFresh(""); };
  const save = (list) => api(url, { method: "PUT", body: { names: list } })
    .then((r) => { setC(r); setNames(r.names); setDirty(false); toast(list.length ? "Critères enregistrés" : "Critères par défaut rétablis"); onSaved?.(); }).catch(toastError);
  return (
    <div className="card">
      <div className="mut small-p" style={{ marginBottom: 8 }}>{intro}</div>
      {names.map((n, i) => (
        <div className="crit-row" key={i}>
          <input aria-label={`Critère ${i + 1}`} value={n} maxLength={40} onChange={(e) => edit(names.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" className="small sec iconbtn" aria-label={`Retirer ${n}`} disabled={names.length <= 3} onClick={() => edit(names.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      {names.length < 12 && (
        <div className="crit-row">
          <input placeholder="Nouveau critère (ex. Mental, Déplacements…)" aria-label="Nouveau critère" value={fresh} maxLength={40}
            onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button type="button" className="small sec iconbtn" aria-label="Ajouter le critère" disabled={!fresh.trim()} onClick={add}><Icon name="plus" size={14} /></button>
        </div>
      )}
      <div className="actions">
        {c.custom && <button type="button" className="sec" onClick={() => save([])}>{reset}</button>}
        <button type="button" disabled={!dirty} onClick={() => save(names.map((x) => x.trim()).filter(Boolean))}>{dirty ? "Enregistrer les critères" : "Enregistré"}</button>
      </div>
    </div>
  );
}
