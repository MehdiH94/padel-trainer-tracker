import { useState } from "react";
import { api } from "./api.js";

const EXTRA_TAGS = ["Placement", "Jeu au filet", "Stratégie", "Physique", "Jeu en double"];

// Retour du coach sur un joueur pour une séance: thèmes travaillés, note, point à améliorer.
export default function FeedbackEditor({ h, playerId, strokes, onSaved }) {
  const [tags, setTags] = useState(h.worked_on);
  const [note, setNote] = useState(h.note);
  const [imp, setImp] = useState(h.to_improve);
  const all = [...strokes, ...EXTRA_TAGS];
  const toggle = (t) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  const save = async () => {
    await api(`/sessions/${h.session_id}/feedback/${playerId}`, { method: "PUT", body: { worked_on: tags, note, to_improve: imp } });
    onSaved();
  };
  return (
    <div className="editor" onClick={(e) => e.stopPropagation()}>
      <div className="mut">Travaillé pendant la séance</div>
      <div className="chips">
        {all.map((t) => <button type="button" key={t} className={"chip small" + (tags.includes(t) ? " on" : "")} onClick={() => toggle(t)}>{t}</button>)}
      </div>
      <label className="field"><span className="mut">Note du coach</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Comment s'est passée la séance ?" /></label>
      <label className="field"><span className="mut">À améliorer</span><input value={imp} onChange={(e) => setImp(e.target.value)} placeholder="Point à retravailler" /></label>
      <button style={{ width: "100%" }} onClick={save}>Enregistrer</button>
    </div>
  );
}
