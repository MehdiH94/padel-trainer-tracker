import { useState } from "react";
import { api, dayKey, hhmm, toDate } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { SessionTicket, fmt } from "./PlayerShared.jsx";
import { DateSelect, KIND, note10, TimeSelect } from "./ui.jsx";

// Planning du joueur: ses entraînements (réservés dans l'appli, automatiques) + ses matchs amicaux et tournois.
// Après un match: résultat, score, comment il a joué, commentaire, et le coach qui l'a coaché (qui peut y répondre).
export const EV = { match: ["Match amical", "swords"], tournoi: ["Tournoi", "trophy"] };
const DURATIONS = [[60, "1 h"], [90, "1 h 30"], [120, "2 h"], [180, "3 h"], [240, "4 h"], [360, "6 h"], [480, "Journée"]];
const isPast = (iso) => toDate(iso) <= new Date();
const hours = (h) => `${String(h).replace(".", ",")} h`;

// Formulaire d'un match / tournoi (ajout, puis résultat une fois joué)
function EventForm({ ev, me, onClose, onSaved }) {
  const now = new Date().toISOString();
  const [f, setF] = useState(() => ({
    kind: ev.kind ?? "match", title: ev.title ?? "", day: ev.start ? dayKey(ev.start) : dayKey(now), time: ev.start ? hhmm(ev.start) : "18:00",
    duration_min: ev.duration_min ?? 90, place: ev.place ?? "", coach_id: ev.coach_id ?? "",
    result: ev.result ?? "", score: ev.score ?? "", rating: ev.rating ?? null, comment: ev.comment ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const start = `${f.day}T${f.time}:00+01:00`; // heure de Tunis (UTC+1, pas d'heure d'été)
  const played = isPast(start);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, start, coach_id: f.coach_id ? +f.coach_id : null, duration_min: +f.duration_min };
      delete body.day; delete body.time;
      if (!played) Object.assign(body, { result: "", score: "", rating: null, comment: "" });
      await api(ev.id ? `/me/events/${ev.id}` : "/me/events", { method: ev.id ? "PUT" : "POST", body });
      toast(ev.id ? "Enregistré" : `${EV[f.kind][0]} ajouté à votre planning`);
      onSaved();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Supprimer ce ${f.kind === "tournoi" ? "tournoi" : "match"} ?`, confirm: "Supprimer", danger: true }))) return;
    api(`/me/events/${ev.id}`, { method: "DELETE" }).then(() => { toast("Supprimé"); onSaved(); }).catch(toastError);
  };
  return (
    <Modal onClose={onClose} label={EV[f.kind][0]}>
      <div className="row"><b className="sheet-title">{ev.id ? (played ? "Mon match" : "Modifier") : "Ajouter à mon planning"}</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <div className="seg-choice" role="group" aria-label="Type">
        {Object.entries(EV).map(([k, [l, ic]]) => <button key={k} type="button" className={f.kind === k ? "on" : ""} aria-pressed={f.kind === k} onClick={() => set("kind")(k)}><Icon name={ic} size={15} /> {l}</button>)}
      </div>
      <label className="field"><span className="mut">{f.kind === "tournoi" ? "Nom du tournoi" : "Avec qui ? (facultatif)"}</span><input value={f.title} onChange={set("title")} placeholder={f.kind === "tournoi" ? "Ex. Open de La Marsa" : "Ex. avec Karim, contre Sami et Ali"} /></label>
      <div className="grid">
        <label className="field"><span className="mut">Jour</span><DateSelect label="Jour" value={f.day} onChange={set("day")} from={-90} to={180} /></label>
        <label className="field"><span className="mut">Heure</span><TimeSelect label="Heure" value={f.time} onChange={set("time")} /></label>
      </div>
      <div className="grid">
        <label className="field"><span className="mut">Durée</span><select aria-label="Durée" value={f.duration_min} onChange={set("duration_min")}>{DURATIONS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></label>
        <label className="field"><span className="mut">Où ? (facultatif)</span><input value={f.place} onChange={set("place")} placeholder="Club" /></label>
      </div>
      <label className="field"><span className="mut">Coaché par</span>
        <select aria-label="Coaché par" value={f.coach_id} onChange={set("coach_id")}>
          <option value="">Pas de coach</option>
          {me.wallets.map((w) => <option key={w.coach_id} value={w.coach_id}>{w.coach_name}</option>)}
        </select>
      </label>
      {f.coach_id && <div className="mut small-p" style={{ marginTop: -4, marginBottom: 8 }}><Icon name="message" size={13} /> Votre coach verra ce {f.kind === "tournoi" ? "tournoi" : "match"} et pourra vous faire un retour.</div>}
      {played && (
        <div className="rate-box">
          <b>Après le {f.kind === "tournoi" ? "tournoi" : "match"}</b>
          <div className="seg-choice" role="group" aria-label="Résultat" style={{ marginTop: 6 }}>
            {[["victoire", "Victoire"], ["defaite", "Défaite"]].map(([k, l]) => <button key={k} type="button" className={f.result === k ? "on" : ""} aria-pressed={f.result === k} onClick={() => set("result")(f.result === k ? "" : k)}>{l}</button>)}
          </div>
          <label className="field"><span className="mut">Score</span><input value={f.score} onChange={set("score")} placeholder={f.kind === "tournoi" ? "Ex. demi-finale, 6-4 3-6 7-5" : "Ex. 6-4 6-3"} /></label>
          <label className="field"><span className="mut">Comment ai-je joué ? <b>{f.rating == null ? "–" : `${note10(f.rating)} / 10`}</b></span>
            <input type="range" min="0" max="10" step="0.5" value={f.rating ?? 5} onChange={(e) => set("rating")(+e.target.value)} aria-label="Ma note sur 10" style={{ padding: 0 }} />
          </label>
          <label className="field"><span className="mut">Mon commentaire</span><textarea rows={3} value={f.comment} onChange={set("comment")} placeholder="Ce qui a marché, ce que je veux travailler…" /></label>
        </div>
      )}
      <div className="actions" style={{ flexDirection: "column" }}>
        <button disabled={busy} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer"}</button>
        {ev.id && <button className="sec" onClick={remove}><Icon name="trash" size={15} /> Supprimer</button>}
      </div>
    </Modal>
  );
}

export function EventCard({ e, onOpen }) {
  const [label, icon] = EV[e.kind];
  const played = isPast(e.start);
  return (
    <button className="card past plain-card" style={{ width: "100%", textAlign: "left", display: "block" }} onClick={onOpen}>
      <div className="row">
        <span className={"ev-kind " + e.kind}><Icon name={icon} size={13} /> {label}</span>
        {e.result && <span className={"ev-result " + e.result}>{e.result === "victoire" ? "Victoire" : "Défaite"}{e.score && ` · ${e.score}`}</span>}
      </div>
      <div style={{ marginTop: 4 }}><b className="cap1">{fmt(e.start, { weekday: "long", day: "numeric", month: "long" })}</b> <span className="mut">· {hhmm(e.start)}</span></div>
      {(e.title || e.place) && <div className="mut">{[e.title, e.place].filter(Boolean).join(" · ")}</div>}
      {e.coach_name && <div className="mut"><Icon name="user" size={13} /> Coaché par {e.coach_name}</div>}
      {e.rating != null && <div className="small-p">Ma note : <b>{note10(e.rating)} / 10</b></div>}
      {e.comment && <div className="small-p" style={{ whiteSpace: "pre-line" }}>{e.comment}</div>}
      {e.coach_feedback && <div className="coach-says"><b>{e.coach_name} :</b> {e.coach_feedback}</div>}
      {played && !e.result && e.rating == null && <div className="todo-result"><Icon name="edit" size={13} /> Comment ça s'est passé ? Ajoutez le résultat.</div>}
    </button>
  );
}

// Séance d'entraînement passée (retour du coach en dépliant)
function PastTraining({ h, open, onToggle }) {
  return (
    <div className={"card past" + (open ? " open" : "")} onClick={onToggle}>
      <div className="row">
        <div className="row g10">
          <span className="kdot" style={{ background: KIND[h.kind].color }}><Icon name={KIND[h.kind].icon} size={14} /></span>
          <div><b className="cap1">{fmt(h.start, { weekday: "short", day: "numeric", month: "short" })}</b><div className="mut">Entraînement · {hhmm(h.start)} · {h.coach_name}</div></div>
        </div>
        <Icon name={open ? "chevD" : "chevR"} size={16} />
      </div>
      {open && (
        <div className="editor">
          {h.worked_on.length > 0 && <div className="chips" style={{ marginBottom: 6 }}>{h.worked_on.map((t) => <span key={t} className="chip on small static">{t}</span>)}</div>}
          {h.note ? <div>{h.note}</div> : <div className="mut">Pas de commentaire de votre coach.</div>}
          {h.to_improve && <div className="red" style={{ marginTop: 4 }}>À retravailler : {h.to_improve}</div>}
        </div>
      )}
    </div>
  );
}

// Temps de jeu du mois: entraînement, matchs amicaux, tournois (pour encourager à tout noter)
export function PlayTime({ play, compact }) {
  if (!play) return null;
  const items = [["entrainement", "Entraînement", "ball"], ["match", "Matchs amicaux", "swords"], ["tournoi", "Tournois", "trophy"]];
  const month = items.reduce((a, [k]) => a + play[k].month, 0);
  return (
    <>
      <div className="play-month">
        <Icon name="clock" size={20} />
        <div><b>{hours(Math.round(month * 10) / 10)} de padel ce mois-ci</b>{!compact && <div className="mut small-p">Notez aussi vos matchs et tournois : tout votre temps de jeu compte.</div>}</div>
      </div>
      <div className="playtime">
        {items.map(([k, l, ic]) => (
          <div key={k} className="kpi"><span className="ico"><Icon name={ic} size={16} /></span><div className="big">{hours(play[k].month)}</div><div className="mut">{l}</div>{!compact && <small className="mut">{hours(play[k].total)} au total</small>}</div>
        ))}
      </div>
    </>
  );
}

export function Planning({ me, sessions, events, progress, reload }) {
  const [view, setView] = useState("up");
  const [edit, setEdit] = useState(null); // événement ouvert dans le formulaire ({} = nouveau)
  const [openId, setOpenId] = useState(null);
  const [more, setMore] = useState(false);
  const now = new Date();
  const upcoming = [
    ...sessions.upcoming.map((s) => ({ t: "s", start: s.start, s })),
    ...events.filter((e) => toDate(e.start) > now).map((e) => ({ t: "e", start: e.start, e })),
  ].sort((a, b) => toDate(a.start) - toDate(b.start));
  const past = [
    ...sessions.history.filter((h) => h.session_status === "effectuee").map((h) => ({ t: "s", start: h.start, s: h })),
    ...events.filter((e) => toDate(e.start) <= now).map((e) => ({ t: "e", start: e.start, e })),
  ].sort((a, b) => toDate(b.start) - toDate(a.start));
  const todo = events.filter((e) => toDate(e.start) <= now && !e.result && e.rating == null).length;
  const shown = more ? past : past.slice(0, 10);
  const groups = [];
  shown.forEach((x) => {
    const m = fmt(x.start, { month: "long", year: "numeric" });
    (groups.find((g) => g[0] === m) ?? (groups.push([m, []]), groups[groups.length - 1]))[1].push(x);
  });
  const saved = () => { setEdit(null); reload(); };
  return (
    <>
      <h1>Planning</h1>
      <PlayTime play={progress?.play} />
      <div className="actions" style={{ margin: "12px 0" }}>
        <button onClick={() => setEdit({ kind: "match" })}><Icon name="plus" size={15} /> Match amical</button>
        <button onClick={() => setEdit({ kind: "tournoi" })}><Icon name="plus" size={15} /> Tournoi</button>
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={view === "up" ? "on" : ""} onClick={() => setView("up")}>À venir</button>
        <button className={view === "past" ? "on" : ""} onClick={() => setView("past")}>Passé{todo > 0 && <b className="navbadge inline">{todo}</b>}</button>
      </div>
      {view === "up" && (
        <>
          {upcoming.length === 0 && <div className="card empty"><Icon name="calendar" size={30} /><b>Rien de prévu</b><div className="mut">Réservez un entraînement ou ajoutez un match.</div></div>}
          {upcoming.map((x, i) => x.t === "s"
            ? <SessionTicket key={"s" + (x.s.session_id ?? "b") + "-" + (x.s.booking_id ?? i)} s={x.s} reload={reload} />
            : <EventCard key={"e" + x.e.id} e={x.e} onOpen={() => setEdit(x.e)} />)}
        </>
      )}
      {view === "past" && (
        <>
          {past.length === 0 && <div className="card mut">Rien de passé pour l'instant.</div>}
          {groups.map(([month, list]) => (
            <div key={month}>
              <h2 className="cap1">{month}</h2>
              {list.map((x) => x.t === "s"
                ? <PastTraining key={"s" + x.s.session_id} h={x.s} open={openId === x.s.session_id} onToggle={() => setOpenId(openId === x.s.session_id ? null : x.s.session_id)} />
                : <EventCard key={"e" + x.e.id} e={x.e} onOpen={() => setEdit(x.e)} />)}
            </div>
          ))}
          {!more && past.length > 10 && <button className="sec" style={{ width: "100%" }} onClick={() => setMore(true)}>Voir plus</button>}
        </>
      )}
      {edit && <EventForm ev={edit} me={me} onClose={() => setEdit(null)} onSaved={saved} />}
    </>
  );
}
