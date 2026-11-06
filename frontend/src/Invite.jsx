import { useEffect, useState } from "react";
import { api, setSession } from "./api.js";
import Icon from "./Icon.jsx";
import { CATEGORIES, catOption } from "./ui.jsx";
import { ProfileQuestions } from "./PlayerSetup.jsx";

// Page ouverte depuis le lien d'invitation: le joueur crée son compte.
export default function Invite({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [f, setF] = useState({ email: "", password: "", contact_channel: "email", name: "", phone: "", gender: "M", category: "P100-", dominant_hand: "droitier", side: "drive", goals: "" });
  useEffect(() => {
    api(`/auth/invite/${token}`).then((i) => { setInfo(i); setF((x) => ({ ...x, email: i.email ?? "", name: i.player_name, phone: i.phone ?? "", gender: i.gender ?? "M", category: i.category ?? "P100-", dominant_hand: i.dominant_hand ?? "droitier", side: i.side ?? "drive", goals: i.goals ?? "" })); }).catch(() => setError("Ce lien d'invitation n'est plus valide."));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    try {
      setSession(await api(`/auth/invite/${token}`, { method: "POST", body: { ...f, base: location.origin } }));
      location.href = "/";
    } catch (x) {
      setError(x.message);
    }
  }
  if (error && !info) return <div className="login-wrap"><div className="login card">{error}</div></div>;
  if (!info) return <div className="login-wrap"><div className="login card"><div className="skel" style={{ height: 180 }} /></div></div>;
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="logo"><Icon name="ball" size={30} strokeWidth={1.8} /></div>
        <h1>Bienvenue {info.player_name.split(" ")[0]} !</h1>
        <p className="mut">{info.coach_name} vous invite à créer votre compte pour réserver vos séances et suivre votre progression. Vérifiez et complétez votre fiche :</p>
        <label className="field"><span className="mut">Nom complet</span><input autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label className="field"><span className="mut">Téléphone</span><input inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /></label>
        <div className="grid">
          <label className="field"><span className="mut">Genre</span>
            <select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="M">Homme</option><option value="F">Dame</option></select>
          </label>
          <label className="field"><span className="mut">Votre niveau</span>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}</select>
          </label>
        </div>
        <ProfileQuestions f={f} setF={setF} />
        <label className="field"><span className="mut">Votre e-mail</span><input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
        <label className="field"><span className="mut">Mot de passe (6 caractères minimum)</span><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={6} /></label>
<p className="mut small-p" style={{ margin: "6px 0 0" }}><Icon name="bell" size={13} /> Rappels de séance (24 h et 2 h avant) et confirmations envoyés par e-mail.</p>
        {error && <div className="err" role="alert">{error}</div>}
        <button style={{ width: "100%" }}>Créer mon compte</button>
      </form>
    </div>
  );
}
