import { useEffect, useState } from "react";
import Courts from "./Courts.jsx";
import Admin from "./Admin.jsx";
import Replace from "./Replace.jsx";
import Signup from "./Signup.jsx";
import Exercises from "./Exercises.jsx";
import Home from "./Home.jsx";
import Icon from "./Icon.jsx";
import Invite from "./Invite.jsx";
import PlayerApp from "./PlayerApp.jsx";
import Planning from "./Planning.jsx";
import Players from "./Players.jsx";
import Reminders from "./Reminders.jsx";
import Requests from "./Requests.jsx";
import SessionPlan from "./SessionPlan.jsx";
import Settings from "./Settings.jsx";
import VerifyEmail from "./VerifyEmail.jsx";
import { actingAs, api, getRole, getToken, prefetch, setSession, setToken, stopActing } from "./api.js";
import { FeedbackHost, Modal, toast, toastError } from "./feedback.jsx";
import { guideHidden, loadGuide, newlyDone } from "./guide.js";
import { useRoute } from "./router.js";
import { Avatar, CategoryBadge, OfflineBar } from "./ui.jsx";

function Login() {
  const [f, setF] = useState({ email: "", password: "", name: "", phone: "" });
  const [remember, setRemember] = useState(localStorage.getItem("remember") !== "0"); // coché par défaut
  const [mode, setMode] = useState("login");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      setSession(await api("/auth/" + mode, { method: "POST", body: { ...f, base: location.origin } }), remember);
      location.reload();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="logo"><Icon name="ball" size={30} strokeWidth={1.8} /></div>
        <h1>Padel Coach</h1>
        <p className="mut">{mode === "login" ? "Connectez-vous à votre espace" : "Créez votre espace coach"}</p>
        {mode === "register" && <label className="field"><span className="mut">Votre nom de coach</span><input value={f.name} onChange={set("name")} autoComplete="name" required /></label>}
        {mode === "register" && <label className="field"><span className="mut">Téléphone</span><input type="tel" value={f.phone} onChange={set("phone")} autoComplete="tel" placeholder="ex. 22 123 456" required /></label>}
        <label className="field"><span className="mut">E-mail</span><input type="email" value={f.email} onChange={set("email")} autoComplete="email" required /></label>
        <label className="field"><span className="mut">Mot de passe</span><input type="password" value={f.password} onChange={set("password")} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>
        <label className="check" style={{ margin: "4px 0 10px" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Rester connecté sur cet appareil
        </label>
        {err && <div className="err" role="alert">{err}</div>}
        {mode === "register" && <p className="mut small-p">Vous confirmerez votre adresse e-mail, puis un administrateur validera votre compte avant que vous puissiez commencer.</p>}
        <button style={{ width: "100%" }} disabled={busy}>{busy ? "Connexion…" : mode === "login" ? "Se connecter" : "Créer mon compte coach"}</button>
        <button type="button" className="link center" style={{ marginTop: 10 }} onClick={() => { setMode(mode === "login" ? "register" : "login"); setErr(""); }}>
          {mode === "login" ? "Vous êtes coach ? Créer un compte" : "J'ai déjà un compte"}
        </button>
        {mode === "login" && <a className="link center" href="/inscription" style={{ display: "block", marginTop: 6 }}>Joueur ? Créer mon compte</a>}
      </form>
    </div>
  );
}

// Recherche d'un joueur depuis n'importe quel écran du coach
function PlayerSearch({ onPick, onClose }) {
  const [players, setPlayers] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { api("/players").then(setPlayers).catch(() => setPlayers([])); }, []);
  const norm = (t) => t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const shown = (players ?? []).filter((p) => norm(p.name + " " + p.phone).includes(norm(q))).slice(0, 8);
  return (
    <Modal onClose={onClose} label="Rechercher un joueur">
      <div className="searchbox"><Icon name="search" size={18} /><input placeholder="Nom ou téléphone…" aria-label="Nom ou téléphone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="searchlist">
        {players === null && <div className="skel" style={{ height: 44 }} />}
        {shown.map((p) => (
          <button key={p.id} className="searchrow" onClick={() => onPick(p.id)}>
            <Avatar name={p.name} size={32} /><span>{p.name}<small>{p.phone}</small></span><CategoryBadge category={p.category} />
          </button>
        ))}
        {players && !shown.length && <p className="mut center">Aucun joueur trouvé.</p>}
      </div>
    </Modal>
  );
}

const TABS = [
  ["home", "home", "Accueil", Home],
  ["planning", "calendar", "Planning", Planning],
  ["players", "users", "Joueurs", Players],
  ["requests", "inbox", "Demandes", Requests],
  ["reminders", "send", "Relances", Reminders],
];
const PAGES = { admin: Admin, courts: Courts, settings: Settings, exercises: Exercises, session: SessionPlan };

function CoachApp() {
  const [[tab = "home", sub], go] = useRoute("home");
  const [summary, setSummary] = useState({ pending: 0, waiting_court: 0, to_notify: 0 });
  const [search, setSearch] = useState(false);
  // Guide « Bien démarrer »: après chaque enregistrement, une étape terminée est fêtée et le guide relancé
  const [guide, setGuide] = useState(null); // étapes du guide (null = guide fini ou masqué)
  const [bravo, setBravo] = useState(null); // étape qui vient d'être terminée
  const checkGuide = () => {
    if (guideHidden()) return setGuide(null);
    loadGuide().then((steps) => {
      const fresh = newlyDone(steps);
      setGuide(steps.every((s) => s.ok) && !fresh.length ? null : steps);
      // le premier élève n'est pas fêté ici: la page Joueurs montre d'abord son lien à envoyer, puis « continuer le guide »
      const shown = fresh.filter((s) => s.key !== "eleve");
      if (shown.length) setBravo(shown[shown.length - 1]);
    }).catch(() => {});
  };
  useEffect(() => {
    checkGuide();
    let t;
    const later = () => { clearTimeout(t); t = setTimeout(checkGuide, 400); }; // après la fin de l'enregistrement
    window.addEventListener("data:changed", later);
    return () => { window.removeEventListener("data:changed", later); clearTimeout(t); };
  }, []);
  const needPlayer = guide?.find((s) => !s.ok)?.key === "eleve"; // seulement quand c'est l'étape en cours du guide
  const refresh = () => api("/booking/summary").then(setSummary).catch(() => {});
  // données du planning chargées à l'avance, pendant que le coach regarde l'accueil: le planning s'ouvre tout de suite
  useEffect(() => {
    const t = setTimeout(() => prefetch(["/sessions", "/players", "/court-bookings", "/clubs", "/promotions", "/time-off"]), 1500);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { refresh(); }, [tab]);

  const Page = PAGES[tab] ?? TABS.find((t) => t[0] === tab)?.[3] ?? Home;
  const playerId = tab === "players" && sub ? +sub : null;
  const openPlayer = (id) => go(`players/${id}`);
  const navOn = ["courts", "exercises", "session"].includes(tab) ? "planning" : tab; // pages ouvertes depuis le planning
  const alerts = summary.pending + summary.to_notify; // ce qui attend une action du coach
  return (
    <>
      <OfflineBar />
      <main id="main"><Page key={tab + (sub ?? "")} sub={sub} go={go} openPlayer={openPlayer} playerId={playerId} closePlayer={() => go("players")} onBack={() => (history.length > 1 ? history.back() : go("home"))} summary={summary} refreshSummary={refresh} /></main>
      <nav aria-label="Navigation principale">
        <span className="brandmark"><Icon name="ball" size={20} /> Padel Coach</span>
        {TABS.map(([k, icon, label]) => (
          <button key={k} className={(navOn === k ? "on" : "") + (k === "players" && needPlayer && navOn !== "players" ? " hint-pulse" : "")} aria-current={navOn === k ? "page" : undefined} onClick={() => go(k)}>
            <span className="navico">
              <Icon name={icon} size={22} strokeWidth={navOn === k ? 2.3 : 1.8} />
              {k === "requests" && alerts > 0 && <b className="navbadge" aria-label={`${alerts} à traiter`}>{alerts}</b>}
            </span>
            {label}
          </button>
        ))}
      </nav>
      <div className="topbtns">
        {summary.admin && (
          <button onClick={() => go("admin")} title="Administration" aria-label={`Administration (${summary.signups} inscription(s) à confirmer)`} className="navico">
            <Icon name="shield" size={17} />{summary.signups > 0 && <b className="navbadge">{summary.signups}</b>}
          </button>
        )}
        <button onClick={() => setSearch(true)} title="Rechercher un joueur" aria-label="Rechercher un joueur"><Icon name="search" size={17} /></button>
        <button onClick={() => go("settings")} title="Réglages" aria-label="Réglages"><Icon name="sliders" size={17} /></button>
        <button onClick={() => { setToken(null); location.hash = ""; location.reload(); }} title="Se déconnecter" aria-label="Se déconnecter"><Icon name="logout" size={17} /></button>
      </div>
      {bravo && <Bravo step={bravo} steps={guide} onClose={() => setBravo(null)} go={(to) => { setBravo(null); go(to); }} />}
      {search && <PlayerSearch onClose={() => setSearch(false)} onPick={(id) => { setSearch(false); openPlayer(id); }} />}
    </>
  );
}

// Félicitations quand une étape du guide « Bien démarrer » vient d'être terminée
function Bravo({ step, steps, onClose, go }) {
  const all = steps ?? [];
  const done = all.filter((s) => s.ok).length;
  const next = all.find((s) => !s.ok);
  return (
    <Modal onClose={onClose} label="Étape terminée">
      <div className="bravo">
        <div className="bravo-ico" aria-hidden="true"><Icon name="checkCircle" size={34} /></div>
        <b className="sheet-title">{next ? "Bravo, une étape de plus !" : "Votre espace est prêt !"}</b>
        <p>{step.bravo}</p>
        {all.length > 0 && (
          <>
            <div className="bar"><div style={{ width: `${(done / all.length) * 100}%`, background: "var(--green)" }} /></div>
            <div className="mut small-p">{done} étape{done > 1 ? "s" : ""} sur {all.length} terminée{done > 1 ? "s" : ""}{next ? ` · prochaine : ${next.label}` : " : vos joueurs peuvent réserver en ligne."}</div>
          </>
        )}
        <div className="actions" style={{ flexDirection: "column" }}>
          {next && <button onClick={() => go("home")}><Icon name="arrowR" size={15} /> Continuer le guide</button>}
          <button className="sec" onClick={onClose}>{next ? "Rester sur cette page" : "Super !"}</button>
        </div>
      </div>
    </Modal>
  );
}

// Bandeau quand l'administrateur agit dans l'espace d'un coach ou d'un joueur
function AdminBar() {
  return (
    <div className="admin-bar" role="status">
      <Icon name="shield" size={15} /> <span>Mode administrateur · espace du {actingAs()}</span>
      <button className="small" onClick={stopActing}>Revenir à l'administration</button>
    </div>
  );
}

// Compte en attente (nouveau coach, joueur inscrit par le lien public): e-mail à vérifier, puis confirmation
// d'un administrateur. Rien d'autre n'est possible avant; l'écran se met à jour seul.
function Waiting({ acc, reload }) {
  const [sent, setSent] = useState(false);
  useEffect(() => { const t = setInterval(reload, 15000); return () => clearInterval(t); }, []);
  const emailOk = acc.email_verified; // « c'est fait » seulement quand le lien a vraiment été ouvert
  const resend = () => api("/auth/account/resend", { method: "POST", body: { base: location.origin } })
    .then(() => { setSent(true); toast(`Nouveau lien envoyé à ${acc.email}`); }).catch(toastError);
  const logout = () => { setToken(null); location.reload(); };
  if (acc.signup_status === "refusee") return (
    <div className="login-wrap"><div className="login card center">
      <div className="bigcheck wait" style={{ margin: "0 auto 8px" }}><Icon name="alert" size={40} strokeWidth={1.6} /></div>
      <h1>Compte refusé</h1>
      <p className="mut">Un administrateur n'a pas confirmé ce compte. Contactez-le si vous pensez qu'il s'agit d'une erreur.</p>
      <button className="sec" style={{ width: "100%" }} onClick={logout}>Se déconnecter</button>
    </div></div>
  );
  return (
    <div className="login-wrap">
      <div className="login card">
        <div className="logo"><Icon name="ball" size={30} strokeWidth={1.8} /></div>
        <h1>Bienvenue {acc.name.split(" ")[0]} !</h1>
        <p className="mut">Votre compte {acc.role === "coach" ? "coach " : ""}est créé. Encore {emailOk ? "une étape" : "deux étapes"} avant de pouvoir l'utiliser :</p>
        <ol className="wait-steps">
          <li className={emailOk ? "ok" : "now"}>
            <Icon name={emailOk ? "checkCircle" : "mail"} size={20} />
            <div>
              <b>Confirmer votre adresse e-mail</b>
              {emailOk ? <div className="mut small-p">C'est fait.</div> : (
                <>
                  <div className="small-p">Ouvrez le lien envoyé à <b>{acc.email}</b> (pensez à regarder dans les spams).</div>
                  <button className="small sec" style={{ marginTop: 6 }} disabled={sent} onClick={resend}>{sent ? "Lien renvoyé" : "Renvoyer le lien"}</button>
                </>
              )}
            </div>
          </li>
          <li className={emailOk ? "now" : ""}>
            <Icon name="shield" size={20} />
            <div>
              <b>Confirmation par un administrateur</b>
              <div className="small-p">Un administrateur va vérifier et confirmer votre compte. Vous recevrez un e-mail, et vous pourrez alors utiliser l'application{acc.role === "coach" ? " : un guide vous montrera les premières étapes" : ""}.</div>
            </div>
          </li>
        </ol>
        <button style={{ width: "100%" }} onClick={reload}><Icon name="repeat" size={15} /> Vérifier maintenant</button>
        <button className="link center" style={{ marginTop: 10, display: "block", width: "100%" }} onClick={logout}>Se déconnecter</button>
      </div>
    </div>
  );
}

// Connecté: on vérifie d'abord que le compte n'est pas en attente
function Account() {
  const [acc, setAcc] = useState(null);
  const load = () => api("/auth/account").then((a) => setAcc((old) => {
    if (old?.pending && !a.pending) location.reload(); // confirmé pendant l'attente: l'appli s'ouvre
    return a;
  })).catch(() => setAcc({ pending: false }));
  useEffect(() => { load(); }, []);
  if (!acc) return <div className="login-wrap"><div className="login card"><div className="skel" style={{ height: 160 }} /></div></div>;
  if (acc.pending) return <Waiting acc={acc} reload={load} />;
  return getRole() === "player" ? <PlayerApp /> : <CoachApp />;
}

export default function App() {
  let page;
  if (location.pathname.startsWith("/invite/")) page = <Invite token={location.pathname.split("/")[2]} />;
  else if (location.pathname.startsWith("/inscription")) page = <Signup />;
  else if (location.pathname.startsWith("/remplacer/")) page = <Replace token={location.pathname.split("/")[2]} />;
  else if (location.pathname.startsWith("/verify/")) page = <VerifyEmail token={location.pathname.split("/")[2]} />;
  else if (!getToken()) page = <Login />;
  else page = <Account />;
  return <>{actingAs() && getToken() && <AdminBar />}{page}<FeedbackHost /></>;
}
