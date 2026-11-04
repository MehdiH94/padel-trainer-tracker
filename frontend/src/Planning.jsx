import { useEffect, useMemo, useState } from "react";
import { api, dayKey, hhmm, peek, useLive } from "./api.js";
import Icon from "./Icon.jsx";
import CourtCalendar, { offOn } from "./CourtCalendar.jsx";
import { ManualForm } from "./Courts.jsx";
import InvitePlayers from "./InvitePlayers.jsx";
import { confirmDialog, toast, toastError } from "./feedback.jsx";
import SessionCard from "./SessionCard.jsx";
import SessionForm from "./SessionForm.jsx";
import SessionPayments, { PaySummary } from "./SessionPayments.jsx";
import { duplicateNextWeek, sessionStatus } from "./sessionActions.js";
import { DateSelect, KIND, Loading, PlayerTags } from "./ui.jsx";

const TZ = "Africa/Tunis";
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const mondayOf = (d) => addDays(d, -((new Date(ymd(d) + "T12:00:00Z").getUTCDay() + 6) % 7));
const MAX_WEEKS = 13; // on peut regarder jusqu'à 3 mois à l'avance

// Absence du coach (vacances, jour non travaillé): aucun créneau n'est proposé aux joueurs ces jours-là
function TimeOffForm({ onCancel, onDone }) {
  const today = ymd(new Date());
  const [f, setF] = useState({ start_date: today, end_date: today, reason: "" });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api("/time-off", { method: "POST", body: { ...f, end_date: f.end_date < f.start_date ? f.start_date : f.end_date } });
      toast(r.sessions_during ? `Absence ajoutée. Attention : ${r.sessions_during} séance${r.sessions_during > 1 ? "s" : ""} déjà prévue${r.sessions_during > 1 ? "s" : ""} pendant ces jours.` : "Absence ajoutée : aucun créneau ne sera proposé ces jours-là");
      onDone();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={save}>
      <h3 style={{ margin: "0 0 10px" }}>Absence</h3>
      <div className="grid">
        <label className="field"><span className="mut">Du</span><DateSelect label="Premier jour" value={f.start_date} to={365} onChange={(v) => setF({ ...f, start_date: v, end_date: f.end_date < v ? v : f.end_date })} /></label>
        <label className="field"><span className="mut">Au (inclus)</span><DateSelect label="Dernier jour" value={f.end_date} to={365} onChange={(v) => setF({ ...f, end_date: v })} /></label>
      </div>
      <label className="field"><span className="mut">Raison (facultatif)</span><input value={f.reason} maxLength={120} placeholder="ex. Vacances, tournoi, formation…" onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
      <p className="mut small-p">Ces jours-là, vos joueurs ne verront aucun créneau pour réserver.</p>
      <div className="actions"><button className="sec" type="button" onClick={onCancel}>Annuler</button><button disabled={busy}>Enregistrer l'absence</button></div>
    </form>
  );
}

export default function Planning({ go, summary }) {
  // dernières données connues tout de suite (peek, voir api.js), mises à jour dès que les nouvelles arrivent
  const [sessions, setSessions] = useState(() => peek("/sessions") ?? null);
  const [players, setPlayers] = useState(() => peek("/players") ?? []);
  const [adding, setAdding] = useState(false);
  const [monday, setMonday] = useState(mondayOf(new Date()));
  const [sel, setSel] = useState(ymd(new Date()));
  const [openDone, setOpenDone] = useState(null);
  const [view, setView] = useState(location.hash.includes("jour") ? "liste" : "calendrier"); // le calendrier est la vue par défaut
  // Calendrier de la semaine: séances et terrains ensemble
  const [courts, setCourts] = useState(() => peek("/court-bookings") ?? []);
  const [clubs, setClubs] = useState(() => peek("/clubs") ?? []);
  const [promos, setPromos] = useState(() => peek("/promotions")?.items ?? []);
  const [offs, setOffs] = useState(() => peek("/time-off") ?? []); // absences du coach
  const [addingOff, setAddingOff] = useState(false);
  const [inviteFor, setInviteFor] = useState(null); // séance qui vient d'être créée: inviter des joueurs
  const [addingCourt, setAddingCourt] = useState(false);
  const [prefill, setPrefill] = useState(null); // « Créer une séance sur ce terrain »
  const load = () => {
    api("/sessions").then(setSessions);
    api("/players").then(setPlayers);
    api("/court-bookings").then(setCourts).catch(() => {});
    api("/clubs").then(setClubs).catch(() => {});
    api("/promotions").then((r) => setPromos(r.items)).catch(() => {});
    api("/time-off").then(setOffs).catch(() => {});
  };
  const removeOff = async (o) => {
    if (!(await confirmDialog({ title: "Supprimer cette absence ?", message: "Vos joueurs pourront de nouveau réserver ces jours-là.", confirm: "Supprimer", danger: true }))) return;
    api(`/time-off/${o.id}`, { method: "DELETE" }).then(() => { toast("Absence supprimée"); load(); }).catch(toastError);
  };
  // Séance créée: avec des places ouvertes, on propose tout de suite d'inviter des joueurs (message à personnaliser)
  const created = (s) => {
    setAdding(false);
    setPrefill(null);
    load();
    if (s && s.open && s.kind !== "individuel" && s.player_ids.length < s.max_players) setInviteFor(s.id);
  };
  const stopPromo = (p) => api(`/promotions/${p.id}`, { method: "DELETE" }).then(() => { toast("Promotion arrêtée"); load(); }).catch(toastError);
  const removeCourt = async (cb) => {
    if (!(await confirmDialog({ title: "Supprimer ce terrain ?", message: "Il ne sera plus proposé pour les réservations.", confirm: "Supprimer", danger: true }))) return;
    api(`/court-bookings/${cb.id}`, { method: "DELETE" }).then(() => { toast("Terrain supprimé"); load(); }).catch(toastError);
  };
  const createAt = (cb) => {
    const t = new Date(cb.start.endsWith("Z") || /[+-]\d\d:\d\d$/.test(cb.start) ? cb.start : cb.start + "Z");
    setPrefill({ date: ymd(t), time: hhmm(cb.start), club_id: String(cb.club_id), court_booked: true, court: cb.court_label || "" });
    setAdding(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  useEffect(load, []);
  useLive(load);

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
  const maxMonday = addDays(mondayOf(new Date()), MAX_WEEKS * 7);
  const shift = (n) => {
    const m = addDays(monday, n * 7);
    if (n > 0 && ymd(m) > ymd(maxMonday)) return; // dates comparées sans l'heure
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
            <Icon name="pin" size={15} /> Mes terrains{summary?.waiting_court > 0 && <b className="pillcount" aria-label={`${summary.waiting_court} en attente`}>{summary.waiting_court}</b>}
          </button>
          <button className="small sec iconbtn" aria-label="Semaine précédente" onClick={() => shift(-1)}><Icon name="chevL" size={16} /></button>
          <button className="small sec" onClick={() => { setMonday(mondayOf(new Date())); setSel(today); }}>Aujourd'hui</button>
          <button className="small sec iconbtn" aria-label="Semaine suivante" disabled={ymd(monday) >= ymd(maxMonday)} onClick={() => shift(1)}><Icon name="chevR" size={16} /></button>
        </div>
      </div>
      <p className="mut cap1" style={{ margin: "6px 0 10px" }}>{monthLabel}</p>

      <div className="seg mini" role="tablist" aria-label="Affichage" style={{ marginBottom: 10 }}>
        <button role="tab" aria-selected={view === "calendrier"} className={view === "calendrier" ? "on" : ""} onClick={() => setView("calendrier")}><Icon name="calendar" size={14} /> Calendrier</button>
        <button role="tab" aria-selected={view === "liste"} className={view === "liste" ? "on" : ""} onClick={() => setView("liste")}><Icon name="list" size={14} /> Jour par jour</button>
      </div>

      {view === "calendrier" && (
        <>
          <div className="row" style={{ gap: 6, justifyContent: "flex-start", marginBottom: 8 }}>
            <button className="small sec" onClick={() => { setAddingCourt(!addingCourt); setAddingOff(false); }}><Icon name="plus" size={15} /> Terrain</button>
            <button className="small sec" onClick={() => { setAddingOff(!addingOff); setAddingCourt(false); }}><Icon name="sun" size={15} /> Absence</button>
          </div>
          {addingCourt && <ManualForm clubs={clubs} onCancel={() => setAddingCourt(false)} onDone={() => { setAddingCourt(false); load(); }} />}
          {addingOff && <TimeOffForm onCancel={() => setAddingOff(false)} onDone={() => { setAddingOff(false); load(); }} />}
          {adding && <SessionForm key={JSON.stringify(prefill)} initial={prefill} players={players} onDone={created} />}
          {sessions === null ? <Loading rows={2} /> : (
            <CourtCalendar list={courts} promos={promos} sessions={sessions} offs={offs} monday={monday} onWeek={setMonday} maxMonday={maxMonday}
              cardProps={{ byId, name, onStatus: setStatus, onDuplicate: duplicate, onPrepare: (x) => go(`session/${x.id}`), onChanged: load }}
              onRemove={removeCourt} onStopPromo={stopPromo} onChanged={load} onCreateAt={createAt} onRemoveOff={removeOff} />
          )}
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

      {adding && <SessionForm players={players} onDone={created} />}
      {offOn(offs, sel) && <div className="note warn" style={{ marginBottom: 8 }}><Icon name="sun" size={15} /> Absent ce jour-là{offOn(offs, sel).reason && ` · ${offOn(offs, sel).reason}`} : aucun créneau n'est proposé aux joueurs.</div>}

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
      {inviteFor && <InvitePlayers sessionId={inviteFor} onClose={() => setInviteFor(null)} onDone={() => { setInviteFor(null); load(); }} />}
      <button className="fab" onClick={() => setAdding(!adding)}>{adding ? <><Icon name="x" size={18} /> Fermer</> : <><Icon name="plus" size={18} /> Séance</>}</button>
    </>
  );
}
