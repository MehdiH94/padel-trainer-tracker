import { useEffect, useRef, useState } from "react";
import { api, peek, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import CriteriaEditor from "./CriteriaEditor.jsx";
import { ClockPicker, KIND, Loading, MoneyInput } from "./ui.jsx";

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const HORIZONS = [[7, "1 semaine"], [14, "2 semaines"], [21, "3 semaines"], [30, "1 mois"], [60, "2 mois"], [90, "3 mois"]];
const FULL_DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

export default function Settings({ onBack, sub }) {
  const [s, setS] = useState(() => peek("/booking/settings") ?? null);
  const touched = useRef(false); // le coach a commencé à modifier: les réglages qui arrivent du serveur ne l'écrasent pas
  const [saved, setSaved] = useState(false);
  const [themes, setThemes] = useState(() => peek("/exercise-themes")?.work ?? []);
  const [cat, setCat] = useState(() => peek("/clubs/catalog") ?? null); // clubs connus + les miens
  const [sel, setSel] = useState(() => peek("/clubs/catalog")?.mine ?? []);
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
  useEffect(() => { api("/booking/settings").then((x) => setS((cur) => (cur && touched.current ? cur : x))); api("/exercise-themes").then((t) => setThemes(t.work)); }, []);
  // Ouvert depuis le guide « Bien démarrer » (#settings/formules…): on va directement à la bonne section, mise en valeur
  useEffect(() => {
    const el = s && sub && document.getElementById(sub);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); el.classList.add("focus-step"); }
  }, [Boolean(s), sub]);
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
    <div onInput={() => { touched.current = true; }} onClick={(e) => { if (e.target.closest("button, input, select")) touched.current = true; }}>
      <button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button>
      <h1 style={{ marginTop: 10 }}>Réglages de réservation</h1>
      <p className="mut" style={{ marginTop: -6 }}>Ce que vos joueurs voient dans leur application : créneaux, prix, politique d'annulation.</p>

      <h2 id="profil">Ma page publique</h2>
      <div className="card">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Ce que les joueurs voient quand ils cherchent un coach.</div>
        <label className="field"><span className="mut">Mon nom (affiché aux joueurs)</span><input value={s.name ?? ""} onChange={(e) => setS({ ...s, name: e.target.value })} /></label>
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

      <h2 id="clubs">Mes clubs</h2>
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

      <h2 id="formules">Formules : durées et prix par joueur</h2>
      <div className="card">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Pour chaque formule, cochez les durées que vos joueurs peuvent réserver et fixez le prix par joueur de chacune (pas forcément proportionnel : 1 h à 100 TND, 1 h 30 à 120 TND…). Une formule sans durée n'est pas proposée. Vos propres séances, vous les créez de la durée que vous voulez.</div>
        {Object.entries(KIND).map(([k, v]) => {
          const g = s.price_grid?.[k] ?? {};
          const setG = (next) => setS({ ...s, price_grid: { ...s.price_grid, [k]: next } });
          const toggle = (m) => {
            const { [m]: had, ...rest } = g;
            if (had !== undefined) return setG(rest);
            const ref = Object.entries(g)[0]; // prix de départ: au prorata d'une durée déjà fixée
            setG({ ...g, [m]: ref ? Math.round((ref[1] * +m) / +ref[0]) : 0 });
          };
          return (
            <div className="formula grid" key={k}>
              <span className="formula-name"><Icon name={v.icon} size={16} /> <b>{v.label}</b> <span className="mut">· {v.short}</span></span>
              <span className="chips" role="group" aria-label={`Durées ${v.label}`}>
                {["60", "90"].map((m) => <button key={m} type="button" className={"chip small" + (g[m] !== undefined ? " on" : "")} aria-pressed={g[m] !== undefined} onClick={() => toggle(m)}>{m === "60" ? "1 h" : "1 h 30"}</button>)}
              </span>
              {["60", "90"].filter((m) => g[m] !== undefined).map((m) => (
                <span key={m} className="inputunit"><em>{m === "60" ? "1 h" : "1 h 30"}</em><MoneyInput label={`Prix ${v.label} ${m === "60" ? "1 h" : "1 h 30"}`} value={g[m]} onChange={(x) => setG({ ...g, [m]: x })} /><em>TND</em></span>
              ))}
              {!Object.keys(g).length && <small className="mut">Pas proposé aux joueurs</small>}
            </div>
          );
        })}
      </div>

      <h2>Heures creuses</h2>
      <div className="card">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Réduction automatique, en dinars par joueur, sur les nouvelles séances qui commencent dans ces plages (toutes formules).</div>
        {s.happy_hours.map((h, i) => (
          <div className="happy" key={i}>
            <select aria-label="Jour" value={h.weekday} onChange={(e) => setHappy(i, { weekday: +e.target.value })}>{DAYS.map((d, j) => <option key={j} value={j}>{d}</option>)}</select>
            <ClockPicker label="Heures creuses · début" value={h.start_time} onChange={(v) => setHappy(i, { start_time: v })} />
            <ClockPicker label="Heures creuses · fin" value={h.end_time} onChange={(v) => setHappy(i, { end_time: v })} />
            <span className="inputunit"><em>−</em><MoneyInput label="Réduction par joueur" value={h.discount_millimes || 0} onChange={(m) => setHappy(i, { discount_millimes: m, discount_pct: 0 })} /><em>TND</em></span>
            <button className="small sec iconbtn" aria-label="Supprimer ces heures creuses" onClick={() => setS({ ...s, happy_hours: s.happy_hours.filter((_, j) => j !== i) })}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {!s.happy_hours.length && <div className="mut">Aucune heure creuse.</div>}
        <button className="small sec" style={{ marginTop: 8 }} onClick={() => setS({ ...s, happy_hours: [...s.happy_hours, { weekday: 0, start_time: "10:00", end_time: "12:00", discount_millimes: 10000 }] })}><Icon name="plus" size={15} /> Ajouter des heures creuses</button>
      </div>

      <h2 id="reservation">Créneaux proposés aux joueurs</h2>
      <div className="card">
        <div className="field"><span className="mut">Les joueurs réservent au plus</span>
          <div className="chips" role="group" aria-label="Limite de réservation à l'avance">
            {HORIZONS.map(([d, l]) => <button key={d} type="button" className={"chip small" + ((s.booking_horizon_days ?? 14) === d ? " on" : "")} aria-pressed={(s.booking_horizon_days ?? 14) === d} onClick={() => setS({ ...s, booking_horizon_days: d })}>{l}</button>)}
          </div>
          <small className="mut">à l'avance (jamais plus de 3 mois).</small>
        </div>
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
        <div className={"autoconfirm" + (s.auto_confirm ? " on" : "")}>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={s.auto_confirm} onChange={(e) => setS({ ...s, auto_confirm: e.target.checked })} />
            <b>Validation automatique des réservations</b>
          </label>
          {s.auto_confirm ? (
            <p className="small-p warn-txt" style={{ margin: "8px 0 0" }}>
              <Icon name="alert" size={14} /> Attention : un joueur pourra réserver directement, sans votre confirmation, dès qu'un de vos terrains réservés couvre le créneau. La séance s'ajoute alors à votre planning et le joueur reçoit sa confirmation.
            </p>
          ) : (
            <p className="mut small-p" style={{ margin: "8px 0 0" }}>Désactivée : chaque demande de réservation attend votre accord dans l'onglet Demandes (le joueur est prévenu dès que vous acceptez).</p>
          )}
        </div>
        <div style={{ height: 10 }} />
        <div className="mut">Annulation par le joueur : jusqu'à 24 h avant pour une séance seul, 48 h avant à deux ou en groupe (crédits rendus). Après ce délai, il ne peut plus annuler mais peut envoyer un lien pour se faire remplacer.</div>
      </div>

      <h2 id="disponibilites">Disponibilités</h2>
      <div className="card">
        <div className="mut small-p" style={{ marginBottom: 4 }}>Vos heures de travail, jour par jour (format 24 h). Touchez une heure pour la changer.</div>
        {DAYS.map((name, d) => {
          const ws = dayWindows(d);
          const pos = (t) => ((+t.slice(0, 2) + +t.slice(3, 5) / 60) / 24) * 100;
          return (
            <div key={d} className="dayrow">
              <div className="row">
                <label className="check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ws.length > 0} onChange={(e) => setDay(d, e.target.checked ? [{ start_time: "09:00", end_time: "13:00" }, { start_time: "15:00", end_time: "21:00" }] : [])} />
                  <b>{FULL_DAYS[d]}</b>
                </label>
                {ws.length === 0 ? <span className="mut small-p">Fermé</span>
                  : <button type="button" className="link small-p" onClick={() => setS({ ...s, availability: [0, 1, 2, 3, 4, 5, 6].flatMap((x) => ws.map((w) => ({ ...w, weekday: x }))) })}>Copier sur tous les jours</button>}
              </div>
              {ws.length > 0 && (
                <>
                  <div className="dayline" aria-hidden="true">{ws.map((w, i) => <i key={i} style={{ left: `${pos(w.start_time)}%`, width: `${Math.max(pos(w.end_time) - pos(w.start_time), 1)}%` }} />)}</div>
                  <div className="dayticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
                  {ws.map((w, i) => (
                    <div className="window" key={i}>
                      <ClockPicker label={`${FULL_DAYS[d]} · début`} value={w.start_time} onChange={(v) => setDay(d, ws.map((x, j) => (j === i ? { ...x, start_time: v } : x)))} />
                      <Icon name="arrowR" size={16} />
                      <ClockPicker label={`${FULL_DAYS[d]} · fin`} value={w.end_time} onChange={(v) => setDay(d, ws.map((x, j) => (j === i ? { ...x, end_time: v } : x)))} />
                      {w.start_time >= w.end_time && <span className="err small-p" style={{ margin: 0 }}>La fin doit être après le début</span>}
                      <button type="button" className="small sec iconbtn" aria-label="Retirer cette plage" onClick={() => setDay(d, ws.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
                    </div>
                  ))}
                  <button type="button" className="link small-p" style={{ marginTop: 6 }} onClick={() => setDay(d, [...ws, { start_time: "17:00", end_time: "21:00" }])}><Icon name="plus" size={13} /> Ajouter une plage</button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <button style={{ width: "100%" }} onClick={save}>{saved ? "Enregistré" : "Enregistrer les réglages"}</button>

      <h2 id="araignee">Araignée : critères d'évaluation</h2>
      <CriteriaEditor url="/criteria" intro="Ce que vous notez de 0 à 10 pour vos joueurs (3 à 12 critères). Chaque joueur peut aussi avoir les siens, depuis sa fiche." reset="Revenir aux standards" />
    </div>
  );
}
