import { useEffect, useState } from "react";
import { api, setSession } from "./api.js";
import Icon from "./Icon.jsx";
import { ChannelPicker } from "./ui.jsx";

// Page ouverte depuis le lien d'invitation: le joueur crée son compte.
export default function Invite({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [f, setF] = useState({ email: "", password: "", contact_channel: "" });
  useEffect(() => {
    api(`/auth/invite/${token}`).then((i) => { setInfo(i); setF((x) => ({ ...x, email: i.email ?? "" })); }).catch(() => setError("Ce lien d'invitation n'est plus valide."));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    if (!f.contact_channel) return setError("Choisissez comment recevoir vos rappels de séance.");
    try {
      setSession(await api(`/auth/invite/${token}`, { method: "POST", body: f }));
      location.href = "/";
    } catch (x) {
      setError(x.message);
    }
  }
  if (error && !info) return <div className="login-wrap"><div className="login card">{error}</div></div>;
  if (!info) return null;
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="logo"><Icon name="ball" size={30} strokeWidth={1.8} /></div>
        <h1>Bienvenue {info.player_name.split(" ")[0]} !</h1>
        <p className="mut">{info.coach_name} vous invite à créer votre compte pour réserver vos séances et suivre votre progression.</p>
        <input type="email" placeholder="Votre e-mail" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        <input type="password" placeholder="Mot de passe (6 caractères min.)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={6} />
        <p className="mut" style={{ margin: "6px 0 0" }}>Rappel de vos séances 24 h et 2 h avant, par :</p>
        <ChannelPicker value={f.contact_channel} onChange={(c) => setF({ ...f, contact_channel: c })} />
        {error && <div className="err">{error}</div>}
        <button style={{ width: "100%" }}>Créer mon compte</button>
      </form>
    </div>
  );
}
