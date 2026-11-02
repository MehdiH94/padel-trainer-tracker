import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import { KIND, Loading, TimeSelect } from "./ui.jsx";

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DUR = { individuel: "slot_minutes", duo: "duration_duo", groupe: "duration_groupe" }; // champ de durée par formule

export default function Settings({ onBack }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [themes, setThemes] = useState([]);
  const [cat, setCat] = useState(null); // clubs connus + les miens
  const [sel, setSel] = useState([]);
  const [newClubs, setNewClubs] = useState([]);
  const [nc, setNc] = useState({ name: "", phone: "" });
  const loadClubs = () => api("/clubs/catalog").then((c) => { setCat(c); setSel(c.mine); setNewClubs([]); });
  useEffect(() => { loadClubs(); }, []);
  const toggleClub = (n) => setSel(sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]);
  const addClub = () => {
    if (!nc.name.trim()) return;
    setNewClubs([...newClubs, { ...nc, name: nc.name.trim() }]);
    setNc({ name: "", phone: "" });
  };
  useEffect(() => { api("/booking/settings").then(setS); api("/exercise-themes").then((t) => setThemes(t.work)); }, []);
  if (!s) return <><h1>Réglages</h1><Loading rows={3} /></>;

  const setHappy = (i, patch) => setS({ ...s, happy_hours: s.happy_hours.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  const dayWindows = (d) => s.availability.filter((w) => w.weekday === d);
  const setDay = (d, windows) => setS({ ...s, availability: [...s.availability.filter((w) => w.weekday !== d), ...windows.map((w) => ({ ...w, weekday: d }))] });
  async function save() {
    try {
      await api("/booking/settings", { method: "PUT", body: s });
      if (cat) await api("/clubs/selection", { method: "PUT", body: { names: sel, new: newClubs } }).then(loadClubs);
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

      <h2>Mes clubs</h2>
      <div className="card">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Les clubs où vous entraînez : les joueurs vous trouvent en filtrant par club, et vos terrains y sont réservés.</div>
        {cat === null ? <div className="skel" style={{ height: 40 }} /> : (
          <div className="chips">
            {[...cat.mine, ...cat.known.map((k) => k.name)].map((n) => {
              const on = sel.includes(n);
              return <button type="button" key={n} className={"chip small" + (on ? " on" : "")} aria-pressed={on} onClick={() => toggleClub(n)}>{on && <Icon name="check" size={13} />} {n}</button>;
            })}
            {newClubs.map((c, i) => (
              <button type="button" key={"new" + i} className="chip small on" aria-label={`Retirer ${c.name}`} onClick={() => setNewClubs(newClubs.filter((_, j) => j !== i))}><Icon name="plus" size={13} /> {c.name}</button>
            ))}
          </div>
        )}
        <div className="newclub">
          <input placeholder="Autre club…" aria-label="Nom du club" value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addClub(); } }} />
          <input placeholder="Téléphone (facultatif)" aria-label="Téléphone du club" inputMode="tel" value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} />
          <button type="button" className="small sec" onClick={addClub}><Icon name="plus" size={15} /> Ajouter</button>
        </div>
        <div className="mut small-p" style={{ marginTop: 6 }}>Pensez à enregistrer en bas de la page.</div>
      </div>

      <h2>Formules : durée et prix par joueur</h2>
      <div className="card">
        {Object.entries(KIND).map(([k, v]) => (
          <div className="formula" key={k}>
            <span className="formula-name"><Icon name={v.icon} size={16} /> <b>{v.label}</b> <span className="mut">· {v.short}</span></span>
            <select aria-label={`Durée ${v.label}`} value={s[DUR[k]]} onChange={(e) => setS({ ...s, [DUR[k]]: +e.target.value })}>
              {[45, 60, 75, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
            <span className="inputunit"><input type="number" step="0.001" min="0" aria-label={`Prix ${v.label}`} value={s["price_" + k] / 1000} onChange={(e) => setS({ ...s, ["price_" + k]: Math.round(e.target.value * 1000) })} /><em>TND</em></span>
          </div>
        ))}
      </div>

      <h2>Happy hours</h2>
      <div className="card">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Remise automatique sur les nouvelles séances qui commencent dans ces plages (toutes formules).</div>
        {s.happy_hours.map((h, i) => (
          <div className="happy" key={i}>
            <select aria-label="Jour" value={h.weekday} onChange={(e) => setHappy(i, { weekday: +e.target.value })}>{DAYS.map((d, j) => <option key={j} value={j}>{d}</option>)}</select>
            <TimeSelect label="Début" value={h.start_time} onChange={(v) => setHappy(i, { start_time: v })} />
            <TimeSelect label="Fin" value={h.end_time} onChange={(v) => setHappy(i, { end_time: v })} />
            <span className="inputunit pct"><input type="number" min="1" max="90" aria-label="Remise" value={h.discount_pct} onChange={(e) => setHappy(i, { discount_pct: +e.target.value })} /><em>%</em></span>
            <button className="small sec iconbtn" aria-label="Supprimer la happy hour" onClick={() => setS({ ...s, happy_hours: s.happy_hours.filter((_, j) => j !== i) })}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {!s.happy_hours.length && <div className="mut">Aucune happy hour.</div>}
        <button className="small sec" style={{ marginTop: 8 }} onClick={() => setS({ ...s, happy_hours: [...s.happy_hours, { weekday: 0, start_time: "10:00", end_time: "12:00", discount_pct: 20 }] })}><Icon name="plus" size={15} /> Ajouter une happy hour</button>
      </div>

      <h2>Créneaux proposés aux joueurs</h2>
      <div className="card">
        {[["terrains", "Seulement sur mes terrains réservés", "Les joueurs ne voient que les heures où vous avez un terrain libre (Planning › Terrains). Recommandé : tout ce qui est réservé a un terrain."],
          ["disponibilites", "Sur toutes mes disponibilités", "Les joueurs voient toutes vos plages ci-dessous ; vous réservez le terrain après leur demande."]].map(([k, l, d]) => (
          <label key={k} className="check mode">
            <input type="radio" name="booking_mode" checked={(s.booking_mode ?? "terrains") === k} onChange={() => setS({ ...s, booking_mode: k })} />
            <span><b>{l}</b><span className="mut small-p" style={{ display: "block" }}>{d}</span></span>
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
        <div className="mut">Annulation par le joueur : jusqu'à 24 h avant pour une séance seul, 48 h avant à deux ou en groupe (crédits rendus). Après ce délai, il ne peut plus annuler mais peut envoyer un lien pour se faire remplacer.</div>
      </div>

      <h2>Disponibilités</h2>
      {(s.booking_mode ?? "terrains") === "terrains" && <p className="mut small-p" style={{ marginTop: -4 }}>En mode « terrains réservés », ce sont vos terrains qui fixent les créneaux proposés ; ces plages restent affichées sur votre page publique.</p>}
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
                  <TimeSelect label="Début" style={{ margin: 0 }} value={w.start_time} onChange={(v) => setDay(d, ws.map((x, j) => (j === i ? { ...x, start_time: v } : x)))} />
                  <Icon name="arrowR" size={16} />
                  <TimeSelect label="Fin" style={{ margin: 0 }} value={w.end_time} onChange={(v) => setDay(d, ws.map((x, j) => (j === i ? { ...x, end_time: v } : x)))} />
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
