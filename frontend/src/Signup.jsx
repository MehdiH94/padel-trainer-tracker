import { useEffect, useState } from "react";
import { api, emailProblem, setSession } from "./api.js";
import Icon from "./Icon.jsx";
import { ProfileQuestions } from "./PlayerSetup.jsx";
import { CATEGORIES, catOption } from "./ui.jsx";

// Inscription publique (lien de la page d'administration, publicité…): le joueur crée son compte sans coach.
// Il voit ensuite tous les coachs et en choisit un en réservant. Avec le lien d'un coach (/inscription/<jeton>,
// le même pour tous ses joueurs): il devient son élève (coach favori). Dans les deux cas, l'administrateur confirme.
export default function Signup({ coachToken }) {
  const [f, setF] = useState({ name: "", phone: "", email: "", password: "", gender: "M", category: "P100-", dominant_hand: "droitier", side: "drive", goals: "" });
  const [coach, setCoach] = useState(null);
  useEffect(() => { if (coachToken) api(`/auth/join/${coachToken}`).then(setCoach).catch((x) => setError(x.message)); }, [coachToken]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const badEmail = emailProblem(f.email);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSession(await api("/auth/signup", { method: "POST", body: { ...f, base: location.origin, coach_token: coachToken || null } }), true);
      location.href = "/";
    } catch (x) {
      setError(x.message);
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="logo"><Icon name="ball" size={30} strokeWidth={1.8} /></div>
        <h1>Créer mon compte</h1>
        <p className="mut">{coach ? `${coach.coach_name} vous invite à créer votre compte : réservez vos séances avec lui et suivez votre progression.` : "Réservez vos séances de padel avec le coach de votre choix et suivez votre progression."}</p>
        <label className="field"><span className="mut">Nom complet</span><input autoComplete="name" value={f.name} onChange={set("name")} required /></label>
        <label className="field"><span className="mut">Téléphone</span><input inputMode="tel" autoComplete="tel" placeholder="22 123 456" value={f.phone} onChange={set("phone")} required /></label>
        <div className="grid">
          <label className="field"><span className="mut">Genre</span><select value={f.gender} onChange={set("gender")}><option value="M">Homme</option><option value="F">Dame</option></select></label>
          <label className="field"><span className="mut">Votre niveau</span><select value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}</select></label>
        </div>
        <ProfileQuestions f={f} setF={setF} />
        <label className="field"><span className="mut">Votre e-mail</span><input type="email" autoComplete="email" value={f.email} onChange={set("email")} required aria-invalid={!!badEmail} /></label>
        {badEmail && <div className="err" role="alert">{badEmail}</div>}
        <label className="field"><span className="mut">Mot de passe (6 caractères minimum)</span><input type="password" autoComplete="new-password" value={f.password} onChange={set("password")} required minLength={6} /></label>
        <p className="mut small-p" style={{ margin: "6px 0 0" }}><Icon name="bell" size={13} /> Rappels de séance et confirmations envoyés par e-mail.</p>
        {error && <div className="err" role="alert">{error}</div>}
        <button style={{ width: "100%", marginTop: 8 }} disabled={busy || !!badEmail}>{busy ? "Création…" : "Créer mon compte"}</button>
        <a className="link center" href="/" style={{ display: "block", marginTop: 10 }}>J'ai déjà un compte</a>
      </form>
    </div>
  );
}
