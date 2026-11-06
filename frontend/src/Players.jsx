import { useEffect, useState } from "react";
import { api, emailProblem, peek, tnd, useContactCheck } from "./api.js";
import Icon from "./Icon.jsx";
import { toast } from "./feedback.jsx";
import InviteLink from "./InviteLink.jsx";
import PlayerPage from "./PlayerPage.jsx";
import { guideHidden } from "./guide.js";
import { Avatar, CATEGORIES, catOption, CategoryBadge, TIERS, tierOf } from "./ui.jsx";

// Lien d'inscription du coach, le même pour tous ses joueurs (à envoyer à un groupe WhatsApp…): chacun crée son
// compte et devient son élève (coach favori); l'administrateur confirme ensuite, comme pour le lien public.
function CoachLink() {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(() => peek("/auth/coach-link")?.path ?? null);
  useEffect(() => { if (open && !path) api("/auth/coach-link").then((r) => setPath(r.path)).catch(() => {}); }, [open]);
  const url = path && location.origin + path;
  const msg = url && `Bonjour ! Créez votre compte Padel Coach avec ce lien pour réserver vos séances avec moi et suivre votre progression : ${url}`;
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast("Lien copié"); } catch { /* sans presse-papiers: le lien reste affiché */ } };
  return (
    <div className="card coach-link">
      <button className="row plain" style={{ width: "100%" }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span><Icon name="link" size={16} /> <b>Mon lien d'inscription</b> <span className="mut small-p">· pour tous mes joueurs</span></span>
        <Icon name={open ? "chevD" : "chevR"} size={16} />
      </button>
      {open && (
        <>
          <div className="mut small-p" style={{ margin: "6px 0" }}>Envoyez-le à un groupe : chaque joueur crée son compte et devient votre élève (vous êtes son coach favori). L'administrateur confirme ensuite son inscription.</div>
          {url ? (
            <>
              <div className="linkbox"><input readOnly value={url} aria-label="Mon lien d'inscription" onFocus={(e) => e.target.select()} /><button type="button" className="small" onClick={copy}><Icon name="copy" size={15} /> Copier</button></div>
              <div className="actions"><a className="btnlink wa" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={15} /> WhatsApp</a></div>
            </>
          ) : <div className="skel" style={{ height: 40 }} />}
        </>
      )}
    </div>
  );
}

export default function Players({ playerId, openPlayer, closePlayer, go }) {
  const [list, setList] = useState(() => peek("/players") ?? []); // liste du dernier passage, tout de suite
  const [unpaid, setUnpaid] = useState({});
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [gender, setGender] = useState("all");
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", email: "", gender: "M", category: "P100-" });
  const taken = useContactCheck(f.email, f.phone); // e-mail ou téléphone déjà utilisés
  const badEmail = emailProblem(f.email);
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
      const first = list.length === 0; // premier élève: le guide « Bien démarrer » continue après l'envoi du lien
      const r = await api("/players", { method: "POST", body: { ...f, email: f.email.trim() || null } });
      let copied = false;
      try { await navigator.clipboard.writeText(location.origin + r.invite_path); copied = true; } catch { /* copie refusée: bouton « Copier » */ }
      setAdded({ ...r, copied, first });
      setF({ name: "", phone: "", email: "", gender: "M", category: "P100-" });
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
      <CoachLink />
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
          {added.copied ? (
            <div className="note ok" style={{ marginTop: 8 }}>
              <Icon name="copy" size={14} /> <b>Lien copié dans votre presse-papiers !</b> Envoyez-le à {added.name.split(" ")[0]} (WhatsApp, SMS, e-mail) : sa fiche est déjà remplie, il n'a plus qu'à créer son compte.
            </div>
          ) : <div className="mut small-p">Copiez ce lien et envoyez-le à {added.name.split(" ")[0]} : sa fiche est pré-remplie, il la complète et crée son compte.</div>}
          <InviteLink player={added} path={added.invite_path} onCopied={() => setAdded({ ...added, copied: true })} />
          {added.first && added.copied && !guideHidden() && (
            <button style={{ width: "100%", marginTop: 10 }} onClick={() => go("home")}><Icon name="arrowR" size={15} /> C'est envoyé : continuer le guide</button>
          )}
        </div>
      )}
      {adding && (
        <form className="card" onSubmit={add}>
          <label className="field"><span className="mut">Nom complet</span><input value={f.name} onChange={set("name")} required /></label>
          <label className="field"><span className="mut">Téléphone (8 chiffres)</span><input inputMode="tel" placeholder="22 123 456" value={f.phone} onChange={set("phone")} required aria-invalid={!!taken.phone} /></label>
          {taken.phone && <div className="err" role="alert">{taken.phone}</div>}
          <label className="field"><span className="mut">E-mail (facultatif)</span><input type="email" value={f.email} onChange={set("email")} aria-invalid={!!(badEmail || taken.email)} /></label>
          {(badEmail || taken.email) && <div className="err" role="alert">{badEmail || taken.email}</div>}
          <div className="grid">
            <label className="field"><span className="mut">Genre</span>
              <select value={f.gender} onChange={set("gender")}><option value="M">Homme</option><option value="F">Dame</option></select>
            </label>
            <label className="field"><span className="mut">Classement</span>
              <select value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}</select>
            </label>
          </div>
          {err && <div className="err">{err}</div>}
          <button style={{ width: "100%" }} disabled={!!(badEmail || taken.email || taken.phone)}>Ajouter le joueur</button>
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
            {/* un seul montant chez ce coach: ce qu'il doit (séances non réglées + crédits passés dans le rouge), sinon ses crédits */}
            {unpaid[p.id] > 0
              ? <div className="red" style={{ fontSize: ".82rem" }}>{tnd(unpaid[p.id])} dû</div>
              : p.credits_millimes > 0 && <div className="mut" style={{ fontSize: ".8rem" }}><Icon name="wallet" size={12} /> {tnd(p.credits_millimes)} de crédits</div>}
          </div>
        </div>
      ))}
      {!shown.length && list.length > 0 && <p className="mut">Aucun joueur trouvé.</p>}
      {list.length === 0 && !adding && !added && (
        <div className="card empty first-player">
          <Icon name="userPlus" size={30} />
          <b>Ajoutez votre premier élève</b>
          <div className="mut">Touchez le bouton « + Joueur » en bas de l'écran : nom, téléphone et niveau suffisent. Il reçoit ensuite un lien pour créer son compte.</div>
        </div>
      )}
      <button className={"fab" + (list.length === 0 && !adding ? " hint-pulse" : "")} onClick={() => setAdding(!adding)}>{adding ? <><Icon name="x" size={18} /> Fermer</> : <><Icon name="plus" size={18} /> Joueur</>}</button>
    </>
  );
}
