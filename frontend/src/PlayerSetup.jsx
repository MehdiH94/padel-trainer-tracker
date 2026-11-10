import { useState } from "react";

// Questions posées au joueur à l'inscription (comme un coach au premier entraînement): main forte, côté de jeu
// et objectifs. Les objectifs choisis deviennent « Mon objectif » sur sa fiche (vue par ses coachs) et dans l'appli.
export const GOALS = [
  "Me faire plaisir et me défouler",
  "Découvrir le padel et apprendre les bases",
  "Rester en forme, faire du sport régulièrement",
  "Améliorer ma technique (coups, placement)",
  "Jouer des matchs entre amis avec un bon niveau",
  "Rencontrer des partenaires de jeu",
  "Avoir un niveau correct pour commencer les tournois",
  "Jouer des tournois régulièrement",
  "Gagner un tableau en tournoi",
  "Monter de classement",
  "Revenir au padel après une pause ou une blessure",
];
export const TABLEAUX = ["P25", "P50", "P100", "P250", "P500", "P1000"];
const WIN = "Gagner un tableau en tournoi";

export const SIDES = { drive: "Drive", revers: "Revers", deux: "Les deux" }; // drive = côté droit, revers = côté gauche

// Texte enregistré: « Améliorer ma technique · Gagner un tableau P250 · Autre précision »
export function goalsText(sel, tableau, other) {
  return [...sel.map((g) => (g === WIN && tableau ? `Gagner un tableau ${tableau}` : g)), other.trim()].filter(Boolean).join(" · ");
}

export function ProfileQuestions({ f, setF }) {
  const [sel, setSel] = useState([]);
  const [tableau, setTableau] = useState("");
  const [other, setOther] = useState("");
  const update = (s, t, o) => { setSel(s); setTableau(t); setOther(o); setF((x) => ({ ...x, goals: goalsText(s, t, o) })); };
  const toggle = (g) => update(sel.includes(g) ? sel.filter((x) => x !== g) : [...sel, g], tableau, other);
  const pick = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <>
      <div className="field"><span className="mut">Vous êtes…</span>
        <div className="seg-choice" role="group" aria-label="Main forte">
          {[["droitier", "Droitier"], ["gaucher", "Gaucher"]].map(([k, l]) => <button key={k} type="button" className={f.dominant_hand === k ? "on" : ""} aria-pressed={f.dominant_hand === k} onClick={() => pick("dominant_hand", k)}>{l}</button>)}
        </div>
      </div>
      <div className="field"><span className="mut">Votre côté sur le terrain</span>
        <div className="seg-choice" role="group" aria-label="Côté de jeu">
          {Object.entries(SIDES).map(([k, l]) => <button key={k} type="button" className={f.side === k ? "on" : ""} aria-pressed={f.side === k} onClick={() => pick("side", k)}>{l}</button>)}
        </div>
      </div>
      <div className="field"><span className="mut">Qu'est-ce que vous voulez réaliser en jouant au padel ? (plusieurs choix possibles)</span>
        <div className="chips goals" role="group" aria-label="Mes objectifs">
          {GOALS.map((g) => <button key={g} type="button" className={"chip small" + (sel.includes(g) ? " on" : "")} aria-pressed={sel.includes(g)} onClick={() => toggle(g)}>{g}</button>)}
        </div>
        {sel.includes(WIN) && (
          <label className="field" style={{ marginTop: 6 }}><span className="mut">Quel tableau ?</span>
            <select aria-label="Tableau visé" value={tableau} onChange={(e) => update(sel, e.target.value, other)}>
              <option value="">Je ne sais pas encore</option>
              {TABLEAUX.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        )}
        <input placeholder="Autre objectif (facultatif)" aria-label="Autre objectif" value={other} onChange={(e) => update(sel, tableau, e.target.value)} style={{ marginTop: 6 }} />
      </div>
    </>
  );
}
