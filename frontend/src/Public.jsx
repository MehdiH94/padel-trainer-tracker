// Pages publiques (sans connexion): page d'accueil du site, annuaire des coachs, page d'un coach, nouveau mot de passe.
import { useEffect, useState } from "react";
import { api, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { PageLinks } from "./Pages.jsx";

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const HOW = { individuel: "Seul", duo: "À deux", groupe: "En groupe" };

// Étoiles de la note (lecture): pleines jusqu'à la note arrondie
export function Stars({ value, size = 14 }) {
  const n = Math.round(value || 0);
  return (
    <span className="stars" aria-label={value ? `${String(value).replace(".", ",")} sur 5` : "Pas encore d'avis"}>
      {[1, 2, 3, 4, 5].map((i) => <Icon key={i} name="star" size={size} className={i <= n ? "on" : ""} />)}
    </span>
  );
}

export function RatingLine({ rating, count }) {
  if (!count) return <span className="mut small-p">Pas encore d'avis</span>;
  return <span className="rating-line"><Stars value={rating} /> <b>{String(rating).replace(".", ",")}</b> <span className="mut">· {count} avis</span></span>;
}

export function ReviewList({ reviews }) {
  if (!reviews?.length) return <p className="mut small-p">Pas encore d'avis : ils apparaissent après les premières séances.</p>;
  return (
    <div className="reviews">
      {reviews.map((r) => (
        <div key={r.id} className="review">
          <div className="row"><b>{r.author}</b><Stars value={r.rating} size={12} /></div>
          {r.comment && <p>{r.comment}</p>}
          <small className="mut">{new Date(r.date).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</small>
        </div>
      ))}
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="page-wrap">
      <div className="page">
        <div className="page-top">
          <a href="/" className="page-brand"><img src="/logo.svg" alt="" width="28" height="28" /> Padel Boost</a>
          <a className="btnlink small" href="/connexion">Se connecter</a>
        </div>
        {children}
        <PageLinks />
      </div>
    </div>
  );
}

function CoachCard({ c }) {
  return (
    <a className="coach-card card" href={`/coachs/${c.id}`}>
      <div className="row"><b>{c.name}</b>{c.from_millimes && <span className="mut small-p">dès {tnd(c.from_millimes)}</span>}</div>
      <RatingLine rating={c.rating} count={c.reviews_count} />
      {c.clubs.length > 0 && <div className="mut small-p"><Icon name="pin" size={12} /> {c.clubs.join(", ")}</div>}
      {c.specialties.length > 0 && <div className="chips">{c.specialties.slice(0, 4).map((s) => <span key={s} className="theme">{s}</span>)}</div>}
    </a>
  );
}

// Page d'accueil du site (visiteur pas connecté)
export function Landing() {
  const [coaches, setCoaches] = useState(null);
  useEffect(() => { api("/public/coaches").then(setCoaches).catch(() => setCoaches([])); }, []);
  return (
    <Shell>
      <section className="hero-land">
        <img src="/logo.svg" alt="" width="64" height="64" />
        <h1>Réservez votre coach de padel en 30 secondes</h1>
        <p>Choisissez votre coach, le jour et l'heure. Suivez votre progression séance après séance. Gratuit pour les joueurs et pour les coachs.</p>
        <div className="land-cta">
          <a className="btnlink big" href="/inscription">Je suis joueur : créer mon compte</a>
          <a className="btnlink big sec" href="/connexion#coach">Je suis coach : créer mon espace</a>
        </div>
        <a className="link" href="/connexion">J'ai déjà un compte</a>
      </section>

      <section className="land-points">
        {[["calendar", "Réserver simplement", "Les créneaux libres de votre coach, seul, à deux ou en groupe. Rejoignez un joueur de votre niveau."],
          ["activity", "Progresser", "Les retours de votre coach après chaque séance et votre toile de progression."],
          ["users", "Pour les coachs", "Planning, terrains, joueurs, prix, paiements et rappels au même endroit."]].map(([i, t, d]) => (
          <div key={t} className="card land-point"><Icon name={i} size={22} /><b>{t}</b><span className="mut small-p">{d}</span></div>
        ))}
      </section>

      <section>
        <div className="row"><h2>Nos coachs</h2><a className="link" href="/coachs">Tout voir</a></div>
        {coaches === null ? <div className="skel" style={{ height: 120 }} /> : coaches.length === 0 ? <p className="mut">Les premiers coachs arrivent bientôt.</p> : (
          <div className="coach-grid">{coaches.slice(0, 6).map((c) => <CoachCard key={c.id} c={c} />)}</div>
        )}
      </section>

      <section className="card land-help">
        <b>Découvrir l'application</b>
        <span className="mut small-p">Des démos en vidéo et les réponses aux questions fréquentes.</span>
        <div className="actions"><a className="btnlink small sec" href="/aide">Voir les démos</a><a className="btnlink small sec" href="/faq">Questions fréquentes</a></div>
      </section>
    </Shell>
  );
}

// Annuaire des coachs
export function Coaches() {
  const [coaches, setCoaches] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { api("/public/coaches").then(setCoaches).catch(() => setCoaches([])); }, []);
  const shown = (coaches ?? []).filter((c) => `${c.name} ${c.clubs.join(" ")} ${c.specialties.join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Shell>
      <h1>Nos coachs</h1>
      <div className="searchbox"><Icon name="search" size={16} /><input placeholder="Nom, club, spécialité…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un coach" /></div>
      {coaches === null && <div className="skel" style={{ height: 160 }} />}
      {coaches && !shown.length && <p className="mut">Aucun coach trouvé.</p>}
      <div className="coach-grid">{shown.map((c) => <CoachCard key={c.id} c={c} />)}</div>
    </Shell>
  );
}

// Page publique d'un coach (lien à partager sur Instagram, WhatsApp…)
export function CoachPublic({ id }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api(`/public/coaches/${id}`).then(setC).catch((x) => setErr(x.message)); }, [id]);
  if (err) return <Shell><p className="err">{err}</p><a className="link" href="/coachs">Voir les coachs</a></Shell>;
  if (!c) return <Shell><div className="skel" style={{ height: 200 }} /></Shell>;
  const days = DAYS.map((d, i) => [d, c.availability.filter((w) => w.weekday === i)]).filter(([, ws]) => ws.length);
  return (
    <Shell>
      <h1>{c.name}</h1>
      <RatingLine rating={c.rating} count={c.reviews_count} />
      {c.clubs.length > 0 && <p className="mut"><Icon name="pin" size={14} /> {c.clubs.join(", ")}</p>}
      <div className="land-cta">
        <a className="btnlink big" href={c.join_path}>Réserver avec {c.name.split(" ")[0]} : créer mon compte</a>
        <a className="link" href="/connexion">J'ai déjà un compte</a>
      </div>
      {c.bio && <div className="card"><div className="mut small-p">À propos</div><div style={{ whiteSpace: "pre-line" }}>{c.bio}</div></div>}
      {c.specialties.length > 0 && <><h2>Spécialités</h2><div className="chips">{c.specialties.map((t) => <span key={t} className="theme">{t}</span>)}</div></>}
      <h2>Tarifs par joueur</h2>
      <div className="card">
        {Object.entries(c.prices).filter(([, x]) => Object.keys(x).length).map(([k, x]) => (
          <div key={k} className="row fin-line"><span>{HOW[k]}</span><span>{Object.entries(x).map(([m, p]) => `${m === "90" ? "1 h 30" : "1 h"} : ${tnd(p)}`).join(" · ")}</span></div>
        ))}
        {c.packs.length > 0 && <div className="mut small-p" style={{ marginTop: 8 }}>Packs : {c.packs.map((p) => `${p.name} (${tnd(p.price_millimes)} → ${tnd(p.credit_millimes)} de crédits)`).join(" · ")}</div>}
      </div>
      {days.length > 0 && (<><h2>Disponibilités</h2><div className="card">{days.map(([d, ws]) => <div key={d} className="row fin-line"><span>{d}</span><span>{ws.map((w) => `${w.start_time}-${w.end_time}`).join(" · ")}</span></div>)}</div></>)}
      <h2>Avis des joueurs</h2>
      <ReviewList reviews={c.reviews} />
    </Shell>
  );
}

// Nouveau mot de passe (lien reçu par e-mail)
export function ResetPassword({ token }) {
  const [pw, setPw] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    try { await api("/auth/password/reset", { method: "POST", body: { token, password: pw } }); setDone(true); } catch (x) { setErr(x.message); }
  };
  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <img className="logo" src="/logo.svg" alt="" width="54" height="54" />
        <h1>Nouveau mot de passe</h1>
        {done ? (
          <><p>C'est fait : votre mot de passe est changé.</p><a className="btnlink" href="/connexion">Se connecter</a></>
        ) : (
          <>
            <label className="field"><span className="mut">Nouveau mot de passe (6 caractères minimum)</span><input type="password" autoComplete="new-password" minLength={6} required value={pw} onChange={(e) => setPw(e.target.value)} /></label>
            {err && <div className="err" role="alert">{err}</div>}
            <button style={{ width: "100%" }}>Enregistrer</button>
          </>
        )}
      </form>
    </div>
  );
}
