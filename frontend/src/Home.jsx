import { useEffect, useState } from "react";
import { api, dayKey, dayLabel, hhmm, shortDate, tnd, toDate } from "./api.js";
import FeedbackEditor from "./FeedbackEditor.jsx";
import SessionPayments from "./SessionPayments.jsx";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import { sessionStatus } from "./sessionActions.js";
import { Avatar, AvatarStack, BarChart, COURT_STATUS, InstallCard, KIND, Loading } from "./ui.jsx";

const TZ = "Africa/Tunis";
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const weekStart = (iso) => {
  const d = new Date(dayKey(iso) + "T12:00:00Z");
  return ymd(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000));
};
const endOf = (s) => new Date(toDate(s.start).getTime() + s.duration_min * 60000);
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}` : `${min} min`);

// Libellé d'état d'une séance d'aujourd'hui, selon l'heure actuelle
function phase(s, now) {
  const st = toDate(s.start), en = endOf(s);
  if (now >= en) return { key: "validate", label: "À valider" };
  if (now >= st) return { key: "live", label: "En cours" };
  const m = Math.round((st - now) / 60000);
  return { key: "soon", label: m < 60 ? `Dans ${m} min` : `Dans ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` };
}

// Panneau d'une séance terminée: un retour par joueur
function DonePanel({ s, name, strokes, onSaved, onClose }) {
  const [list, setList] = useState(null);
  const [who, setWho] = useState(null);
  const load = () => api(`/sessions/${s.id}/feedback`).then((l) => { setList(l); setWho((w) => w ?? l[0]?.player_id); });
  useEffect(() => { setList(null); setWho(null); load(); }, [s.id]);
  if (!list) return null;
  const cur = list.find((x) => x.player_id === who) ?? list[0];
  return (
    <div className="card donepanel">
      <div className="row">
        <b style={{ textTransform: "capitalize" }}>{shortDate(s.start)} · {hhmm(s.start)} · {KIND[s.kind].label}</b>
        <button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button>
      </div>
      {s.payments?.length > 0 && (
        <>
          <div className="mut" style={{ marginTop: 8 }}>Règlements</div>
          <SessionPayments s={s} name={name} onPaid={onSaved} />
        </>
      )}
      {list.length > 1 && (
        <div className="chips" style={{ margin: "8px 0" }}>
          {list.map((x) => {
            const filled = x.worked_on.length || x.note || x.to_improve;
            return <button key={x.player_id} className={"chip small" + (cur.player_id === x.player_id ? " on" : "")} onClick={() => setWho(x.player_id)}>{x.name.split(" ")[0]}{filled ? "" : " •"}</button>;
          })}
        </div>
      )}
      {list.length === 1 && <div className="mut" style={{ margin: "4px 0" }}>{cur.name}</div>}
      {cur && <FeedbackEditor key={cur.player_id} h={cur} playerId={cur.player_id} strokes={strokes} onSaved={() => { load(); onSaved(); }} />}
    </div>
  );
}

// Impayé: encaisser sur place ou relancer
function UnpaidRow({ u, openPlayer, go, onPaid }) {
  const [f, setF] = useState(null);
  async function save(e) {
    e.preventDefault();
    try {
      await api("/payments", { method: "POST", body: { player_id: u.player_id, amount_millimes: Math.round(Number(String(f.amount).replace(",", ".")) * 1000), method: f.method } });
      toast(`Paiement de ${u.name.split(" ")[0]} enregistré`);
      setF(null);
      onPaid();
    } catch (x) {
      toastError(x);
    }
  }
  return (
    <div className="card">
      <div className="row">
        <button className="row g10 plain" onClick={() => openPlayer(u.player_id)}>
          <Avatar name={u.name} />
          <span style={{ textAlign: "left" }}><b>{u.name}</b><span className="red" style={{ display: "block" }}>{tnd(u.amount_millimes)}</span></span>
        </button>
        {!f && (
          <div className="row" style={{ gap: 6 }}>
            <button className="small" onClick={() => setF({ amount: (u.amount_millimes / 1000).toFixed(3), method: "especes" })}>Encaisser</button>
            <button className="small sec iconbtn" title="Relancer" aria-label={`Relancer ${u.name}`} onClick={() => go("reminders")}><Icon name="send" size={15} /></button>
          </div>
        )}
      </div>
      {f && (
        <form className="payform" style={{ marginTop: 10 }} onSubmit={save}>
          <span className="inputunit"><input inputMode="decimal" aria-label="Montant" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /><em>TND</em></span>
          <select aria-label="Moyen de paiement" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="especes">Espèces</option><option value="virement">Virement</option></select>
          <button className="small">OK</button>
          <button type="button" className="small sec iconbtn" aria-label="Annuler" onClick={() => setF(null)}><Icon name="x" size={14} /></button>
        </form>
      )}
    </div>
  );
}

// Premiers pas d'un nouveau coach: prix, disponibilités, premier joueur
function Onboarding({ settings, players, go }) {
  const steps = [
    ["Fixer mes prix", Boolean(settings.price_individuel || settings.price_duo || settings.price_groupe), "settings"],
    ["Ouvrir mes disponibilités", settings.availability.length > 0, "settings"],
    ["Ajouter mon premier joueur", players.length > 0, "players"],
  ];
  const done = steps.filter((s) => s[1]).length;
  if (done === steps.length) return null;
  return (
    <div className="card onboard">
      <div className="row"><b>Bien démarrer</b><span className="mut">{done}/{steps.length}</span></div>
      <div className="bar"><div style={{ width: `${(done / steps.length) * 100}%`, background: "var(--green)" }} /></div>
      {steps.map(([label, ok, to], i) => (
        <button key={label} className={"step" + (ok ? " ok" : "")} onClick={() => go(to)} disabled={ok}>
          <span className="stepnum">{ok ? <Icon name="check" size={14} /> : i + 1}</span>{label}{!ok && <Icon name="chevR" size={16} />}
        </button>
      ))}
    </div>
  );
}

export default function Home({ go, openPlayer, summary }) {
  const [d, setD] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [players, setPlayers] = useState([]);
  const [pays, setPays] = useState([]);
  const [strokes, setStrokes] = useState([]);
  const [metric, setMetric] = useState("hours");
  const [now, setNow] = useState(new Date());
  const [openDone, setOpenDone] = useState(null);
  const [settings, setSettings] = useState(null);
  const [playersLoaded, setPlayersLoaded] = useState(false);
  const load = () => {
    api("/booking/settings").then(setSettings).catch(() => {});
    api("/dashboard").then(setD);
    api("/sessions").then(setSessions);
    api("/players").then((p) => { setPlayers(p); setPlayersLoaded(true); });
    api("/payments").then(setPays);
  };
  useEffect(() => { load(); api("/strokes").then(setStrokes); }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  if (!d) return <Loading hero rows={3} />;

  const byId = (id) => players.find((p) => p.id === id);
  const name = (id) => byId(id)?.name ?? "?";
  const todayAll = sessions.filter((s) => dayKey(s.start) === ymd(now) && s.status !== "annulee");
  const toDo = todayAll.filter((s) => s.status === "prevue"); // les séances terminées n'encombrent plus l'accueil
  const done = todayAll.length - toDo.length;
  const hoursToday = todayAll.reduce((a, s) => a + s.duration_min, 0);
  const expected = todayAll.reduce((a, s) => a + (s.price_mode === "groupe" ? s.price_millimes : s.price_millimes * s.player_ids.length), 0);
  const focus = toDo.find((s) => ["live", "validate"].includes(phase(s, now).key)) || toDo.find((s) => phase(s, now).key === "soon");
  const finished = sessions.filter((s) => s.status === "effectuee").sort((a, b) => toDate(b.start) - toDate(a.start)).slice(0, 14);
  const missing = finished.filter((s) => s.feedback_missing).length;
  const totalUnpaid = d.unpaid.reduce((a, u) => a + u.amount_millimes, 0);
  const setStatus = sessionStatus(sessions, load);
  const alerts = (summary?.pending ?? 0) + (summary?.to_notify ?? 0);

  const weeks = Array.from({ length: 8 }, (_, i) => weekStart(new Date(Date.now() - (7 - i) * 7 * 86400000).toISOString()));
  const chart = weeks.map((w) => ({
    label: new Date(w + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "numeric", timeZone: "UTC" }),
    value: metric === "hours"
      ? sessions.filter((s) => s.status === "effectuee" && weekStart(s.start) === w).reduce((a, s) => a + s.duration_min, 0) / 60
      : pays.filter((p) => weekStart(p.paid_at) === w).reduce((a, p) => a + p.amount_millimes, 0) / 1000,
  }));

  return (
    <>
      <div className="hero">
        <div className="hero-top">{dayLabel(now.toISOString())}</div>
        <h1>Bonjour coach</h1>
        {todayAll.length === 0 ? (
          <div className="next">Aucune séance aujourd'hui. Profitez-en.</div>
        ) : (
          <div className="next">
            <div className="row">
              <b style={{ fontSize: "1.15rem" }}>{todayAll.length} séance{todayAll.length > 1 ? "s" : ""} aujourd'hui</b>
              <span>{dur(hoursToday)}</span>
            </div>
            <div className="bar light"><div style={{ width: `${(done / todayAll.length) * 100}%` }} /></div>
            <div className="row" style={{ marginTop: 6, fontSize: ".9rem", opacity: 0.9 }}>
              <span>{done}/{todayAll.length} terminée{done > 1 ? "s" : ""}</span>
              <span>≈ {tnd(expected)}</span>
            </div>
          </div>
        )}
      </div>

      {alerts > 0 && (
        <button className="alert red" onClick={() => go("requests")}>
          <span className="alert-ico"><Icon name="bell" size={20} /></span>
          <span className="alert-txt">
            <b>{alerts} élément{alerts > 1 ? "s" : ""} à traiter</b>
            <small>
              {summary.pending > 0 && `${summary.pending} demande${summary.pending > 1 ? "s" : ""} de réservation`}
              {summary.pending > 0 && summary.to_notify > 0 && " · "}
              {summary.to_notify > 0 && `${summary.to_notify} confirmation${summary.to_notify > 1 ? "s" : ""} à envoyer`}
            </small>
          </span>
          <Icon name="chevR" size={20} />
        </button>
      )}

      {settings && playersLoaded && <Onboarding settings={settings} players={players} go={go} />}
      <InstallCard />

      {focus && (() => {
        const ph = phase(focus, now);
        const ps = focus.player_ids.map(byId).filter(Boolean);
        return (
          <div className={"focus " + ph.key}>
            <div className="row">
              <span className="pill">{ph.key === "live" ? "● En cours" : ph.key === "validate" ? "À valider" : "Prochaine séance"}</span>
              <span>{ph.label}</span>
            </div>
            <div className="time" style={{ fontSize: "1.7rem", margin: "6px 0 2px" }}>{hhmm(focus.start)} <span style={{ opacity: 0.7, fontSize: "1rem" }}>→ {hhmm(endOf(focus).toISOString())}</span></div>
            <div style={{ opacity: 0.9 }}>{KIND[focus.kind]?.label}{focus.club && ` · ${focus.club}`}</div>
            <div className="row" style={{ marginTop: 10, justifyContent: "flex-start", flexWrap: "wrap" }}>
              {ps.map((p) => (
                <button key={p.id} className="who-btn" onClick={() => openPlayer(p.id)}><Avatar name={p.name} size={28} />{p.name.split(" ")[0]}</button>
              ))}
            </div>
            {ps[0] && <div className="actions"><a className="btnlink light" href={`tel:${ps[0].phone}`}><Icon name="phone" size={16} /> Appeler</a><button className="small light" onClick={() => setStatus(focus.id, "effectuee")}><Icon name="check" size={15} /> Terminée</button></div>}
          </div>
        );
      })()}

      {toDo.length > 0 && <h2>Reste à faire aujourd'hui</h2>}
      {toDo.length === 0 && todayAll.length > 0 && <div className="card empty"><Icon name="checkCircle" size={28} /><b>Toutes les séances du jour sont terminées</b></div>}
      <div className="timeline">
        {toDo.map((s) => {
          const ph = phase(s, now);
          return (
            <div className={"tl " + ph.key} key={s.id}>
              <div className="tl-time"><b>{hhmm(s.start)}</b><span className="mut">{dur(s.duration_min)}</span></div>
              <div className="tl-dot" style={{ background: KIND[s.kind]?.color }} />
              <div className="card tl-card">
                <div className="row">
                  <b>{s.player_ids.map(name).join(", ") || "Sans joueur"}</b>
                  <span className={"chip-state " + ph.key}>{ph.label}</span>
                </div>
                <div className="mut">{KIND[s.kind]?.label}{s.club && ` · ${s.club}`}</div>
                {s.court_status && <span className={"court-badge " + COURT_STATUS[s.court_status].cls}><Icon name="pin" size={12} /> {COURT_STATUS[s.court_status].label}</span>}
                <div className="actions">
                  <button className="small" onClick={() => setStatus(s.id, "effectuee")}><Icon name="check" size={15} /> Effectuée</button>
                  <button className="small sec" onClick={() => setStatus(s.id, "annulee")}>Annuler</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {finished.length > 0 && (
        <>
          <h2>Séances terminées{missing > 0 && <span className="red"> · {missing} à noter</span>}</h2>
          <div className="donestrip">
            {finished.map((s) => (
              <button key={s.id} className={"donechip" + (openDone === s.id ? " on" : "")} onClick={() => setOpenDone(openDone === s.id ? null : s.id)}>
                {s.feedback_missing && <i className="todo" />}
                <AvatarStack names={s.player_ids.map(name)} size={24} />
                <b>{hhmm(s.start)}</b>
                <small>{shortDate(s.start)}</small>
              </button>
            ))}
          </div>
          {openDone && finished.find((s) => s.id === openDone) && (
            <DonePanel s={finished.find((s) => s.id === openDone)} name={name} strokes={strokes} onSaved={load} onClose={() => setOpenDone(null)} />
          )}
        </>
      )}

      <h2>Vue d'ensemble</h2>
      <div className="grid kpis">
        <div className="kpi"><span className="ico"><Icon name="clock" size={18} /></span><div className="big">{d.hours.week} h</div><div className="mut">Cette semaine</div></div>
        <div className="kpi"><span className="ico"><Icon name="wallet" size={18} /></span><div className="big sm">{tnd(d.revenue_millimes.month)}</div><div className="mut">Encaissé ce mois</div></div>
        <div className="kpi"><span className="ico"><Icon name="calendar" size={18} /></span><div className="big">{d.upcoming_count}</div><div className="mut">Séances à venir</div></div>
        <div className="kpi"><span className="ico warn"><Icon name="alert" size={18} /></span><div className="big sm red">{tnd(totalUnpaid)}</div><div className="mut">Impayés</div></div>
      </div>

      <div className="card">
        <div className="row">
          <b>Activité</b>
          <div className="seg mini">
            <button className={metric === "hours" ? "on" : ""} onClick={() => setMetric("hours")}>Heures</button>
            <button className={metric === "money" ? "on" : ""} onClick={() => setMetric("money")}>Revenus</button>
          </div>
        </div>
        <div className="mut">8 dernières semaines</div>
        {chart.every((c) => !c.value) ? <div className="empty"><Icon name="calendar" size={26} /><div>Vos heures et revenus apparaîtront ici après vos premières séances.</div></div> : <BarChart data={chart} format={(v) => (metric === "hours" ? `${Math.round(v * 10) / 10}h` : Math.round(v))} color={metric === "hours" ? "var(--brand)" : "var(--green)"} />}
      </div>

      {d.unpaid.length > 0 && <h2>À relancer</h2>}
      {d.unpaid.slice(0, 3).map((u) => <UnpaidRow key={u.player_id} u={u} openPlayer={openPlayer} go={go} onPaid={load} />)}
    </>
  );
}
