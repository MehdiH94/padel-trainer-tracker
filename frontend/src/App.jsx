import { useEffect, useState } from "react";
import Courts from "./Courts.jsx";
import Admin from "./Admin.jsx";
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
import { api, getRole, getToken, setSession, setToken } from "./api.js";
import { FeedbackHost, Modal } from "./feedback.jsx";
import { useRoute } from "./router.js";
import { Avatar, CategoryBadge, OfflineBar } from "./ui.jsx";

function Login() {
  const [f, setF] = useState({ email: "", password: "", name: "" });
  const [mode, setMode] = useState("login");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      setSession(await api("/auth/" + mode, { method: "POST", body: f }));
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
        {mode === "register" && <label className="field"><span className="mut">Votre nom de coach</span><input value={f.name} onChange={set("name")} autoComplete="name" /></label>}
        <label className="field"><span className="mut">E-mail</span><input type="email" value={f.email} onChange={set("email")} autoComplete="email" required /></label>
        <label className="field"><span className="mut">Mot de passe</span><input type="password" value={f.password} onChange={set("password")} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>
        {err && <div className="err" role="alert">{err}</div>}
        <button style={{ width: "100%" }} disabled={busy}>{busy ? "Connexion…" : mode === "login" ? "Se connecter" : "Créer mon compte coach"}</button>
        <button type="button" className="link center" style={{ marginTop: 10 }} onClick={() => { setMode(mode === "login" ? "register" : "login"); setErr(""); }}>
          {mode === "login" ? "Vous êtes coach ? Créer un compte" : "J'ai déjà un compte"}
        </button>
        {mode === "login" && <p className="mut center small-p">Joueur : utilisez le lien d'invitation envoyé par votre coach.</p>}
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
  const refresh = () => api("/booking/summary").then(setSummary).catch(() => {});
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
          <button key={k} className={navOn === k ? "on" : ""} aria-current={navOn === k ? "page" : undefined} onClick={() => go(k)}>
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
          <button onClick={() => go("admin")} title="Inscriptions à confirmer" aria-label={`Inscriptions à confirmer : ${summary.signups}`} className="navico">
            <Icon name="shield" size={17} />{summary.signups > 0 && <b className="navbadge">{summary.signups}</b>}
          </button>
        )}
        <button onClick={() => setSearch(true)} title="Rechercher un joueur" aria-label="Rechercher un joueur"><Icon name="search" size={17} /></button>
        <button onClick={() => go("settings")} title="Réglages" aria-label="Réglages"><Icon name="sliders" size={17} /></button>
        <button onClick={() => { setToken(null); location.hash = ""; location.reload(); }} title="Se déconnecter" aria-label="Se déconnecter"><Icon name="logout" size={17} /></button>
      </div>
      {search && <PlayerSearch onClose={() => setSearch(false)} onPick={(id) => { setSearch(false); openPlayer(id); }} />}
    </>
  );
}

export default function App() {
  let page;
  if (location.pathname.startsWith("/invite/")) page = <Invite token={location.pathname.split("/")[2]} />;
  else if (location.pathname.startsWith("/verify/")) page = <VerifyEmail token={location.pathname.split("/")[2]} />;
  else if (!getToken()) page = <Login />;
  else page = getRole() === "player" ? <PlayerApp /> : <CoachApp />;
  return <>{page}<FeedbackHost /></>;
}
