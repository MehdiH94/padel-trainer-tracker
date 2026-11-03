import { useEffect, useState } from "react";
import { api, peek } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { Loading } from "./ui.jsx";

const players = (e) => (e.min_players === e.max_players ? `${e.min_players} joueur${e.min_players > 1 ? "s" : ""}` : `${e.min_players} à ${e.max_players} joueurs`);

export function ExerciseCard({ e, onEdit, onDelete }) {
  return (
    <div className="card exo">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div>
          <b>{e.name}</b>
          <div className="mut small-p">{players(e)} · {e.duration_min} min {e.mine ? "· mon exercice" : "· proposé par l'appli"}</div>
        </div>
        {e.mine && onEdit && (
          <div className="row" style={{ gap: 6 }}>
            <button className="small sec iconbtn" aria-label={`Modifier ${e.name}`} onClick={() => onEdit(e)}><Icon name="edit" size={14} /></button>
            <button className="small sec iconbtn danger" aria-label={`Supprimer ${e.name}`} onClick={() => onDelete(e)}><Icon name="trash" size={14} /></button>
          </div>
        )}
      </div>
      <div className="chips" style={{ margin: "6px 0" }}>{e.themes.map((t) => <span key={t} className="theme">{t}</span>)}</div>
      {e.description && <div className="exo-desc">{e.description}</div>}
    </div>
  );
}

function ExerciseForm({ exo, themes, onDone, onClose }) {
  const [f, setF] = useState(exo ?? { name: "", description: "", themes: [], min_players: 1, max_players: 4, duration_min: 15 });
  const [err, setErr] = useState("");
  const toggle = (t) => setF({ ...f, themes: f.themes.includes(t) ? f.themes.filter((x) => x !== t) : [...f.themes, t] });
  async function save(e) {
    e.preventDefault();
    if (!f.themes.length) return setErr("Choisissez au moins un thème.");
    try {
      await api(exo ? `/exercises/${exo.id}` : "/exercises", { method: exo ? "PUT" : "POST", body: f });
      toast(exo ? "Exercice modifié" : "Exercice ajouté à votre bibliothèque");
      onDone();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal onClose={onClose} label={exo ? "Modifier l'exercice" : "Nouvel exercice"}>
      <form onSubmit={save}>
        <b className="sheet-title">{exo ? "Modifier l'exercice" : "Nouvel exercice"}</b>
        <label className="field"><span className="mut">Nom</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label className="field"><span className="mut">Déroulement</span><textarea className="msg" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Placement, consignes, comptage des points…" /></label>
        <div className="field"><span className="mut">Thèmes travaillés</span>
          <div className="chips">{themes.map((t) => <button type="button" key={t} className={"chip small" + (f.themes.includes(t) ? " on" : "")} aria-pressed={f.themes.includes(t)} onClick={() => toggle(t)}>{t}</button>)}</div>
        </div>
        <div className="grid">
          <label className="field"><span className="mut">Joueurs min.</span><select value={f.min_players} onChange={(e) => setF({ ...f, min_players: +e.target.value, max_players: Math.max(+e.target.value, f.max_players) })}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label className="field"><span className="mut">Joueurs max.</span><select value={f.max_players} onChange={(e) => setF({ ...f, max_players: +e.target.value })}>{[1, 2, 3, 4].filter((n) => n >= f.min_players).map((n) => <option key={n}>{n}</option>)}</select></label>
        </div>
        <label className="field"><span className="mut">Durée conseillée</span><select value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: +e.target.value })}>{[5, 10, 15, 20, 25, 30].map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="actions"><button type="button" className="sec" onClick={onClose}>Annuler</button><button>Enregistrer</button></div>
      </form>
    </Modal>
  );
}

export default function Exercises({ onBack }) {
  const [list, setList] = useState(() => peek("/exercises") ?? null); // dernier passage affiché tout de suite
  const [themes, setThemes] = useState(() => peek("/exercise-themes") ?? { work: [], all: [] });
  const [theme, setTheme] = useState("all");
  const [onlyMine, setOnlyMine] = useState(false);
  const [q, setQ] = useState("");
  const [form, setForm] = useState(null); // null, "new" ou l'exercice modifié
  const load = () => api("/exercises").then(setList).catch(toastError);
  useEffect(() => { load(); api("/exercise-themes").then(setThemes); }, []);
  const remove = async (e) => {
    if (!(await confirmDialog({ title: `Supprimer « ${e.name} » ?`, confirm: "Supprimer", danger: true }))) return;
    api(`/exercises/${e.id}`, { method: "DELETE" }).then(() => { toast("Exercice supprimé"); load(); }).catch(toastError);
  };
  const shown = (list ?? []).filter((e) => (theme === "all" || e.themes.includes(theme)) && (!onlyMine || e.mine) && (e.name + " " + e.description).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button>
      <h1 style={{ marginTop: 10 }}>Exercices</h1>
      <p className="mut" style={{ marginTop: -6 }}>Les idées proposées par l'appli et les vôtres. Elles servent à dessiner vos séances.</p>
      <div className="searchbox"><Icon name="search" size={18} /><input placeholder="Rechercher un exercice…" aria-label="Rechercher un exercice" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="chips" style={{ marginBottom: 10 }}>
        <button className={"chip small" + (onlyMine ? " on" : "")} aria-pressed={onlyMine} onClick={() => setOnlyMine(!onlyMine)}><Icon name="user" size={13} /> Mes exercices</button>
        <span className="vsep" />
        <button className={"chip small" + (theme === "all" ? " on" : "")} onClick={() => setTheme("all")}>Tous</button>
        {themes.all.map((t) => <button key={t} className={"chip small" + (theme === t ? " on" : "")} onClick={() => setTheme(t)}>{t}</button>)}
      </div>
      {list === null && <Loading rows={3} />}
      {shown.map((e) => <ExerciseCard key={e.id} e={e} onEdit={setForm} onDelete={remove} />)}
      {list && !shown.length && <div className="card empty"><Icon name="search" size={26} /><b>Aucun exercice</b><div>Ajoutez le vôtre avec le bouton « Exercice ».</div></div>}
      <button className="fab" onClick={() => setForm("new")}><Icon name="plus" size={18} /> Exercice</button>
      {form && <ExerciseForm exo={form === "new" ? null : form} themes={themes.all} onClose={() => setForm(null)} onDone={() => { setForm(null); load(); }} />}
    </>
  );
}
