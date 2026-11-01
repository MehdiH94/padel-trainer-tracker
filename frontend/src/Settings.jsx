import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import { KIND, Loading } from "./ui.jsx";

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

export default function Settings({ onBack }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [themes, setThemes] = useState([]);
  useEffect(() => { api("/booking/settings").then(setS); api("/exercise-themes").then((t) => setThemes(t.work)); }, []);
  if (!s) return <><h1>Réglages</h1><Loading rows={3} /></>;

  const dayWindows = (d) => s.availability.filter((w) => w.weekday === d);
  const setDay = (d, windows) => setS({ ...s, availability: [...s.availability.filter((w) => w.weekday !== d), ...windows.map((w) => ({ ...w, weekday: d }))] });
  async function save() {
    try {
      await api("/booking/settings", { method: "PUT", body: s });
    } catch (x) {
      return toastError(x);
    }
    toast("Réglages enregistrés");
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  return (
    <>
      <button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button>
      <h1 style={{ marginTop: 10 }}>Réglages de réservation</h1>
      <p className="mut" style={{ marginTop: -6 }}>Ce que vos joueurs voient dans leur application : créneaux, prix, politique d'annulation.</p>

      <h2>Ma page publique</h2>
      <div className="card">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Ce que les joueurs voient quand ils cherchent un coach.</div>
        <label className="field"><span className="mut">Présentation</span>
          <textarea className="msg" rows={4} value={s.bio} onChange={(e) => setS({ ...s, bio: e.target.value })} placeholder="Votre parcours, votre façon d'entraîner, les niveaux que vous accompagnez…" />
        </label>
        <div className="field"><span className="mut">Spécialités</span>
          <div className="chips">
            {themes.map((t) => {
              const on = s.specialties.includes(t);
              return <button type="button" key={t} className={"chip small" + (on ? " on" : "")} aria-pressed={on} onClick={() => setS({ ...s, specialties: on ? s.specialties.filter((x) => x !== t) : [...s.specialties, t] })}>{t}</button>;
            })}
          </div>
        </div>
      </div>

      <h2>Prix par joueur</h2>
      <div className="card">
        {Object.entries(KIND).map(([k, v]) => (
          <label className="field price-row" key={k}>
            <span><Icon name={v.icon} size={16} /> <b>{v.label}</b> <span className="mut">· {v.short}</span></span>
            <span className="inputunit"><input type="number" step="0.001" min="0" value={s["price_" + k] / 1000} onChange={(e) => setS({ ...s, ["price_" + k]: Math.round(e.target.value * 1000) })} /><em>TND</em></span>
          </label>
        ))}
      </div>

      <h2>Validation et annulation</h2>
      <div className="card">
        <label className="check">
          <input type="checkbox" checked={s.auto_confirm} onChange={(e) => setS({ ...s, auto_confirm: e.target.checked })} />
          Accepter automatiquement quand un terrain est disponible
        </label>
        <div className="mut" style={{ marginTop: -4, marginBottom: 10 }}>
          {s.auto_confirm ? "Si un terrain que vous avez réservé couvre le créneau, la réservation est confirmée sans votre intervention." : "Vous validez chaque demande depuis l'onglet Demandes."}
        </div>
        <div className="grid">
          <label className="field"><span className="mut">Durée d'une séance</span>
            <select value={s.slot_minutes} onChange={(e) => setS({ ...s, slot_minutes: +e.target.value })}>
              {[45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
          <label className="field"><span className="mut">Annulation remboursée jusqu'à</span>
            <select value={s.cancel_hours} onChange={(e) => setS({ ...s, cancel_hours: +e.target.value })}>
              {[[0, "À tout moment"], [2, "2 h avant"], [12, "12 h avant"], [24, "24 h avant"], [48, "48 h avant"]].map(([h, l]) => <option key={h} value={h}>{l}</option>)}
            </select>
          </label>
        </div>
        <div className="mut">Après ce délai, la séance est due : les crédits ne sont pas rendus.</div>
      </div>

      <h2>Disponibilités</h2>
      <div className="card">
        {DAYS.map((name, d) => {
          const ws = dayWindows(d);
          return (
            <div key={d} style={{ padding: "6px 0", borderTop: d ? "1px solid var(--line)" : "none" }}>
              <div className="row">
                <label className="check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ws.length > 0} onChange={(e) => setDay(d, e.target.checked ? [{ start_time: "09:00", end_time: "13:00" }, { start_time: "15:00", end_time: "21:00" }] : [])} />
                  {name}
                </label>
                {ws.length === 0 && <span className="mut">Fermé</span>}
              </div>
              {ws.map((w, i) => (
                <div className="row" key={i} style={{ gap: 6, marginTop: 4 }}>
                  <input style={{ margin: 0 }} type="time" value={w.start_time} onChange={(e) => setDay(d, ws.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)))} />
                  <Icon name="arrowR" size={16} />
                  <input style={{ margin: 0 }} type="time" value={w.end_time} onChange={(e) => setDay(d, ws.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)))} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <button style={{ width: "100%" }} onClick={save}>{saved ? "Enregistré" : "Enregistrer les réglages"}</button>
    </>
  );
}
