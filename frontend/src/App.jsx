import { useEffect, useState } from "react";
import Courts from "./Courts.jsx";
import Home from "./Home.jsx";
import Icon from "./Icon.jsx";
import Invite from "./Invite.jsx";
import PlayerApp from "./PlayerApp.jsx";
import Planning from "./Planning.jsx";
import Players from "./Players.jsx";
import Reminders from "./Reminders.jsx";
import Requests from "./Requests.jsx";
import Settings from "./Settings.jsx";
import { api, getRole, getToken, setSession, setToken } from "./api.js";

function Login() {
  const [f, setF] = useState({ email: "", password: "", name: "" });
  const [mode, setMode] = useState("login");
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    try {
      setSession(await api("/auth/" + mode, { method: "POST", body: f }));
      location.reload();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="logo"><Icon name="ball" size={30} strokeWidth={1.8} /></div>
        <h1>Padel Coach</h1>
        <p className="mut">{mode === "login" ? "Connectez-vous à votre espace" : "Créez votre espace coach"}</p>
        {mode === "register" && <input placeholder="Votre nom de coach" value={f.name} onChange={set("name")} />}
        <input type="email" placeholder="E-mail" value={f.email} onChange={set("email")} required />
        <input type="password" placeholder="Mot de passe" value={f.password} onChange={set("password")} required />
        {err && <div className="err">{err}</div>}
        <button style={{ width: "100%" }}>{mode === "login" ? "Se connecter" : "Créer mon compte coach"}</button>
        <p className="mut center link-p" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Vous êtes coach ? Créer un compte" : "J'ai déjà un compte"}
        </p>
        {mode === "login" && <p className="mut center small-p">Joueur : utilisez le lien d'invitation envoyé par votre coach.</p>}
      </form>
    </div>
  );
}

const TABS = [
  ["home", "home", "Accueil", Home],
  ["planning", "calendar", "Planning", Planning],
  ["players", "users", "Joueurs", Players],
  ["requests", "inbox", "Demandes", Requests],
  ["courts", "pin", "Terrains", Courts],
  ["reminders", "send", "Relances", Reminders],
];

function CoachApp() {
  const [tab, setTab] = useState("home");
  const [playerId, setPlayerId] = useState(null);
  const [summary, setSummary] = useState({ pending: 0, waiting_court: 0, to_notify: 0 });
  const refresh = () => api("/booking/summary").then(setSummary).catch(() => {});
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { refresh(); }, [tab]);

  const Page = tab === "settings" ? Settings : TABS.find((t) => t[0] === tab)[3];
  const openPlayer = (id) => { setPlayerId(id); setTab("players"); };
  const alerts = summary.pending + summary.to_notify; // ce qui attend une action du coach
  return (
    <>
      <main><Page key={tab + playerId} go={setTab} openPlayer={openPlayer} playerId={playerId} closePlayer={() => setPlayerId(null)} onBack={() => setTab("home")} summary={summary} refreshSummary={refresh} /></main>
      <nav>
        {TABS.map(([k, icon, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); setPlayerId(null); }}>
            <span className="navico">
              <Icon name={icon} size={22} strokeWidth={tab === k ? 2.3 : 1.8} />
              {k === "requests" && alerts > 0 && <b className="navbadge">{alerts}</b>}
            </span>
            {label}
          </button>
        ))}
      </nav>
      <div className="topbtns">
        <button onClick={() => setTab("settings")} title="Réglages"><Icon name="sliders" size={17} /></button>
        <button onClick={() => { setToken(null); location.reload(); }} title="Se déconnecter"><Icon name="logout" size={17} /></button>
      </div>
    </>
  );
}

export default function App() {
  if (location.pathname.startsWith("/invite/")) return <Invite token={location.pathname.split("/")[2]} />;
  if (!getToken()) return <Login />;
  return getRole() === "player" ? <PlayerApp /> : <CoachApp />;
}
