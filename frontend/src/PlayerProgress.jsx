import { useState } from "react";
import { hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { fmt, HOW } from "./PlayerShared.jsx";
import { PlayTime } from "./PlayerPlanning.jsx";
import { averageSkills, MultiRadar, SERIES } from "./ui.jsx";

// Araignées des coachs superposées (une couleur par coach), avec la moyenne en option
export function CoachRadars({ progress, small }) {
  const list = (progress?.by_coach ?? []).filter((c) => c.skills.some((s) => s.score != null));
  const [hidden, setHidden] = useState([]);
  const [avg, setAvg] = useState(false);
  if (!list.length) return null;
  const average = { label: "Moyenne", color: "var(--s-avg)", dashed: true, skills: averageSkills(list) };
  if (small) return <MultiRadar series={[list.length > 1 ? average : { ...list[0], label: list[0].coach_name, color: SERIES[0] }]} size={280} />;
  const series = list.map((c, i) => ({ label: c.coach_name, color: SERIES[i % SERIES.length], skills: c.skills }));
  const shown = [...series.filter((x) => !hidden.includes(x.label)), ...(avg ? [average] : [])];
  const toggle = (l) => setHidden(hidden.includes(l) ? hidden.filter((x) => x !== l) : [...hidden, l]);
  return (
    <>
      <MultiRadar series={shown.length ? shown : [average]} />
      {list.length > 1 && (
        <div className="series-legend" role="group" aria-label="Araignées affichées">
          {series.map((x) => <button key={x.label} className={hidden.includes(x.label) ? "" : "on"} style={{ "--c": x.color }} aria-pressed={!hidden.includes(x.label)} onClick={() => toggle(x.label)}><i /> {x.label}</button>)}
          <button className={avg ? "on" : ""} style={{ "--c": "var(--s-avg)" }} aria-pressed={avg} onClick={() => setAvg(!avg)}><i /> Moyenne</button>
        </div>
      )}
    </>
  );
}

export function Progression({ progress, events }) {
  if (!progress) return null;
  const notes = progress.by_coach.filter((c) => c.notes);
  const played = events.filter((e) => e.result);
  const wins = played.filter((e) => e.result === "victoire").length;
  const rated = progress.by_coach.some((c) => c.skills.some((s) => s.score != null));
  return (
    <>
      <h1>Ma progression</h1>
      {progress.goals && <div className="card"><div className="mut"><Icon name="target" size={14} /> Mon objectif</div><b>{progress.goals}</b></div>}
      <div style={{ marginTop: 12 }}><PlayTime play={progress.play} bare /></div>
      {played.length > 0 && <div className="mut small-p" style={{ marginTop: 8 }}><Icon name="trophy" size={14} /> Matchs et tournois : <b>{wins} victoire{wins > 1 ? "s" : ""}</b> · {played.length - wins} défaite{played.length - wins > 1 ? "s" : ""}</div>}

      <h2>Mon niveau technique</h2>
      {rated && (
        <div className="grid">
          <div className="card good"><b><Icon name="trophy" size={15} /> Points forts</b>{progress.strengths.length ? progress.strengths.map((s) => <div key={s}>• {s}</div>) : <div className="mut">À venir</div>}</div>
          <div className="card bad"><b><Icon name="target" size={15} /> À travailler</b>{progress.weaknesses.length ? progress.weaknesses.map((s) => <div key={s}>• {s}</div>) : <div className="mut">Rien de critique</div>}</div>
        </div>
      )}
      {rated ? <div className="card"><CoachRadars progress={progress} /></div> : <div className="card mut">Votre coach n'a pas encore noté votre jeu : l'araignée apparaîtra après sa première évaluation.</div>}

      {notes.length > 0 && (
        <>
          <h2>Les notes de mes coachs</h2>
          {notes.map((c) => <div key={c.coach_id} className="card"><div className="mut"><Icon name="user" size={13} /> {c.coach_name}</div><div style={{ whiteSpace: "pre-line" }}>{c.notes}</div></div>)}
        </>
      )}
      {progress.last_session && (
        <>
          <h2>Dernier retour de séance</h2>
          <div className="card">
            <div className="mut cap1">{fmt(progress.last_session.start, { weekday: "long", day: "numeric", month: "long" })}</div>
            <div className="chips" style={{ margin: "6px 0" }}>{progress.last_session.worked_on.map((t) => <span key={t} className="chip on small static">{t}</span>)}</div>
            {progress.last_session.note && <div>{progress.last_session.note}</div>}
            {progress.last_session.to_improve && <div className="red">À retravailler : {progress.last_session.to_improve}</div>}
          </div>
        </>
      )}
    </>
  );
}

const WHAT = { recharge: "Crédits ajoutés", remboursement: "Remboursement", ajustement: "Ajustement de prix", correction: "Correction", reservation: "Réservation", seance: "Séance" };

// Crédits: chez chaque coach, et l'historique (ajouts et séances payées), sans bilan financier
export function Credits({ me, credits }) {
  const [coach, setCoach] = useState(null);
  const list = credits.filter((t) => !coach || t.coach_id === coach);
  return (
    <>
      <h1>Crédits</h1>
      {me.wallets.length === 0 && <div className="card mut">Pas encore de coach : vos crédits apparaîtront ici après votre première réservation.</div>}
      {me.wallets.map((w) => (
        <div key={w.coach_id} className="card row">
          <span className="row g10"><Icon name="wallet" size={18} /> <b>{w.coach_name}</b></span>
          {w.due_millimes > 0 ? <b className="red">Vous devez {tnd(w.due_millimes)}</b> : <b>{tnd(w.credits_millimes)}</b>}
        </div>
      ))}
      <div className="mut small-p"><Icon name="card" size={13} /> Pour ajouter des crédits, réglez directement votre coach.</div>

      <h2>Historique</h2>
      {me.wallets.length > 1 && (
        <div className="coach-chips">
          <button className={"chip small" + (!coach ? " on" : "")} onClick={() => setCoach(null)}>Tous</button>
          {me.wallets.map((w) => <button key={w.coach_id} className={"chip small" + (coach === w.coach_id ? " on" : "")} onClick={() => setCoach(w.coach_id)}>{w.coach_name}</button>)}
        </div>
      )}
      {list.length === 0 ? <div className="card mut">Aucun mouvement pour l'instant.</div> : (
        <div className="card">
          {list.map((t) => (
            <div className="txline" key={t.id}>
              <div>
                <b>{t.session ? `Séance du ${fmt(t.session.start, { weekday: "short", day: "numeric", month: "short" })} à ${hhmm(t.session.start)}` : WHAT[t.reason] ?? t.reason}</b>
                <div className="mut">
                  {t.session ? `${HOW[t.session.kind] ?? ""} · ${t.session.duration_min} min · ` : ""}{t.coach_name}
                  {t.session && t.reason !== "seance" && t.reason !== "reservation" ? ` · ${WHAT[t.reason] ?? t.reason}` : ""} · {fmt(t.created_at, { day: "numeric", month: "short" })}
                </div>
              </div>
              <b style={{ color: t.amount_millimes > 0 ? "var(--ok-txt)" : "var(--red)", whiteSpace: "nowrap" }}>{t.amount_millimes > 0 ? "+" : ""}{tnd(t.amount_millimes)}</b>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
