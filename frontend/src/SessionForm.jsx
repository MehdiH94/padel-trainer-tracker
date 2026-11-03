import { useEffect, useState } from "react";
import { api, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { CATEGORIES, catOption, KIND, DateSelect, TimeSelect } from "./ui.jsx";

const DURATIONS = [45, 60, 90, 120];

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="mut">{label}</span>
      {children}
    </label>
  );
}

export default function SessionForm({ players, onDone }) {
  const today = new Date().toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const [f, setF] = useState({
    date: today, time: "18:00", duration_min: 60, kind: "individuel", club_id: "", court_booked: false, court: "",
    discount_pct: 0, repeat: false, repeat_weeks: 4, player_ids: [], open: false, level: "",
  });
  const [err, setErr] = useState("");
  const [clubs, setClubs] = useState([]);
  const [prefs, setPrefs] = useState(null); // réglages du coach: prix et durée de chaque formule
  useEffect(() => {
    api("/clubs").then(setClubs);
    api("/booking/settings").then((st) => { setPrefs(st); setF((x) => ({ ...x, duration_min: st.slot_minutes || x.duration_min })); }).catch(() => {});
  }, []);
  const DUR = { individuel: "slot_minutes", duo: "duration_duo", groupe: "duration_groupe" };
  const base = prefs ? prefs["price_" + f.kind] : 0; // prix par joueur de la formule (Réglages)
  const price = Math.round(base * (100 - f.discount_pct) / 100);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const max = KIND[f.kind].cap;
  const club = clubs.find((c) => c.id === +f.club_id);

  function setKind(kind) {
    setF({ ...f, kind, player_ids: f.player_ids.slice(0, KIND[kind].cap), open: kind !== "individuel",
      duration_min: prefs?.[DUR[kind]] || f.duration_min }); // durée de la formule dans vos réglages
  }
  function togglePlayer(id) {
    if (max === 1) return setF({ ...f, player_ids: [id] });
    if (f.player_ids.includes(id)) return setF({ ...f, player_ids: f.player_ids.filter((x) => x !== id) });
    if (f.player_ids.length >= max) return;
    setF({ ...f, player_ids: [...f.player_ids, id] });
  }

  async function submit(e) {
    e.preventDefault();
    try {
      await api("/sessions", {
        method: "POST",
        body: {
          start: `${f.date}T${f.time}:00+01:00`, // Tunisie: UTC+1 toute l'année
          duration_min: f.duration_min, kind: f.kind, club_id: f.club_id ? +f.club_id : null, court_booked: !!f.club_id && f.court_booked,
          court: f.court, level: f.open ? f.level : "", open: f.open && f.kind !== "individuel",
          discount_pct: +f.discount_pct, // le prix vient des réglages (par joueur), moins la promotion
          repeat_weeks: f.repeat ? +f.repeat_weeks : 1, player_ids: f.player_ids,
        },
      });
      onDone();
    } catch (x) {
      setErr(x.message);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3 style={{ margin: "0 0 10px" }}>Nouvelle séance</h3>

      <Field label="Type de séance">
        <div className="seg">
          {Object.entries(KIND).map(([k, v]) => (
            <button type="button" key={k} className={f.kind === k ? "on" : ""} onClick={() => setKind(k)}>{v.label}</button>
          ))}
        </div>
      </Field>

      <div className="grid">
        <Field label="Date"><DateSelect label="Date" value={f.date} from={-60} to={180} onChange={(v) => setF({ ...f, date: v })} /></Field>
        <Field label="Heure de début"><TimeSelect label="Heure de début" value={f.time} onChange={(v) => setF({ ...f, time: v })} /></Field>
      </div>

      <Field label="Durée">
        <div className="seg">
          {DURATIONS.map((d) => (
            <button type="button" key={d} className={f.duration_min === d ? "on" : ""} onClick={() => setF({ ...f, duration_min: d })}>
              {d >= 60 ? `${Math.floor(d / 60)}h${d % 60 ? String(d % 60).padStart(2, "0") : ""}` : `${d} min`}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Club">
        <select value={f.club_id} onChange={set("club_id")}>
          <option value="">Aucun club</option>
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      {f.club_id && (
        <>
          <label className="check">
            <input type="checkbox" checked={f.court_booked} onChange={(e) => setF({ ...f, court_booked: e.target.checked })} />
            J'ai déjà réservé le terrain (aucun SMS au club)
          </label>
          {f.court_booked && <Field label="Terrain (facultatif)"><input placeholder="ex. Terrain 2" value={f.court} onChange={set("court")} /></Field>}
          {!f.court_booked && <div className="mut" style={{ margin: "-4px 0 10px" }}><Icon name="send" size={13} /> Un SMS de réservation sera envoyé au club{club?.phone ? "" : " (ce club n'a pas de numéro : ajoutez-le dans Terrains)"}.</div>}
        </>
      )}

      <Field label={`Joueurs (${f.player_ids.length}/${max})`}>
        <div className="chips">
          {players.map((p) => {
            const on = f.player_ids.includes(p.id);
            const full = !on && max > 1 && f.player_ids.length >= max;
            return <button type="button" key={p.id} className={"chip" + (on ? " on" : "")} disabled={full} onClick={() => togglePlayer(p.id)}>{p.name}</button>;
          })}
          {!players.length && <span className="mut">Ajoutez d'abord des joueurs.</span>}
        </div>
      </Field>

      {f.kind !== "individuel" && (
        <>
          <label className="check">
            <input type="checkbox" checked={f.open} onChange={(e) => setF({ ...f, open: e.target.checked })} />
            Ouvrir les places libres aux autres joueurs
          </label>
          {f.open && (
            <Field label="Niveau visé">
              <select value={f.level} onChange={set("level")}>
                <option value="">Tous niveaux</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}
              </select>
            </Field>
          )}
        </>
      )}

      <div className="pricebox">
        <div className="row">
          <span className="mut">Prix par joueur</span>
          <b>{prefs ? tnd(price) : "…"}{f.discount_pct > 0 && <s className="mut small-p" style={{ marginLeft: 6 }}>{tnd(base)}</s>}</b>
        </div>
        <div className="mut small-p">D'après vos réglages ({KIND[f.kind].label.toLowerCase()}). Pour le changer : Réglages › Formules.</div>
        {prefs && !base && <div className="err small-p">Vous n'avez pas encore fixé ce prix : Réglages › Formules.</div>}
        <Field label="Promotion (facultatif)">
          <select value={f.discount_pct} onChange={(e) => setF({ ...f, discount_pct: +e.target.value })}>
            <option value={0}>Aucune promotion</option>
            {[10, 15, 20, 25, 30, 40, 50].map((p) => <option key={p} value={p}>−{p} %</option>)}
          </select>
        </Field>
      </div>

      <label className="check">
        <input type="checkbox" checked={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.checked })} />
        Répéter chaque semaine
      </label>
      {f.repeat && <Field label="Nombre de semaines"><input type="number" min="2" max="52" value={f.repeat_weeks} onChange={set("repeat_weeks")} /></Field>}

      {err && <div className="err">{err}</div>}
      <button style={{ width: "100%" }}>Enregistrer la séance</button>
    </form>
  );
}
