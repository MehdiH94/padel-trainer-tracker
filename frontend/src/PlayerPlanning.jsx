import { useState } from "react";
import { api, dayKey, dayLabel, hhmm, toDate } from "./api.js";
import { lanes, mondayOf } from "./CourtCalendar.jsx";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { SessionTicket, fmt, TZ } from "./PlayerShared.jsx";
import { DateSelect, KIND, note10, swipe, TimeSelect } from "./ui.jsx";

// Planning du joueur: ses entraînements (réservés dans l'appli, automatiques) + ses matchs amicaux et tournois.
// Après un match: résultat, score, comment il a joué, commentaire, et le coach qui l'a coaché (qui peut y répondre).
export const EV = { match: ["Match amical", "swords"], tournoi: ["Tournoi", "trophy"], autre: ["Autre", "star"] };
const DURATIONS = [[60, "1 h"], [90, "1 h 30"], [120, "2 h"], [180, "3 h"], [240, "4 h"], [360, "6 h"], [480, "Journée"]];
const isPast = (iso) => toDate(iso) <= new Date();
const hours = (h) => `${String(h).replace(".", ",")} h`;

// Formulaire d'un match / tournoi (ajout, puis résultat une fois joué)
function EventForm({ ev, me, onClose, onSaved }) {
  const now = new Date().toISOString();
  const [f, setF] = useState(() => ({
    kind: ev.kind ?? "match", title: ev.title ?? "", day: ev.start ? dayKey(ev.start) : ev.day ?? dayKey(now), time: ev.start ? hhmm(ev.start) : ev.time ?? "18:00",
    duration_min: ev.duration_min ?? (ev.kind === "autre" ? 60 : 90), place: ev.place ?? "", coach_id: ev.coach_id ?? "", court_reserved: ev.court_reserved ?? false,
    result: ev.result ?? "", score: ev.score ?? "", rating: ev.rating ?? null, comment: ev.comment ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const start = `${f.day}T${f.time}:00+01:00`; // heure de Tunis (UTC+1, pas d'heure d'été)
  const other = f.kind === "autre"; // kiné, séance physique…: une description, pas de résultat ni de coach
  const played = isPast(start) && !other;
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
      <label className="field"><span className="mut">{other ? "Quoi ?" : f.kind === "tournoi" ? "Nom du tournoi" : "Avec qui ? (facultatif)"}</span><input value={f.title} onChange={set("title")} placeholder={other ? "Ex. kiné, séance physique, étirements" : f.kind === "tournoi" ? "Ex. Open de La Marsa" : "Ex. avec Karim, contre Sami et Ali"} /></label>
      <div className="grid">
        <label className="field"><span className="mut">Jour</span><DateSelect label="Jour" value={f.day} onChange={set("day")} from={-90} to={180} /></label>
        <label className="field"><span className="mut">Heure</span><TimeSelect label="Heure" value={f.time} onChange={set("time")} /></label>
      </div>
      <div className="grid">
        <label className="field"><span className="mut">Durée</span><select aria-label="Durée" value={f.duration_min} onChange={set("duration_min")}>{DURATIONS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></label>
        <label className="field"><span className="mut">Où ? (facultatif)</span><input value={f.place} onChange={set("place")} placeholder="Club" /></label>
      </div>
      {f.kind === "match" && (
        <label className="check-line"><input type="checkbox" checked={f.court_reserved} onChange={(e) => set("court_reserved")(e.target.checked)} /> J'ai un terrain réservé</label>
      )}
      {!other && <label className="field"><span className="mut">Coaché par</span>
        <select aria-label="Coaché par" value={f.coach_id} onChange={set("coach_id")}>
          <option value="">Pas de coach</option>
          {me.wallets.map((w) => <option key={w.coach_id} value={w.coach_id}>{w.coach_name}</option>)}
        </select>
      </label>}
      {f.coach_id && !other && <div className="mut small-p" style={{ marginTop: -4, marginBottom: 8 }}><Icon name="message" size={13} /> Votre coach verra ce {f.kind === "tournoi" ? "tournoi" : "match"} et pourra vous faire un retour.</div>}
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
      {e.court_reserved && <div className="mut"><Icon name="pin" size={13} /> Terrain réservé</div>}
      {e.coach_name && <div className="mut"><Icon name="user" size={13} /> Coaché par {e.coach_name}</div>}
      {e.rating != null && <div className="small-p">Ma note : <b>{note10(e.rating)} / 10</b></div>}
      {e.comment && <div className="small-p" style={{ whiteSpace: "pre-line" }}>{e.comment}</div>}
      {e.coach_feedback && <div className="coach-says"><b>{e.coach_name} :</b> {e.coach_feedback}</div>}
      {played && e.kind !== "autre" && !e.result && e.rating == null && <div className="todo-result"><Icon name="edit" size={13} /> Comment ça s'est passé ? Ajoutez le résultat.</div>}
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
export function PlayTime({ play, compact, bare }) {
  if (!play) return null;
  const items = [["entrainement", "Entraînement", "ball"], ["match", "Matchs amicaux", "swords"], ["tournoi", "Tournois", "trophy"]];
  const month = items.reduce((a, [k]) => a + play[k].month, 0);
  return (
    <>
      {!bare && <div className="play-month">
        <Icon name="clock" size={20} />
        <div><b>{hours(Math.round(month * 10) / 10)} de padel ce mois-ci</b>{!compact && <div className="mut small-p">Notez aussi vos matchs et tournois : tout votre temps de jeu compte.</div>}</div>
      </div>}
      <div className="playtime">
        {items.map(([k, l, ic]) => (
          <div key={k} className="kpi"><span className="ico"><Icon name={ic} size={16} /></span><div className="big">{hours(play[k].month)}</div><div className="mut">{l}</div>{!compact && <small className="mut">{hours(play[k].total)} au total</small>}</div>
        ))}
      </div>
    </>
  );
}

// Ajouter à l'agenda: un entraînement (mène à Réserver), un match, un tournoi ou autre chose (kiné, physique…)
function AddMenu({ at, onPick, onBook, onClose }) {
  const items = [
    ["book", "calendar", "Entraînement", "Réserver une séance avec un coach"],
    ["match", "swords", "Match amical", "Avec ou sans terrain réservé"],
    ["tournoi", "trophy", "Tournoi", "Résultat et retour de votre coach après"],
    ["autre", "star", "Autre", "Kiné, séance physique… ce que vous voulez"],
  ];
  return (
    <Modal onClose={onClose} label="Ajouter à mon planning">
      <div className="row"><b className="sheet-title">Ajouter{at?.day ? <> · <span className="cap1">{dayLabel(at.day + "T12:00:00+01:00")}</span></> : ""}</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <div className="actions" style={{ flexDirection: "column" }}>
        {items.map(([k, ic, l, sub]) => (
          <button key={k} className="sec choice" onClick={() => (k === "book" ? onBook() : onPick({ kind: k, ...at }))}>
            <Icon name={ic} size={18} /><span><b>{l}</b><small>{sub}</small></span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const short = (iso) => { const [h, m] = hhmm(iso).split(":"); return `${+h}${m === "00" ? "" : "h" + m}`; };
const MAX_WEEKS = 13; // trois mois avant et après

// Agenda de la semaine (comme le calendrier du coach): entraînements, matchs, tournois et le reste
function Week({ items, onOpen, onAdd }) {
  const [monday, setMonday] = useState(mondayOf(new Date()));
  const [day, setDay] = useState(null); // un seul jour en grand
  const PX = day ? 70 : 44;
  const first = mondayOf(new Date());
  const offset = Math.round((monday - first) / (7 * 86400000));
  const move = (n) => { if (Math.abs(offset + n) <= MAX_WEEKS) setMonday(addDays(monday, 7 * n)); };
  const moveDay = (n) => { const d = ymd(addDays(new Date(day + "T12:00:00Z"), n)); setDay(d); setMonday(mondayOf(new Date(d + "T12:00:00Z"))); };
  const days = day ? [new Date(day + "T12:00:00Z")] : Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const today = ymd(new Date());
  const byDay = Object.fromEntries(days.map((d) => [ymd(d), lanes(items.filter((x) => ymd(toDate(x.start)) === ymd(d)).sort((a, b) => toDate(a.start) - toDate(b.start)))]));
  const all = Object.values(byDay).flat();
  const minH = Math.min(8, ...all.map((x) => Math.floor(x.s)));
  const maxH = Math.max(22, ...all.map((x) => Math.ceil(x.e)));
  const hoursList = Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i);
  const range = `${days[0].toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: TZ })} – ${days[days.length - 1].toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: TZ })}`;
  const present = new Set(all.map((x) => x.cb.type));
  // toucher une case vide: ajouter quelque chose ce jour-là, à cette heure
  const addAt = (d, e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const h = Math.min(23, Math.max(6, Math.floor(minH + (e.clientY - r.top) / PX)));
    onAdd({ day: ymd(d), time: `${String(h).padStart(2, "0")}:00` });
  };
  const sw = swipe(day ? () => moveDay(1) : () => move(1), day ? () => moveDay(-1) : () => move(-1));
  return (
    <>
      {day ? (
        <div className="row cal-daybar">
          <button className="small sec" onClick={() => setDay(null)}><Icon name="chevL" size={15} /> Semaine</button>
          <div className="row" style={{ gap: 4 }}>
            <button className="small sec iconbtn" aria-label="Jour précédent" onClick={() => moveDay(-1)}><Icon name="chevL" size={16} /></button>
            <b className="cap1">{days[0].toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</b>
            <button className="small sec iconbtn" aria-label="Jour suivant" onClick={() => moveDay(1)}><Icon name="chevR" size={16} /></button>
          </div>
        </div>
      ) : (
        <div className="weekbar">
          <button className="small sec iconbtn" aria-label="Semaine précédente" disabled={offset <= -MAX_WEEKS} onClick={() => move(-1)}><Icon name="chevL" size={18} /></button>
          <div className="weekbar-label">
            <b>{range}</b>
            {offset === 0 ? <small>Cette semaine</small> : <button className="link small-p" onClick={() => setMonday(first)}>Aujourd'hui</button>}
          </div>
          <button className="small sec iconbtn" aria-label="Semaine suivante" disabled={offset >= MAX_WEEKS} onClick={() => move(1)}><Icon name="chevR" size={18} /></button>
        </div>
      )}
      {present.size > 0 && (
        <div className="cal-legend">
          {Object.entries(TYPES).filter(([k]) => present.has(k)).map(([k, l]) => <span key={k}><i className={"cal-dot p-" + k} />{l}</span>)}
        </div>
      )}
      <div className={"cal card" + (day ? " one" : "")} {...sw} role="grid" aria-label="Mon agenda de la semaine">
        <div className="cal-head">
          <span />
          {days.map((d) => {
            const k = ymd(d);
            const label = <>{d.toLocaleDateString("fr-FR", { weekday: "short", timeZone: TZ }).replace(".", "")}<b>{d.toLocaleDateString("fr-FR", { day: "numeric", timeZone: TZ })}</b></>;
            return day ? <span key={k} className={k === today ? "today" : ""}>{label}</span>
              : <button key={k} className={"cal-day" + (k === today ? " today" : "")} onClick={() => setDay(k)} aria-label={`Afficher ${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })}`}>{label}</button>;
          })}
        </div>
        <div className="cal-body" style={{ height: (maxH - minH) * PX }}>
          <div className="cal-times">{hoursList.map((h) => <span key={h} style={{ top: (h - minH) * PX }}>{h} h</span>)}</div>
          {days.map((d) => (
            <div key={ymd(d)} className={"cal-col" + (ymd(d) === today ? " today" : "")} style={{ backgroundSize: `100% ${PX}px` }} onClick={(e) => e.target === e.currentTarget && addAt(d, e)}>
              {byDay[ymd(d)].map(({ cb, s, e, lane, count }) => (
                <button key={cb.id} className={"cal-block p-" + cb.type} onClick={() => onOpen(cb)}
                  style={{ top: (s - minH) * PX, height: Math.max((e - s) * PX - 2, 18), left: `${(lane / count) * 100}%`, width: `${100 / count}%` }}
                  aria-label={`${TYPES[cb.type]}, ${hhmm(cb.start)}${cb.label ? ", " + cb.label : ""}`}>
                  <b>{short(cb.start)}{day && ` · ${TYPES[cb.type]}`}</b>
                  {cb.label && <small>{cb.label}</small>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="mut small-p center">Touchez un jour pour l'afficher en grand, une case vide pour y ajouter quelque chose.</p>
    </>
  );
}
const TYPES = { entrainement: "Entraînement", match: "Match amical", tournoi: "Tournoi", autre: "Autre" };

export function Planning({ me, sessions, events, progress, reload, go }) {
  const [mode, setMode] = useState("semaine"); // agenda de la semaine, ou liste
  const [view, setView] = useState("up");
  const [adding, setAdding] = useState(null); // menu « Ajouter » (avec jour / heure si une case a été touchée)
  const [training, setTraining] = useState(null); // entraînement ouvert depuis l'agenda
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
  // Entraînement: on part à la réservation, sur le jour choisi
  const book = (at) => {
    try {
      const k = JSON.parse(sessionStorage.getItem("book-filters") || "{}");
      if (at?.day && at.day >= dayKey(new Date().toISOString())) sessionStorage.setItem("book-filters", JSON.stringify({ ...k, day: at.day }));
    } catch { /* stockage indisponible */ }
    go("book");
  };
  // blocs de l'agenda: entraînements (réservés, à venir ou effectués) et événements du joueur
  const items = [
    ...[...sessions.upcoming, ...sessions.history.filter((h) => h.session_status === "effectuee")].map((x, i) => ({
      id: "s" + (x.session_id ?? "b" + x.booking_id ?? i), type: "entrainement", start: x.start, duration_min: x.duration_min, label: x.coach_name, s: x })),
    ...events.map((e) => ({ id: "e" + e.id, type: e.kind, start: e.start, duration_min: e.duration_min, label: e.kind === "autre" ? e.title : e.title || e.place, e })),
  ];
  return (
    <>
      <h1>Planning</h1>
      <PlayTime play={progress?.play} compact={mode === "semaine"} />
      <button className="cta" style={{ marginTop: 12 }} onClick={() => setAdding({})}><Icon name="plus" size={20} /> Ajouter à mon planning <Icon name="chevR" size={18} /></button>
      <div className="seg mini" role="tablist" aria-label="Affichage" style={{ margin: "10px 0" }}>
        <button role="tab" aria-selected={mode === "semaine"} className={mode === "semaine" ? "on" : ""} onClick={() => setMode("semaine")}><Icon name="calendar" size={14} /> Semaine</button>
        <button role="tab" aria-selected={mode === "liste"} className={mode === "liste" ? "on" : ""} onClick={() => setMode("liste")}><Icon name="list" size={14} /> Liste{todo > 0 && <b className="navbadge inline">{todo}</b>}</button>
      </div>
      {mode === "semaine" && <Week items={items} onAdd={setAdding} onOpen={(x) => (x.e ? setEdit(x.e) : setTraining(x.s))} />}
      {mode === "liste" && <div className="seg" style={{ marginBottom: 12 }}>
        <button className={view === "up" ? "on" : ""} onClick={() => setView("up")}>À venir</button>
        <button className={view === "past" ? "on" : ""} onClick={() => setView("past")}>Passé{todo > 0 && <b className="navbadge inline">{todo}</b>}</button>
      </div>}
      {mode === "liste" && view === "up" && (
        <>
          {upcoming.length === 0 && <div className="card empty"><Icon name="calendar" size={30} /><b>Rien de prévu</b><div className="mut">Réservez un entraînement ou ajoutez un match.</div></div>}
          {upcoming.map((x, i) => x.t === "s"
            ? <SessionTicket key={"s" + (x.s.session_id ?? "b") + "-" + (x.s.booking_id ?? i)} s={x.s} reload={reload} />
            : <EventCard key={"e" + x.e.id} e={x.e} onOpen={() => setEdit(x.e)} />)}
        </>
      )}
      {mode === "liste" && view === "past" && (
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
      {adding && <AddMenu at={adding} onClose={() => setAdding(null)} onBook={() => book(adding)} onPick={(ev) => { setAdding(null); setEdit(ev); }} />}
      {training && (
        <Modal onClose={() => setTraining(null)} label="Entraînement">
          <div className="row"><b className="sheet-title">Entraînement</b><button className="small sec iconbtn" aria-label="Fermer" onClick={() => setTraining(null)}><Icon name="x" size={15} /></button></div>
          {training.session_status === "effectuee" ? (
            <div className="card">
              <b className="cap1">{dayLabel(training.start)} · {hhmm(training.start)}</b>
              <div className="mut">{training.coach_name}{training.club && ` · ${training.club}`}</div>
              {training.worked_on?.length > 0 && <div className="chips" style={{ margin: "6px 0" }}>{training.worked_on.map((t) => <span key={t} className="chip on small static">{t}</span>)}</div>}
              {training.note ? <div>{training.note}</div> : <div className="mut">Pas encore de retour de votre coach.</div>}
              {training.to_improve && <div className="red">À retravailler : {training.to_improve}</div>}
            </div>
          ) : <SessionTicket s={training} reload={() => { setTraining(null); reload(); }} />}
        </Modal>
      )}
    </>
  );
}
