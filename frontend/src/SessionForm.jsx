import { useEffect, useState } from "react";
import { api } from "./api.js";
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
    price: "", price_mode: "par_joueur", repeat: false, repeat_weeks: 4, player_ids: [], open: false, level: "",
  });
  const [err, setErr] = useState("");
  const [clubs, setClubs] = useState([]);
  useEffect(() => { api("/clubs").then(setClubs); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const max = KIND[f.kind].cap;
  const club = clubs.find((c) => c.id === +f.club_id);

  function setKind(kind) {
    setF({ ...f, kind, player_ids: f.player_ids.slice(0, KIND[kind].cap), open: kind !== "individuel", price_mode: kind === "individuel" || f.open ? "par_joueur" : f.price_mode });
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
          price_millimes: Math.round(parseFloat(f.price || 0) * 1000), price_mode: f.open ? "par_joueur" : f.price_mode,
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

      <div className="grid">
        <Field label={f.open ? "Prix par joueur (TND)" : "Prix (TND)"}>
          <input type="number" step="0.001" min="0" placeholder="0,000" value={f.price} onChange={set("price")} />
        </Field>
        {f.kind !== "individuel" && !f.open && (
          <Field label="Ce prix est…">
            <select value={f.price_mode} onChange={set("price_mode")}>
              <option value="par_joueur">par joueur</option>
              <option value="groupe">pour tout le groupe</option>
            </select>
          </Field>
        )}
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
