import { useEffect, useState } from "react";
import { api, dayLabel, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, toast, toastError } from "./feedback.jsx";
import { Avatar, CATEGORIES, CategoryBadge, catOption, Loading, PlayerTag } from "./ui.jsx";

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

function Signups({ refreshSummary }) {
  const [list, setList] = useState(null);
  const [status, setStatus] = useState("a_valider");
  const load = () => { api(`/admin/signups?status=${status}`).then(setList).catch(toastError); refreshSummary?.(); };
  useEffect(load, [status]);
  return (
    <>
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

// Suppression définitive, après confirmation explicite
async function remove(url, title, message, onDone) {
  if (!(await confirmDialog({ title, message, confirm: "Supprimer", cancel: "Retour", danger: true }))) return;
  try {
    await api(url, { method: "DELETE" });
    toast("Supprimé");
    onDone();
  } catch (x) {
    toastError(x);
  }
}

function AdminPlayers({ coaches }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", gender: "M", category: "P100-", coach_id: "" });
  const [link, setLink] = useState(null);
  const load = () => api("/admin/players").then(setList).catch(toastError);
  useEffect(() => { load(); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const add = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/admin/players", { method: "POST", body: { ...f, coach_id: +f.coach_id } });
      setLink(location.origin + r.invite_path);
      setF({ ...f, name: "", phone: "" });
      setAdding(false);
      load();
    } catch (x) {
      toastError(x);
    }
  };
  const shown = (list ?? []).filter((p) => `${p.name} ${p.phone} ${p.email ?? ""} ${p.coach_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <div className="searchbox" style={{ flex: 1, margin: 0 }}><Icon name="search" size={18} /><input placeholder="Nom, téléphone, e-mail, coach…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className="small" onClick={() => setAdding(!adding)}><Icon name={adding ? "x" : "plus"} size={15} /> {adding ? "Fermer" : "Joueur"}</button>
      </div>
      {link && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="row"><b>Lien d'inscription à envoyer</b><button className="small sec iconbtn" aria-label="Fermer" onClick={() => setLink(null)}><Icon name="x" size={15} /></button></div>
          <div className="linkbox"><input readOnly value={link} onFocus={(e) => e.target.select()} /><button className="small" onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Lien copié"))}><Icon name="copy" size={15} /> Copier</button></div>
        </div>
      )}
      {adding && (
        <form className="card" style={{ marginTop: 10 }} onSubmit={add}>
          <label className="field"><span className="mut">Coach</span>
            <select value={f.coach_id} onChange={set("coach_id")} required><option value="">Choisir…</option>{coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <label className="field"><span className="mut">Nom complet</span><input value={f.name} onChange={set("name")} required /></label>
          <label className="field"><span className="mut">Téléphone</span><input inputMode="tel" placeholder="22 123 456" value={f.phone} onChange={set("phone")} required /></label>
          <div className="grid">
            <label className="field"><span className="mut">Genre</span><select value={f.gender} onChange={set("gender")}><option value="M">Homme</option><option value="F">Dame</option></select></label>
            <label className="field"><span className="mut">Niveau</span><select value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}</select></label>
          </div>
          <button style={{ width: "100%" }}>Ajouter le joueur</button>
        </form>
      )}
      <p className="mut small-p">{shown.length} fiche{shown.length > 1 ? "s" : ""} (une par coach pour un même joueur).</p>
      {list === null && <Loading rows={3} />}
      {shown.map((p) => (
        <div className="card row" key={p.id}>
          <div className="row g10" style={{ minWidth: 0 }}>
            <Avatar name={p.name} size={36} />
            <div style={{ minWidth: 0 }}>
              <b><PlayerTag p={p} /></b>
              <div className="mut small-p">Chez {p.coach_name} · {p.phone}{p.email ? ` · ${p.email}` : " · sans compte"}{p.sessions ? ` · ${p.sessions} séance${p.sessions > 1 ? "s" : ""}` : ""}</div>
            </div>
          </div>
          <button className="small sec iconbtn danger" aria-label={`Supprimer ${p.name}`} onClick={() => remove(`/admin/players/${p.id}`, `Supprimer ${p.name} chez ${p.coach_name} ?`,
            "Sa fiche chez ce coach et tout son historique (séances suivies, paiements, crédits, réservations) seront supprimés définitivement. S'il a un compte chez d'autres coachs, il le garde.", load)}>
            <Icon name="trash" size={15} />
          </button>
        </div>
      ))}
    </>
  );
}

function AdminCoaches({ list, load, me }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [created, setCreated] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    try {
      setCreated(await api("/admin/coaches", { method: "POST", body: f }));
      setF({ name: "", email: "", password: "" });
      setAdding(false);
      load();
    } catch (x) {
      toastError(x);
    }
  };
  return (
    <>
      <div className="row"><span className="mut small-p">{list?.length ?? 0} coach{(list?.length ?? 0) > 1 ? "s" : ""}</span>
        <button className="small" onClick={() => setAdding(!adding)}><Icon name={adding ? "x" : "plus"} size={15} /> {adding ? "Fermer" : "Coach"}</button></div>
      {created && (
        <div className="note ok" style={{ marginTop: 10 }}>
          Compte créé. Transmettez ces identifiants au coach : <b>{created.email}</b> / mot de passe <b>{created.password}</b>
          <div><button className="link" onClick={() => setCreated(null)}>OK</button></div>
        </div>
      )}
      {adding && (
        <form className="card" style={{ marginTop: 10 }} onSubmit={add}>
          <label className="field"><span className="mut">Nom</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="field"><span className="mut">E-mail (identifiant)</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
          <label className="field"><span className="mut">Mot de passe (vide = généré automatiquement)</span><input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={6} /></label>
          <button style={{ width: "100%" }}>Créer le compte coach</button>
        </form>
      )}
      {list === null && <Loading rows={2} />}
      {list?.map((c) => (
        <div className="card row" key={c.id}>
          <div className="row g10" style={{ minWidth: 0 }}>
            <Avatar name={c.name} size={36} />
            <div style={{ minWidth: 0 }}>
              <b>{c.name}{c.admin && <span className="mut small-p"> · admin</span>}</b>
              <div className="mut small-p">{c.email} · {c.players} joueur{c.players > 1 ? "s" : ""} · {c.sessions} séance{c.sessions > 1 ? "s" : ""}</div>
              {c.clubs.length > 0 && <div className="mut small-p"><Icon name="pin" size={12} /> {c.clubs.join(", ")}</div>}
            </div>
          </div>
          {c.id !== me && (
            <button className="small sec iconbtn danger" aria-label={`Supprimer ${c.name}`} onClick={() => remove(`/admin/coaches/${c.id}`, `Supprimer le coach ${c.name} ?`,
              `Son compte, ses ${c.players} élève(s) chez lui, ses séances, terrains, clubs, paiements et réglages seront supprimés définitivement. Les élèves qui ont aussi un compte chez d'autres coachs le gardent.`, load)}>
              <Icon name="trash" size={15} />
            </button>
          )}
        </div>
      ))}
    </>
  );
}

function AdminClubs() {
  const [list, setList] = useState(null);
  const [f, setF] = useState({ name: "", phone: "" });
  const [adding, setAdding] = useState(false);
  const load = () => api("/admin/clubs").then(setList).catch(toastError);
  useEffect(() => { load(); }, []);
  const add = async (e) => {
    e.preventDefault();
    try {
      await api("/admin/clubs", { method: "POST", body: f });
      toast("Club ajouté : les coachs peuvent le choisir dans Réglages › Mes clubs");
      setF({ name: "", phone: "" });
      setAdding(false);
      load();
    } catch (x) {
      toastError(x);
    }
  };
  return (
    <>
      <div className="row"><span className="mut small-p">{list?.length ?? 0} club{(list?.length ?? 0) > 1 ? "s" : ""}</span>
        <button className="small" onClick={() => setAdding(!adding)}><Icon name={adding ? "x" : "plus"} size={15} /> {adding ? "Fermer" : "Club"}</button></div>
      {adding && (
        <form className="card" style={{ marginTop: 10 }} onSubmit={add}>
          <label className="field"><span className="mut">Nom du club</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="field"><span className="mut">Téléphone (SMS de réservation des terrains)</span><input inputMode="tel" placeholder="71 123 456" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <button style={{ width: "100%" }}>Ajouter le club</button>
        </form>
      )}
      {list === null && <Loading rows={2} />}
      {list?.map((c) => (
        <div className="card row" key={c.key}>
          <div style={{ minWidth: 0 }}>
            <b><Icon name="pin" size={14} /> {c.name}</b>
            <div className="mut small-p">{c.phone || "Pas de téléphone"} · {c.coaches.length ? `Coachs : ${c.coaches.join(", ")}` : "Aucun coach pour l'instant"}</div>
          </div>
          <button className="small sec iconbtn danger" aria-label={`Supprimer ${c.name}`} onClick={() => remove(`/admin/clubs/${encodeURIComponent(c.key)}`, `Retirer ${c.name} ?`,
            "Le club ne sera plus proposé aux coachs ni aux joueurs, et ses terrains libres à venir seront supprimés. L'historique (séances passées) est gardé.", load)}>
            <Icon name="trash" size={15} />
          </button>
        </div>
      ))}
    </>
  );
}

export default function Admin({ refreshSummary, summary }) {
  const [tab, setTab] = useState("signups");
  const [coaches, setCoaches] = useState(null);
  const loadCoaches = () => api("/admin/coaches").then(setCoaches).catch(toastError);
  useEffect(() => { loadCoaches(); }, []);
  const me = summary?.coach_id; // son propre compte ne peut pas être supprimé
  return (
    <>
      <h1 style={{ margin: 0 }}>Administration</h1>
      <div className="seg" style={{ margin: "10px 0" }}>
        {[["signups", "Inscriptions"], ["players", "Joueurs"], ["coaches", "Coachs"], ["clubs", "Clubs"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}{k === "signups" && summary?.signups > 0 && <b className="pillcount">{summary.signups}</b>}
          </button>
        ))}
      </div>
      {tab === "signups" && <Signups refreshSummary={refreshSummary} />}
      {tab === "players" && <AdminPlayers coaches={coaches ?? []} />}
      {tab === "coaches" && <AdminCoaches list={coaches} load={loadCoaches} me={me} />}
      {tab === "clubs" && <AdminClubs />}
    </>
  );
}
