import { useEffect, useState } from "react";
import { api, dayLabel, getRole, getToken, hhmm, setSession, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { CATEGORIES, CategoryBadge, KIND, catOption } from "./ui.jsx";

// Lien « remplacez-moi »: un joueur qui ne peut plus annuler cède sa place. Le remplaçant se connecte
// (ou crée son compte chez ce coach) et prend la place; il paie avec ses crédits chez ce coach.
export default function Replace({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState(getToken() && getRole() === "player" ? "connecte" : "login");
  const [done, setDone] = useState(false);
  const [f, setF] = useState({ email: "", password: "", name: "", phone: "", gender: "M", category: "P100-", contact_channel: "email" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    api(`/replace/${token}`).then(setInfo).catch((x) => setError(x.message));
  }, [token]);

  async function take(e) {
    e?.preventDefault();
    setError("");
    try {
      if (mode === "login") setSession(await api("/auth/login", { method: "POST", body: { email: f.email, password: f.password } }));
      if (mode === "signup") {
        setSession(await api(`/replace/${token}/signup`, { method: "POST", body: { ...f, base: location.origin } }));
      } else {
        if (getRole() !== "player") return setError("Connectez-vous avec un compte joueur.");
        await api(`/replace/${token}/take`, { method: "POST" });
      }
      setDone(true);
    } catch (x) {
      setError(x.message);
    }
  }

  if (!info) return <div className="login-wrap"><div className="login card">{error || <div className="skel" style={{ height: 180 }} />}</div></div>;
  const k = KIND[info.kind];
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={take}>
        <div className="logo"><Icon name="ball" size={30} strokeWidth={1.8} /></div>
        {done ? (
          <>
            <h1>C'est à vous !</h1>
            <p>Vous avez pris la place de {info.leaving}. La séance apparaît dans « Mes séances ».</p>
            <button type="button" style={{ width: "100%" }} onClick={() => (location.href = "/")}>Ouvrir mon espace</button>
          </>
        ) : (
          <>
            <h1>Une place pour vous</h1>
            <p className="mut">{info.leaving} ne peut plus venir et vous propose sa place.</p>
            <div className="card" style={{ background: "var(--soft)", boxShadow: "none" }}>
              <b style={{ textTransform: "capitalize" }}>{dayLabel(info.start)} · {hhmm(info.start)}</b>
              <div className="mut small-p">{k?.label} · {info.duration_min} min · avec {info.coach_name}</div>
              {(info.club || info.court) && <div className="where" style={{ marginTop: 4 }}><Icon name="pin" size={12} /> {info.club || "Club à préciser"}{info.court && ` · ${info.court}`}</div>}
              {info.players.length > 0 && (
                <div className="small-p" style={{ marginTop: 6 }}>Avec {info.players.map((p) => <span key={p.name} className="ptag" style={{ marginRight: 8 }}>{p.name} <CategoryBadge category={p.category} /></span>)}</div>
              )}
              <div className="small-p" style={{ marginTop: 6 }}>Prix : <b>{tnd(info.price_millimes)}</b>, payé avec vos crédits chez {info.coach_name} (ou à lui régler).</div>
            </div>
            {mode === "connecte" ? (
              <button style={{ width: "100%", marginTop: 10 }}><Icon name="check" size={16} /> Prendre sa place</button>
            ) : (
              <>
                <div className="seg mini" style={{ margin: "10px 0" }}>
                  <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>J'ai un compte</button>
                  <button type="button" className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>Je crée mon compte</button>
                </div>
                {mode === "signup" && (
                  <>
                    <label className="field"><span className="mut">Nom complet</span><input autoComplete="name" value={f.name} onChange={set("name")} required /></label>
                    <label className="field"><span className="mut">Téléphone</span><input inputMode="tel" autoComplete="tel" placeholder="22 123 456" value={f.phone} onChange={set("phone")} required /></label>
                    <div className="grid">
                      <label className="field"><span className="mut">Genre</span><select value={f.gender} onChange={set("gender")}><option value="M">Homme</option><option value="F">Dame</option></select></label>
                      <label className="field"><span className="mut">Votre niveau</span><select value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{catOption(c)}</option>)}</select></label>
                    </div>
                  </>
                )}
                <label className="field"><span className="mut">E-mail</span><input type="email" autoComplete="email" value={f.email} onChange={set("email")} required /></label>
                <label className="field"><span className="mut">Mot de passe{mode === "signup" && " (6 caractères minimum)"}</span><input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={f.password} onChange={set("password")} required minLength={mode === "signup" ? 6 : undefined} /></label>
                {mode === "signup" && <p className="mut small-p" style={{ margin: "6px 0 0" }}><Icon name="bell" size={13} /> Rappels de séance (24 h et 2 h avant) et confirmations envoyés par e-mail.</p>}
                <button style={{ width: "100%", marginTop: 8 }}>{mode === "signup" ? "Créer mon compte et prendre la place" : "Me connecter et prendre la place"}</button>
              </>
            )}
            {error && <div className="err" role="alert" style={{ marginTop: 8 }}>{error}</div>}
          </>
        )}
      </form>
    </div>
  );
}
