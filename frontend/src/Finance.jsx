import { useEffect, useState } from "react";
import { api, dayLabel, peek, tnd, useLive } from "./api.js";
import Icon from "./Icon.jsx";
import { Modal, toast, toastError } from "./feedback.jsx";
import { Avatar, BarChart, byWeek, CategoryBadge, ContactLinks, DateSelect, Loading, METHOD, MoneyInput } from "./ui.jsx";

// Onglet Finance du coach: ce que les joueurs lui doivent (le plus important), ce qu'il a gagné et encaissé,
// les crédits d'avance, et le journal des versements. Tout l'argent se saisit ici: « X m'a donné tant ».
const TZ = "Africa/Tunis";
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Mois entier de la date « AAAA-MM-JJ »: du 1er au dernier jour
export const monthRange = (t) => {
  const last = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0)).getUTCDate();
  return [t.slice(0, 8) + "01", t.slice(0, 8) + String(last).padStart(2, "0")];
};

function range(kind) {
  const today = new Date(), t = ymd(today);
  if (kind === "week") {
    const wd = (new Date(t + "T12:00:00Z").getUTCDay() + 6) % 7;
    return [ymd(addDays(today, -wd)), ymd(addDays(today, 6 - wd))]; // lundi → dimanche
  }
  if (kind === "last") {
    const first = new Date(t.slice(0, 8) + "01T12:00:00Z");
    const end = addDays(first, -1);
    return [ymd(end).slice(0, 8) + "01", ymd(end)];
  }
  if (kind === "year") return [t.slice(0, 5) + "01-01", t];
  return monthRange(t); // ce mois, en entier (les semaines à venir restent vides sur le graphe)
}

const dayName = (key) => new Date(key + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", timeZone: "UTC" }).replace(".", "");
const label = (key, group) => {
  if (group === "month") return new Date(key + "-15T12:00:00Z").toLocaleDateString("fr-FR", { month: "short", timeZone: "UTC" }).replace(".", "");
  const d = new Date(key + "T12:00:00Z");
  return group === "week" ? d.toLocaleDateString("fr-FR", { day: "numeric", month: "numeric", timeZone: "UTC" }) : String(d.getUTCDate());
};

// « X m'a donné de l'argent »: devient des crédits chez ce coach, qui règlent d'abord ce qu'il doit
function PaymentForm({ players, initial, onClose, onDone }) {
  const [f, setF] = useState({ player_id: initial?.player_id ?? "", amount: initial?.amount ?? 0, method: "especes" });
  const [busy, setBusy] = useState(false);
  const p = players.find((x) => x.id === +f.player_id);
  const save = async (e) => {
    e.preventDefault();
    if (!f.player_id || !f.amount) return toastError(new Error("Choisissez le joueur et le montant reçu."));
    setBusy(true);
    try {
      await api(`/players/${f.player_id}/credits`, { method: "POST", body: { amount_millimes: f.amount, method: f.method } });
      toast(`${tnd(f.amount)} reçus de ${p?.name.split(" ")[0] ?? "ce joueur"}`);
      onDone();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Argent reçu">
      <form onSubmit={save}>
        <div className="row"><b className="sheet-title">Argent reçu</b><button type="button" className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
        <p className="mut small-p">Le montant règle d'abord ce que le joueur vous doit ; le reste devient des crédits d'avance pour ses prochaines séances.</p>
        <label className="field"><span className="mut">Joueur</span>
          <select value={f.player_id} onChange={(e) => setF({ ...f, player_id: e.target.value })} required>
            <option value="">Choisir un joueur…</option>
            {players.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <div className="grid">
          <label className="field"><span className="mut">Montant (TND)</span><MoneyInput label="Montant reçu (TND)" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></label>
          <label className="field"><span className="mut">Moyen</span>
            <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="especes">Espèces</option><option value="virement">Virement</option></select>
          </label>
        </div>
        <button style={{ width: "100%" }} disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</button>
      </form>
    </Modal>
  );
}

function UnpaidCard({ u, onCash, openPlayer }) {
  const [remind, setRemind] = useState(false);
  const due = -u.balance_millimes;
  return (
    <div className="card">
      <div className="row">
        <button className="row g10 plain" onClick={() => openPlayer(u.player_id)}>
          <Avatar name={u.name} size={36} />
          <span><b>{u.name}</b> <CategoryBadge category={u.category} gender={u.gender} /><span className="red" style={{ display: "block" }}>{tnd(due)} dû</span></span>
        </button>
        <div className="row" style={{ gap: 6, flex: "none" }}>
          <button className="small" onClick={() => onCash(u, due)}>Encaisser</button>
          <button className="small sec iconbtn" aria-label={`Relancer ${u.name}`} aria-expanded={remind} onClick={() => setRemind(!remind)}><Icon name="send" size={15} /></button>
        </div>
      </div>
      {remind && <ContactLinks phone={u.phone} email={u.email} subject="Rappel de paiement"
        message={`Bonjour ${u.name.split(" ")[0]}, petit rappel : il reste ${tnd(due)} à régler pour vos séances de padel. Merci !`} />}
    </div>
  );
}

export default function Finance({ openPlayer }) {
  const [period, setPeriod] = useState("month");
  const [custom, setCustom] = useState(range("month"));
  const [start, end] = period === "custom" ? custom : range(period);
  const url = `/finance?start=${start}&end=${end}`;
  const [f, setF] = useState(() => peek(url) ?? null);
  const [players, setPlayers] = useState(() => peek("/players") ?? []);
  const [metric, setMetric] = useState("earned");
  const [paying, setPaying] = useState(null); // null, {} (nouveau versement) ou { player_id, amount }
  const load = () => { api(url).then(setF).catch(toastError); api("/players").then(setPlayers).catch(() => {}); };
  useEffect(() => { setF(peek(url) ?? null); load(); }, [url]);
  useLive(load);

  const journal = {};
  (f?.journal ?? []).forEach((j) => (journal[j.paid_at.slice(0, 10)] ||= []).push(j));
  const pick = (x) => (metric === "hours" ? x.hours : (metric === "earned" ? x.earned_millimes : x.cashed_millimes) / 1000);
  // Axe lisible: une semaine (≤ 7 jours) = un jour par colonne (« lun » + « 2 »); un mois = une colonne par semaine
  // (« S1 » + « 1–7 »); plus long = semaines (date du lundi) ou mois (« nov »)
  const raw = f?.series ?? [];
  const series = !f ? [] : f.group === "day" && raw.length > 7 ? byWeek(raw, pick)
    : raw.map((x) => ({ label: f.group === "day" ? dayName(x.key) : label(x.key, f.group), sub: f.group === "day" ? String(+x.key.slice(8, 10)) : undefined,
      value: Math.round(pick(x) * 10) / 10, current: f.group === "day" && x.key === ymd(new Date()) }));
  const unit = !f ? "" : f.group === "day" ? (raw.length > 7 ? "Une colonne par semaine (S1 = 7 premiers jours de la période)" : "Une colonne par jour")
    : f.group === "week" ? "Une colonne par semaine (date du lundi)" : "Une colonne par mois";
  return (
    <>
      <h1 style={{ margin: 0 }}>Finance</h1>
      <button style={{ width: "100%", marginTop: 10 }} onClick={() => setPaying({})}><Icon name="plus" size={16} /> Argent reçu</button>

      <div className="seg mini" style={{ margin: "10px 0" }}>
        {[["week", "Semaine"], ["month", "Ce mois"], ["last", "Mois dernier"], ["year", "Année"], ["custom", "Dates"]].map(([k, l]) => (
          <button key={k} className={period === k ? "on" : ""} onClick={() => setPeriod(k)}>{l}</button>
        ))}
      </div>
      {period === "custom" && (
        <div className="grid" style={{ marginBottom: 8 }}>
          <label className="field"><span className="mut">Du</span><DateSelect label="Début de la période" value={custom[0]} from={-730} to={0} onChange={(v) => setCustom([v, v > custom[1] ? v : custom[1]])} /></label>
          <label className="field"><span className="mut">Au</span><DateSelect label="Fin de la période" value={custom[1]} from={-730} to={0} onChange={(v) => setCustom([custom[0] > v ? v : custom[0], v])} /></label>
        </div>
      )}

      {!f ? <Loading rows={3} /> : (
        <>
          {/* Le plus important: qui doit combien, maintenant */}
          <div className={"card fin-due " + (f.unpaid_total_millimes ? "bad" : "good")}>
            <div className="row">
              <div><div className="mut">Impayés (aujourd'hui)</div><div className="big">{f.unpaid_total_millimes ? tnd(f.unpaid_total_millimes) : "Tout est réglé"}</div></div>
              <Icon name={f.unpaid_total_millimes ? "alert" : "checkCircle"} size={28} />
            </div>
            {f.unpaid.length > 0 && <div className="mut small-p">{f.unpaid.length} joueur{f.unpaid.length > 1 ? "s" : ""} · détail ci-dessous</div>}
          </div>

          <div className="grid kpis">
            <div className="kpi"><span className="ico ok"><Icon name="trophy" size={18} /></span><div className="big sm">{tnd(f.earned_millimes)}</div><div className="mut">Gagné ({f.sessions} séance{f.sessions > 1 ? "s" : ""})</div></div>
            <div className="kpi"><span className="ico"><Icon name="wallet" size={18} /></span><div className="big sm">{tnd(f.cashed_millimes)}</div><div className="mut">Argent reçu</div></div>
            <div className="kpi"><span className="ico"><Icon name="clock" size={18} /></span><div className="big">{f.hours} h</div><div className="mut">Heures de cours</div></div>
            <div className="kpi"><span className="ico"><Icon name="card" size={18} /></span><div className="big sm">{tnd(f.credits_total_millimes)}</div><div className="mut">Crédits d'avance</div></div>
          </div>

          <div className="card">
            <div className="row">
              <b>{{ earned: "Gagné", cashed: "Argent reçu", hours: "Heures" }[metric]}</b>
              <div className="seg mini">
                {[["earned", "Gagné"], ["cashed", "Reçu"], ["hours", "Heures"]].map(([k, l]) => <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{l}</button>)}
              </div>
            </div>
            {series.every((x) => !x.value) ? <div className="empty mut">Rien sur cette période.</div>
              : <BarChart data={series.map((x, i) => ({ ...x, label: series.length > 12 && i % Math.ceil(series.length / 8) ? "" : x.label }))}
                format={(v) => (series.length > 12 ? "" : metric === "hours" ? `${String(v).replace(".", ",")} h` : `${Math.round(v)} DT`)} color={metric === "cashed" ? "var(--brand)" : "var(--green)"} />}
            <div className="mut small-p center">{unit} · gagné = valeur des séances effectuées, reçu = argent versé par les joueurs</div>
          </div>

          <h2>Impayés{f.unpaid.length > 0 && ` · ${f.unpaid.length}`}</h2>
          {f.unpaid.length === 0 && <div className="card empty"><Icon name="checkCircle" size={26} /><b>Aucun impayé</b></div>}
          {f.unpaid.map((u) => <UnpaidCard key={u.player_id} u={u} openPlayer={openPlayer} onCash={(x, due) => setPaying({ player_id: x.player_id, amount: due })} />)}

          {f.credits.length > 0 && (
            <>
              <h2>Crédits d'avance · {f.credits.length}</h2>
              <div className="card">
                {f.credits.map((c) => (
                  <button key={c.player_id} className="row plain fin-line" onClick={() => openPlayer(c.player_id)}>
                    <span>{c.name}</span><b className="green-txt">{tnd(c.balance_millimes)}</b>
                  </button>
                ))}
              </div>
            </>
          )}

          <h2>Argent reçu sur la période</h2>
          {Object.keys(journal).length === 0 && <div className="card mut">Aucun versement sur cette période.</div>}
          {Object.entries(journal).map(([day, items]) => (
            <div className="card" key={day}>
              <div className="row"><b className="cap1">{dayLabel(items[0].paid_at)}</b><b>{tnd(items.reduce((a, j) => a + j.amount_millimes, 0))}</b></div>
              {items.map((j) => (
                <button key={j.id} className="row plain fin-line" onClick={() => openPlayer(j.player_id)}>
                  <span>{j.name} <span className="mut small-p">· {METHOD[j.method] ?? j.method}</span></span><span>{tnd(j.amount_millimes)}</span>
                </button>
              ))}
            </div>
          ))}
        </>
      )}
      {paying && <PaymentForm players={players} initial={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />}
    </>
  );
}
