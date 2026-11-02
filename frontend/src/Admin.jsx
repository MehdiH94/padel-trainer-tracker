import { useEffect, useState } from "react";
import { api, dayLabel, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, toast, toastError } from "./feedback.jsx";
import { Avatar, CATEGORIES, CategoryBadge, catOption, Loading } from "./ui.jsx";

// Administrateur: confirme les inscriptions des joueurs (niveau réel, pas de doublon)
function Signup({ s, onDone }) {
  const [cat, setCat] = useState(s.category);
  const [busy, setBusy] = useState(false);
  const act = async (what) => {
    if (what === "refuse" && !(await confirmDialog({ title: `Refuser l'inscription de ${s.name} ?`, message: "Son compte sera fermé (connexion impossible). Sa fiche reste chez son coach, qui pourra lui renvoyer un lien.", confirm: "Refuser", cancel: "Retour", danger: true }))) return;
    setBusy(true);
    try {
      await api(`/admin/signups/${s.id}/${what}`, { method: "POST", body: what === "validate" ? { category: cat } : {} });
      toast(what === "validate" ? `Inscription de ${s.name} confirmée` : "Inscription refusée");
      onDone();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  const changed = s.invited_category && s.invited_category !== s.category;
  return (
    <div className="card">
      <div className="row">
        <div className="row g10"><Avatar name={s.name} size={40} /><div><b>{s.name}</b><div className="mut small-p">Élève de {s.coach_name}</div></div></div>
        <CategoryBadge category={s.category} gender={s.gender} />
      </div>
      <div className="mut small-p" style={{ marginTop: 6 }}>{s.phone} · {s.email}{s.signup_at && <> · inscrit le {dayLabel(s.signup_at)} à {hhmm(s.signup_at)}</>}</div>
      <div className={"note " + (changed ? "warn" : "ok")} style={{ marginTop: 8 }}>
        <Icon name={changed ? "alert" : "checkCircle"} size={15} />{" "}
        {changed ? <>Niveau déclaré <b>{s.category}</b>, le coach avait indiqué <b>{s.invited_category}</b>.</> : <>Niveau {s.category}, identique à celui indiqué par le coach.</>}
      </div>
      {s.duplicates.length > 0 ? (
        <div className="note ko" style={{ marginTop: 8 }}>
          <b><Icon name="users" size={15} /> Doublon possible</b>
          {s.duplicates.map((d) => (
            <div key={d.id} className="small-p">{d.name} · {d.phone} · {d.category} · chez {d.coach_name}{d.has_account ? " · a un compte" : ""} <span className="mut">({d.why.join(", ")})</span></div>
          ))}
        </div>
      ) : <div className="mut small-p" style={{ marginTop: 6 }}><Icon name="checkCircle" size={13} /> Aucun doublon trouvé.</div>}
      <label className="field" style={{ marginTop: 8 }}><span className="mut">Niveau retenu</span>
        <select value={cat} onChange={(e) => setCat(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}</select>
      </label>
      <div className="actions">
        <button className="sec danger" disabled={busy} onClick={() => act("refuse")}><Icon name="x" size={15} /> Refuser</button>
        <button disabled={busy} onClick={() => act("validate")}><Icon name="check" size={15} /> Confirmer{cat !== s.category ? ` en ${cat}` : ""}</button>
      </div>
    </div>
  );
}

export default function Admin({ refreshSummary }) {
  const [list, setList] = useState(null);
  const [status, setStatus] = useState("a_valider");
  const load = () => { api(`/admin/signups?status=${status}`).then(setList).catch(toastError); refreshSummary?.(); };
  useEffect(load, [status]);
  return (
    <>
      <h1 style={{ margin: 0 }}>Inscriptions</h1>
      <p className="mut small-p">Joueurs inscrits par le lien de leur coach : vérifiez le niveau et les doublons.</p>
      <div className="seg mini" style={{ margin: "10px 0" }}>
        {[["a_valider", "À confirmer"], ["validee", "Confirmées"], ["refusee", "Refusées"]].map(([k, l]) => (
          <button key={k} className={status === k ? "on" : ""} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {list === null && <Loading rows={2} />}
      {list?.length === 0 && <div className="card empty"><Icon name="checkCircle" size={28} /><b>Rien à afficher</b></div>}
      {list?.map((s) => status === "a_valider" ? <Signup key={s.id} s={s} onDone={load} /> : (
        <div className="card row" key={s.id}>
          <div><b>{s.name}</b><div className="mut small-p">Élève de {s.coach_name} · {s.phone}</div></div>
          <CategoryBadge category={s.category} gender={s.gender} />
        </div>
      ))}
    </>
  );
}
