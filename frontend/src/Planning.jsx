import { useEffect, useMemo, useState } from "react";
import { api, dayKey, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import SessionCalendar from "./SessionCalendar.jsx";
import SessionCard from "./SessionCard.jsx";
import SessionForm from "./SessionForm.jsx";
import SessionPayments, { PaySummary } from "./SessionPayments.jsx";
import { duplicateNextWeek, sessionStatus } from "./sessionActions.js";
import { KIND, Loading, PlayerTags } from "./ui.jsx";

const TZ = "Africa/Tunis";
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const mondayOf = (d) => addDays(d, -((new Date(ymd(d) + "T12:00:00Z").getUTCDay() + 6) % 7));

export default function Planning({ go, summary }) {
  const [sessions, setSessions] = useState(null);
  const [players, setPlayers] = useState([]);
  const [adding, setAdding] = useState(false);
  const [monday, setMonday] = useState(mondayOf(new Date()));
  const [sel, setSel] = useState(ymd(new Date()));
  const [openDone, setOpenDone] = useState(null);
  const [view, setView] = useState("liste"); // la liste du jour reste la vue par défaut
  const load = () => {
    api("/sessions").then(setSessions);
    api("/players").then(setPlayers);
  };
  useEffect(load, []);

  const byId = (id) => players.find((p) => p.id === id);
  const name = (id) => byId(id)?.name ?? "?";
  const byDay = useMemo(() => {
    const m = {};
    (sessions ?? []).forEach((s) => (m[dayKey(s.start)] ||= []).push(s));
    return m;
  }, [sessions]);
  const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const today = ymd(new Date());
  const list = byDay[sel] || [];
  const active = list.filter((s) => s.status !== "effectuee");
  const done = list.filter((s) => s.status === "effectuee"); // affichées en liste compacte
  const setStatus = sessionStatus(sessions ?? [], load);
  const duplicate = (s) => duplicateNextWeek(s, load);
  const shift = (n) => {
    const m = addDays(monday, n * 7);
    setMonday(m);
    setSel(ymd(m));
  };
  const monthLabel = week[0].toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: TZ });

  return (
    <>
      <div className="row">
        <h1 style={{ margin: 0 }}>Planning</h1>
        <div className="row" style={{ gap: 4 }}>
          <button className="small sec" onClick={() => go("exercises")}><Icon name="ball" size={15} /> Exercices</button>
          <button className="small sec" onClick={() => go("courts")}>
            <Icon name="pin" size={15} /> Terrains{summary?.waiting_court > 0 && <b className="pillcount" aria-label={`${summary.waiting_court} en attente`}>{summary.waiting_court}</b>}
          </button>
          <button className="small sec iconbtn" aria-label="Semaine précédente" onClick={() => shift(-1)}><Icon name="chevL" size={16} /></button>
          <button className="small sec" onClick={() => { setMonday(mondayOf(new Date())); setSel(today); }}>Aujourd'hui</button>
          <button className="small sec iconbtn" aria-label="Semaine suivante" onClick={() => shift(1)}><Icon name="chevR" size={16} /></button>
        </div>
      </div>
      <p className="mut" style={{ textTransform: "capitalize", margin: "6px 0 10px" }}>{monthLabel}</p>

      <div className="seg mini" role="tablist" aria-label="Affichage" style={{ marginBottom: 10 }}>
        <button role="tab" aria-selected={view === "liste"} className={view === "liste" ? "on" : ""} onClick={() => setView("liste")}><Icon name="list" size={14} /> Jour</button>
        <button role="tab" aria-selected={view === "calendrier"} className={view === "calendrier" ? "on" : ""} onClick={() => setView("calendrier")}><Icon name="calendar" size={14} /> Semaine</button>
      </div>

      {view === "calendrier" && (
        <>
          <div className="legend">{Object.values(KIND).map((k) => <span key={k.label}><i style={{ background: k.color }} />{k.label}</span>)}</div>
          {sessions === null ? <Loading rows={2} /> : (
            <SessionCalendar week={week} sessions={(sessions ?? []).filter((s) => week.some((d) => ymd(d) === dayKey(s.start)))} byId={byId} name={name} today={today}
              cardProps={{ onStatus: setStatus, onDuplicate: duplicate, onPrepare: (x) => go(`session/${x.id}`), onChanged: load }} />
          )}
          {adding && <SessionForm players={players} onDone={() => { setAdding(false); load(); }} />}
        </>
      )}

      {view === "liste" && <>
      <div className="weekstrip">
        {week.map((d) => {
          const k = ymd(d);
          const items = (byDay[k] || []).filter((s) => s.status !== "annulee");
          return (
            <button key={k} className={"day" + (k === sel ? " on" : "") + (k === today ? " today" : "")} onClick={() => setSel(k)}>
              <span className="dn">{d.toLocaleDateString("fr-FR", { weekday: "short", timeZone: TZ }).replace(".", "")}</span>
              <span className="dd">{d.toLocaleDateString("fr-FR", { day: "numeric", timeZone: TZ })}</span>
              <span className="dots">{items.slice(0, 4).map((s, i) => <i key={i} style={{ background: KIND[s.kind]?.color }} />)}</span>
            </button>
          );
        })}
      </div>

      <div className="legend">
        {Object.values(KIND).map((k) => <span key={k.label}><i style={{ background: k.color }} />{k.label}</span>)}
      </div>

      {adding && <SessionForm players={players} onDone={() => { setAdding(false); load(); }} />}

      {sessions === null && <Loading rows={2} />}
      {active.map((s) => <SessionCard key={s.id} s={s} name={name} byId={byId} onStatus={setStatus} onDuplicate={duplicate} onPrepare={(x) => go(`session/${x.id}`)} onChanged={load} />)}

      {done.length > 0 && (
        <>
          <h2>Séances effectuées ({done.length})</h2>
          <div className="donelist">
            {done.map((s) => (
              <div key={s.id} className={"donerow" + (openDone === s.id ? " on" : "")}>
                <button className="donerow-head" aria-expanded={openDone === s.id} onClick={() => setOpenDone(openDone === s.id ? null : s.id)}>
                  <i style={{ background: KIND[s.kind]?.color }} />
                  <b>{hhmm(s.start)}</b>
                  <span className="donerow-names"><PlayerTags ids={s.player_ids} byId={byId} first empty="Sans joueur" /></span>
                  <PaySummary s={s} />
                  <Icon name={openDone === s.id ? "chevD" : "chevR"} size={15} />
                </button>
                {openDone === s.id && (
                  <>
                    <SessionPayments s={s} name={name} byId={byId} onPaid={load} />
                    <div className="paylist" style={{ paddingTop: 0 }}><button className="small sec" onClick={() => duplicate(s)}><Icon name="copy" size={14} /> Copier à la semaine suivante</button></div>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {sessions !== null && list.length === 0 && !adding && (
        <div className="card empty">
          <Icon name="sun" size={32} />
          <b>Journée libre</b>
          <div className="mut">Aucune séance ce jour-là.</div>
        </div>
      )}
      </>}
      <button className="fab" onClick={() => setAdding(!adding)}>{adding ? <><Icon name="x" size={18} /> Fermer</> : <><Icon name="plus" size={18} /> Séance</>}</button>
    </>
  );
}
