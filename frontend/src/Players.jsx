import { useEffect, useState } from "react";
import { api, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import InviteLink from "./InviteLink.jsx";
import PlayerPage from "./PlayerPage.jsx";
import { Avatar, CATEGORIES, catOption, CategoryBadge, TIERS, tierOf } from "./ui.jsx";

export default function Players({ playerId, openPlayer, closePlayer }) {
  const [list, setList] = useState([]);
  const [unpaid, setUnpaid] = useState({});
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [gender, setGender] = useState("all");
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", gender: "M", category: "P100-" });
  const [err, setErr] = useState("");
  const [added, setAdded] = useState(null); // élève tout juste ajouté: son lien d'inscription
  const load = () => {
    api("/players").then(setList);
    api("/dashboard").then((d) => setUnpaid(Object.fromEntries(d.unpaid.map((u) => [u.player_id, u.amount_millimes]))));
  };
  useEffect(load, []);
  if (playerId) return <PlayerPage id={playerId} onBack={closePlayer} />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function add(e) {
    e.preventDefault();
    try {
      setAdded(await api("/players", { method: "POST", body: f }));
      setF({ name: "", phone: "", gender: "M", category: "P100-" });
      setErr("");
      setAdding(false);
      load();
    } catch (x) {
      setErr(x.message);
    }
  }

  const shown = list
    .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) && (cat === "all" || tierOf(p.category) === cat) && (gender === "all" || p.gender === gender))
    .sort((a, b) => CATEGORIES.indexOf(b.category) - CATEGORIES.indexOf(a.category) || a.name.localeCompare(b.name));
  return (
    <>
      <h1>Joueurs <span className="mut">({list.length})</span></h1>
      <div className="searchbox"><Icon name="search" size={18} /><input placeholder="Rechercher un joueur…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="chips" style={{ marginBottom: 6 }}>
        <button className={"chip small" + (cat === "all" ? " on" : "")} onClick={() => setCat("all")}>Tous</button>
        {[...TIERS].reverse().map((c) => <button key={c} className={"chip small" + (cat === c ? " on" : "")} onClick={() => setCat(c)}>{c}</button>)}
        <span className="vsep" />
        {[["all", "Mixte"], ["M", "Hommes"], ["F", "Dames"]].map(([k, l]) => <button key={k} className={"chip small" + (gender === k ? " on" : "")} onClick={() => setGender(k)}>{l}</button>)}
      </div>

      {added?.invite_path && (
        <div className="card">
          <div className="row"><b><Icon name="checkCircle" size={16} /> {added.name} est dans votre liste</b><button className="small sec iconbtn" aria-label="Fermer" onClick={() => setAdded(null)}><Icon name="x" size={15} /></button></div>
          <div className="mut small-p">Envoyez-lui ce lien : sa fiche est pré-remplie, il la complète et crée son compte.</div>
          <InviteLink player={added} path={added.invite_path} />
        </div>
      )}
      {adding && (
        <form className="card" onSubmit={add}>
          <label className="field"><span className="mut">Nom complet</span><input value={f.name} onChange={set("name")} required /></label>
          <label className="field"><span className="mut">Téléphone (8 chiffres)</span><input inputMode="tel" placeholder="22 123 456" value={f.phone} onChange={set("phone")} required /></label>
          <div className="grid">
            <label className="field"><span className="mut">Genre</span>
              <select value={f.gender} onChange={set("gender")}><option value="M">Homme</option><option value="F">Dame</option></select>
            </label>
            <label className="field"><span className="mut">Classement</span>
              <select value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}</select>
            </label>
          </div>
          {err && <div className="err">{err}</div>}
          <button style={{ width: "100%" }}>Ajouter le joueur</button>
        </form>
      )}
      {shown.map((p) => (
        <div className="card row pl" key={p.id} onClick={() => openPlayer(p.id)}>
          <div className="row g10">
            <Avatar name={p.name} size={44} />
            <div><b>{p.name}</b><div className="mut">{p.phone}{p.has_account && <> · <Icon name="shield" size={13} /> compte actif{!p.email_verified && <span className="unverified"> · e-mail non vérifié</span>}</>}{p.signup_status === "a_valider" && <span className="unverified"> · inscription à confirmer</span>}{p.invite_path && <> · <Icon name="link" size={13} /> lien à envoyer</>}</div></div>
          </div>
          <div style={{ textAlign: "right" }}>
            <CategoryBadge category={p.category} gender={p.gender} />
            {p.has_account && <div className={p.credits_millimes < 0 ? "red" : "mut"} style={{ fontSize: ".8rem" }}><Icon name="wallet" size={12} /> {tnd(p.credits_millimes)}</div>}
            {unpaid[p.id] > 0 && <div className="red" style={{ fontSize: ".82rem" }}>{tnd(unpaid[p.id])} dû</div>}
          </div>
        </div>
      ))}
      {!shown.length && <p className="mut">Aucun joueur trouvé.</p>}
      <button className="fab" onClick={() => setAdding(!adding)}>{adding ? <><Icon name="x" size={18} /> Fermer</> : <><Icon name="plus" size={18} /> Joueur</>}</button>
    </>
  );
}
