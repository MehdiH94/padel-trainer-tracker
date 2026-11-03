import { useEffect, useState } from "react";
import { api, hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog } from "./feedback.jsx";
import { Avatar, CATEGORIES, CategoryBadge, catLabel, catOption, KIND, DateSelect, levelClashes, TimeSelect } from "./ui.jsx";

// Choix des joueurs: liste déroulante avec recherche, niveau de chacun; les joueurs choisis restent affichés au-dessus
function PlayerPicker({ players, chosen, max, onToggle }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const picked = chosen.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const list = players.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  const full = chosen.length >= max;
  return (
    <div className="picker">
      {picked.map((p) => (
        <div className="picked" key={p.id}>
          <Avatar name={p.name} size={28} /><span className="picked-name">{p.name}</span><CategoryBadge category={p.category} gender={p.gender} />
          <button type="button" className="small sec iconbtn" aria-label={`Retirer ${p.name}`} onClick={() => onToggle(p.id)}><Icon name="x" size={14} /></button>
        </div>
      ))}
      {!players.length ? <span className="mut">Ajoutez d'abord des joueurs.</span> : (!full || max === 1) && (
        <button type="button" className="sec picker-open" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="userPlus" size={16} /> {max === 1 && picked.length ? "Changer de joueur" : "Ajouter un joueur"} <Icon name={open ? "chevD" : "chevR"} size={15} />
        </button>
      )}
      {open && (
        <div className="picker-list">
          <div className="searchbox" style={{ margin: "0 0 6px" }}><Icon name="search" size={16} /><input autoFocus placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {list.map((p) => {
            const on = chosen.includes(p.id);
            return (
              <button type="button" key={p.id} className={"picker-row" + (on ? " on" : "")} disabled={!on && full && max > 1}
                onClick={() => { onToggle(p.id); setOpen(false); setQ(""); }}>
                <Avatar name={p.name} size={26} /><span className="picked-name">{p.name}</span>
                <CategoryBadge category={p.category} gender={p.gender} />{on && <Icon name="check" size={15} />}
              </button>
            );
          })}
          {!list.length && <div className="mut small-p">Aucun joueur trouvé.</div>}
        </div>
      )}
    </div>
  );
}

const DURATIONS = [45, 60, 90, 120];

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="mut">{label}</span>
      {children}
    </label>
  );
}

export default function SessionForm({ players, onDone, initial }) {
  const today = new Date().toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const [f, setF] = useState({
    date: today, time: "18:00", duration_min: 60, kind: "individuel", club_id: "", court_booked: false, court: "",
    discount_pct: 0, repeat: false, repeat_weeks: 4, player_ids: [], open: false, level: "",
    ...(initial ?? {}), // « Créer une séance sur ce terrain » (calendrier): date, heure, club et terrain déjà choisis
  });
  // Un de mes terrains réservés couvre-t-il ce créneau ? (au club choisi, ou ailleurs: proposer ce club)
  const [cover, setCover] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams({ start: `${f.date}T${f.time}:00+01:00`, duration_min: f.duration_min, ...(f.club_id && { club_id: f.club_id }) });
      api(`/court-bookings/cover?${q}`).then(setCover).catch(() => setCover(null));
    }, 250);
    return () => clearTimeout(t);
  }, [f.date, f.time, f.duration_min, f.club_id]);
  const h = (iso) => hhmm(iso).replace(":", " h ");
  const span = (cb) => `${h(cb.start)} – ${h(new Date(new Date(cb.start.endsWith("Z") || /[+-]\d\d:\d\d$/.test(cb.start) ? cb.start : cb.start + "Z").getTime() + cb.duration_min * 60000).toISOString())}`;
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

  // Le coach mélange les niveaux comme il veut, mais il est prévenu si la règle des niveaux n'est pas respectée
  const chosenPlayers = f.player_ids.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const clashes = levelClashes(chosenPlayers);
  const clashText = clashes.map(([a, b]) => `${a.name.split(" ")[0]} (${catLabel(a.category)}${a.gender === "F" ? ", dame" : ""}) et ${b.name.split(" ")[0]} (${catLabel(b.category)}${b.gender === "F" ? ", dame" : ""})`).join(" ; ");

  async function submit(e) {
    e.preventDefault();
    if (clashes.length && !(await confirmDialog({
      title: "Niveaux à mélanger ?",
      message: `Attention, ces joueurs ont des niveaux qui ne sont pas censés se mélanger : ${clashText}. Êtes-vous sûr de vouloir créer la séance ?`,
      confirm: "Créer quand même", cancel: "Revoir les joueurs",
    }))) return;
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
      {cover?.here && (
        <div className="note ok" style={{ margin: "-4px 0 10px" }}>
          <Icon name="checkCircle" size={14} /> <b>C'est bon : un terrain est déjà réservé pour ce créneau</b> ({cover.here.club_name}{cover.here.court_label && ` · ${cover.here.court_label}`}, {span(cover.here)}). La séance l'utilisera, aucun SMS au club.
        </div>
      )}
      {!cover?.here && cover?.elsewhere?.length > 0 && (
        <div className="note warn" style={{ margin: "-4px 0 10px" }}>
          <Icon name="pin" size={14} /> Vous avez un terrain libre à ce moment-là : <b>{cover.elsewhere[0].club_name}</b>{cover.elsewhere[0].court_label && ` · ${cover.elsewhere[0].court_label}`} ({span(cover.elsewhere[0])}).
          <div><button type="button" className="link" onClick={() => setF({ ...f, club_id: String(cover.elsewhere[0].club_id) })}>Choisir ce club</button></div>
        </div>
      )}
      {f.club_id && !cover?.here && (
        <>
          <div className="note warn" style={{ margin: "-4px 0 8px" }}><Icon name="alert" size={14} /> Aucun de vos terrains réservés ne couvre ce créneau dans ce club.</div>
          <label className="check">
            <input type="checkbox" checked={f.court_booked} onChange={(e) => setF({ ...f, court_booked: e.target.checked })} />
            J'ai déjà réservé le terrain (aucun SMS au club)
          </label>
          {f.court_booked && <Field label="Terrain (facultatif)"><input placeholder="ex. Terrain 2" value={f.court} onChange={set("court")} /></Field>}
          {!f.court_booked && <div className="mut" style={{ margin: "-4px 0 10px" }}><Icon name="send" size={13} /> Un SMS de réservation sera envoyé au club{club?.phone ? "" : " (ce club n'a pas de numéro : ajoutez-le dans Terrains)"}.</div>}
        </>
      )}

      {/* pas de <label> ici: il contient plusieurs boutons */}
      <div className="field">
        <span className="mut">Joueurs ({f.player_ids.length}/{max})</span>
        <PlayerPicker players={players} chosen={f.player_ids} max={max} onToggle={togglePlayer} />
      </div>
      {clashes.length > 0 && (
        <div className="note warn" style={{ margin: "-4px 0 10px" }}>
          <Icon name="alert" size={14} /> Niveaux qui ne sont pas censés se mélanger : {clashText}. Vous pouvez quand même créer la séance.
        </div>
      )}

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
