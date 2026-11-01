import { useEffect, useMemo, useState } from "react";
import { api, dayKey, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import SessionCard from "./SessionCard.jsx";
import SessionForm from "./SessionForm.jsx";
import SessionPayments, { PaySummary } from "./SessionPayments.jsx";
import { KIND } from "./ui.jsx";

const TZ = "Africa/Tunis";
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const mondayOf = (d) => addDays(d, -((new Date(ymd(d) + "T12:00:00Z").getUTCDay() + 6) % 7));

export default function Planning() {
  const [sessions, setSessions] = useState([]);
  const [players, setPlayers] = useState([]);
  const [adding, setAdding] = useState(false);
  const [monday, setMonday] = useState(mondayOf(new Date()));
  const [sel, setSel] = useState(ymd(new Date()));
  const [openDone, setOpenDone] = useState(null);
  const load = () => {
    api("/sessions").then(setSessions);
    api("/players").then(setPlayers);
  };
  useEffect(load, []);

  const name = (id) => players.find((p) => p.id === id)?.name ?? "?";
  const byDay = useMemo(() => {
    const m = {};
    sessions.forEach((s) => (m[dayKey(s.start)] ||= []).push(s));
    return m;
  }, [sessions]);
  const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const today = ymd(new Date());
  const list = byDay[sel] || [];
  const active = list.filter((s) => s.status !== "effectuee");
  const done = list.filter((s) => s.status === "effectuee"); // affichées en liste compacte
  const setStatus = (id, status) => api(`/sessions/${id}`, { method: "PATCH", body: { status } }).then(load);
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
          <button className="small sec iconbtn" aria-label="Semaine précédente" onClick={() => shift(-1)}><Icon name="chevL" size={16} /></button>
          <button className="small sec" onClick={() => { setMonday(mondayOf(new Date())); setSel(today); }}>Aujourd'hui</button>
          <button className="small sec iconbtn" aria-label="Semaine suivante" onClick={() => shift(1)}><Icon name="chevR" size={16} /></button>
        </div>
      </div>
      <p className="mut" style={{ textTransform: "capitalize", margin: "6px 0 10px" }}>{monthLabel}</p>

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

      {active.map((s) => <SessionCard key={s.id} s={s} name={name} onStatus={setStatus} />)}

      {done.length > 0 && (
        <>
          <h2>Séances effectuées ({done.length})</h2>
          <div className="donelist">
            {done.map((s) => (
              <div key={s.id} className={"donerow" + (openDone === s.id ? " on" : "")}>
                <button className="donerow-head" aria-expanded={openDone === s.id} onClick={() => setOpenDone(openDone === s.id ? null : s.id)}>
                  <i style={{ background: KIND[s.kind]?.color }} />
                  <b>{hhmm(s.start)}</b>
                  <span className="donerow-names">{s.player_ids.map(name).join(", ") || "Sans joueur"}</span>
                  <PaySummary s={s} />
                  <Icon name={openDone === s.id ? "chevD" : "chevR"} size={15} />
                </button>
                {openDone === s.id && <SessionPayments s={s} name={name} onPaid={load} />}
              </div>
            ))}
          </div>
        </>
      )}
      {list.length === 0 && !adding && (
        <div className="card empty">
          <Icon name="sun" size={32} />
          <b>Journée libre</b>
          <div className="mut">Aucune séance ce jour-là.</div>
        </div>
      )}
      <button className="fab" onClick={() => setAdding(!adding)}>{adding ? <><Icon name="x" size={18} /> Fermer</> : <><Icon name="plus" size={18} /> Séance</>}</button>
    </>
  );
}
