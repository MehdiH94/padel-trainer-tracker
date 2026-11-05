import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import { SkillSliders } from "./ui.jsx";

const EXTRA_TAGS = ["Placement", "Jeu au filet", "Stratégie", "Physique", "Jeu en double"];

// Retour du coach sur un joueur pour une séance: thèmes travaillés, note, point à améliorer.
// rate: propose aussi de mettre à jour l'araignée du joueur (jauges de 0 à 10), en fin de séance.
export default function FeedbackEditor({ h, playerId, name, strokes, onSaved, rate }) {
  const [tags, setTags] = useState(h.worked_on);
  const [note, setNote] = useState(h.note);
  const [imp, setImp] = useState(h.to_improve);
  const [state, setState] = useState("idle"); // idle → saving → saved (le coach voit que son clic a été pris en compte)
  const [skills, setSkills] = useState(null);
  const [showRate, setShowRate] = useState(false);
  useEffect(() => {
    if (rate) api(`/players/${playerId}/profile`).then((p) => setSkills(p.skills)).catch(() => {});
  }, [rate, playerId]);
  const all = [...strokes, ...EXTRA_TAGS.filter((t) => !strokes.includes(t))];
  const touch = (fn) => (v) => { fn(v); if (state === "saved") setState("idle"); };
  const toggle = touch((t) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]));
  const save = async () => {
    setState("saving");
    try {
      await api(`/sessions/${h.session_id}/feedback/${playerId}`, { method: "PUT", body: { worked_on: tags, note, to_improve: imp } });
      setState("saved");
      toast(`Retour enregistré${name ? ` pour ${name.split(" ")[0]}` : ""}`);
      onSaved?.();
    } catch (x) {
      setState("idle");
      toastError(x);
    }
  };
  return (
    <div className="editor" onClick={(e) => e.stopPropagation()}>
      <div className="mut">Travaillé pendant la séance</div>
      <div className="chips">
        {all.map((t) => <button type="button" key={t} className={"chip small" + (tags.includes(t) ? " on" : "")} onClick={() => toggle(t)}>{t}</button>)}
      </div>
      <label className="field"><span className="mut">Note du coach</span><input value={note} onChange={(e) => touch(setNote)(e.target.value)} placeholder="Comment s'est passée la séance ?" /></label>
      <label className="field"><span className="mut">À améliorer</span><input value={imp} onChange={(e) => touch(setImp)(e.target.value)} placeholder="Point à retravailler" /></label>
      {rate && skills && (
        <div className="rate-box">
          <button type="button" className="row plain rate-toggle" aria-expanded={showRate} onClick={() => setShowRate(!showRate)}>
            <span><Icon name="activity" size={15} /> <b>Mettre à jour son araignée</b></span><Icon name={showRate ? "chevD" : "chevR"} size={16} />
          </button>
          {showRate && <SkillSliders playerId={playerId} skills={skills} />}
        </div>
      )}
      <button style={{ width: "100%" }} className={state === "saved" ? "saved" : ""} disabled={state === "saving"} onClick={save}>
        {state === "saved" ? <><Icon name="checkCircle" size={16} /> Enregistré</> : state === "saving" ? "Enregistrement…" : "Enregistrer"}
      </button>
    </div>
  );
}
