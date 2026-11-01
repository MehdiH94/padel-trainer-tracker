import { useEffect, useState } from "react";
import { api, dayLabel, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import { Avatar, CategoryBadge, KIND, Loading } from "./ui.jsx";

// Couleur de chaque partie de la séance (même code couleur sur la frise et dans la liste)
const PART = {
  echauffement: { label: "Échauffement", cls: "warm" },
  exercice: { label: "Exercice", cls: "work" },
  jeu: { label: "Jeu", cls: "game" },
  retour: { label: "Retour au calme", cls: "cool" },
};
const Dots = ({ score }) => <span className="mini-dots" aria-label={`${score} sur 5`}>{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= score ? "on s" + score : ""} />)}</span>;

// Frise de la séance: un bloc par exercice, largeur proportionnelle à sa durée
function Timeline({ plan }) {
  return (
    <div className="plan-bar" role="img" aria-label={`Séance de ${plan.duration_min} minutes en ${plan.items.length} parties`}>
      {plan.items.map((it, i) => (
        <div key={i} className={"plan-seg " + PART[it.kind].cls} style={{ flexGrow: it.duration_min }}>
          <b>{it.duration_min}'</b><span>{it.kind === "exercice" ? it.theme : PART[it.kind].label}</span>
        </div>
      ))}
    </div>
  );
}

export default function SessionPlan({ sub, go, onBack }) {
  const id = +sub;
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState("reco"); // reco = recommandation / manual = thèmes choisis par le coach
  const [picked, setPicked] = useState([]);
  const [plan, setPlan] = useState(null);
  const [saved, setSaved] = useState(false);
  const [seed, setSeed] = useState(1);
  useEffect(() => {
    api(`/sessions/${id}/plan`).then((d) => {
      setInfo(d);
      setPicked(d.recommended);
      if (!d.recommended.length) setMode("manual");
      if (d.plan) { setPlan(d.plan); setSaved(true); }
    }).catch(toastError);
  }, [id]);
  if (!info) return <><button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button><Loading rows={3} /></>;

  const s = info.session;
  const themes = mode === "reco" ? info.recommended : picked;
  const toggle = (t) => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : picked.length >= 3 ? [...picked.slice(1), t] : [...picked, t]);
  const draw = async (nextSeed = seed) => {
    try {
      setPlan(await api(`/sessions/${id}/plan/generate`, { method: "POST", body: { themes, seed: nextSeed } }));
      setSaved(false);
    } catch (x) {
      toastError(x);
    }
  };
  const another = () => { const n = seed + 1; setSeed(n); draw(n); };
  const save = () => api(`/sessions/${id}/plan`, { method: "PUT", body: plan }).then(() => { setSaved(true); toast("Plan de séance enregistré"); }).catch(toastError);
  const weakCount = info.players.filter((p) => p.weak.length).length;

  return (
    <>
      <button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button>
      <h1 style={{ marginTop: 10 }}>Préparer la séance</h1>
      <p className="mut" style={{ marginTop: -6 }}>
        <span style={{ textTransform: "capitalize" }}>{dayLabel(s.start)}</span> · {hhmm(s.start)} · {s.duration_min} min · {KIND[s.kind].label}{s.club && ` · ${s.club}`}
      </p>

      <h2>Points faibles des joueurs</h2>
      {!info.players.length && <div className="card mut">Aucun joueur inscrit : le plan sera fait pour une séance {KIND[s.kind].label.toLowerCase()}.</div>}
      {info.players.map((p) => (
        <div className="card" key={p.id}>
          <div className="row g10"><Avatar name={p.name} size={34} /><b style={{ flex: 1 }}>{p.name}</b><CategoryBadge category={p.category} gender={p.gender} /></div>
          {p.weak.length > 0 ? (
            <div className="weak-list">{p.weak.map((w) => <span key={w.theme} className="weak">{w.theme} <Dots score={w.score} /></span>)}</div>
          ) : (
            <div className="mut small-p" style={{ marginTop: 6 }}>{p.rated ? "Pas de point faible noté." : "Pas encore d'évaluation technique (fiche joueur › Padel)."}</div>
          )}
          {p.to_improve.length > 0 && <div className="mut small-p" style={{ marginTop: 6 }}><Icon name="target" size={13} /> À retravailler : {p.to_improve.join(" · ")}</div>}
        </div>
      ))}

      <h2>Thèmes de la séance</h2>
      <div className="seg" style={{ marginBottom: 10 }}>
        <button className={mode === "reco" ? "on" : ""} disabled={!info.recommended.length} onClick={() => setMode("reco")}><Icon name="sparkles" size={15} /> Recommandés</button>
        <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}><Icon name="edit" size={15} /> Je choisis</button>
      </div>
      {mode === "reco" ? (
        <div className="card">
          <div className="chips">{info.recommended.map((t) => <span key={t} className="theme big-theme">{t}</span>)}</div>
          <div className="mut small-p" style={{ marginTop: 8 }}>D'après les points faibles de {weakCount} joueur{weakCount > 1 ? "s" : ""} et les notes « à retravailler ».</div>
        </div>
      ) : (
        <div className="card">
          <div className="mut small-p" style={{ marginBottom: 8 }}>Jusqu'à 3 thèmes.</div>
          <div className="chips">{info.themes.map((t) => <button key={t} className={"chip small" + (picked.includes(t) ? " on" : "")} aria-pressed={picked.includes(t)} onClick={() => toggle(t)}>{t}</button>)}</div>
        </div>
      )}
      <button style={{ width: "100%" }} disabled={!themes.length} onClick={() => draw()}><Icon name="sparkles" size={17} /> {plan ? "Redessiner la séance" : "Dessiner la séance"}</button>

      {plan && (
        <>
          <h2>Ma séance · {plan.duration_min} min · {plan.players} joueur{plan.players > 1 ? "s" : ""}</h2>
          <Timeline plan={plan} />
          <div className="plan-list">
            {plan.items.map((it, i) => (
              <div key={i} className={"card plan-item " + PART[it.kind].cls}>
                <div className="plan-time"><b>{it.start_min}'</b><span>{it.duration_min} min</span></div>
                <div style={{ flex: 1 }}>
                  <div className="mut small-p">{it.kind === "exercice" ? it.theme : PART[it.kind].label}</div>
                  <b>{it.name}</b>
                  {it.description && <div className="exo-desc">{it.description}</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="actions">
            <button className="sec" onClick={another}><Icon name="repeat" size={16} /> Autre proposition</button>
            <button onClick={save} disabled={saved}>{saved ? <><Icon name="check" size={16} /> Enregistré</> : "Enregistrer le plan"}</button>
          </div>
        </>
      )}
      <button className="link center" style={{ marginTop: 14 }} onClick={() => go("exercises")}><Icon name="ball" size={15} /> Bibliothèque d'exercices</button>
    </>
  );
}
