// Pages publiques (sans connexion): page d'accueil du site, annuaire des coachs, page d'un coach, nouveau mot de passe.
import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { PageLinks } from "./Pages.jsx";


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

// Photo du coach (ou ses initiales)
export function CoachPhoto({ c, size = 64 }) {
  const initials = c.name.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();
  return c.photo_url
    ? <img className="coach-photo" src={c.photo_url} alt={`Photo de ${c.name}`} width={size} height={size} style={{ width: size, height: size }} />
    : <span className="coach-photo initials" style={{ width: size, height: size, fontSize: size / 2.6 }} aria-hidden="true">{initials}</span>;
}

// Petite vidéo de présentation: YouTube dans la page, les autres sites en lien
export function CoachVideo({ c }) {
  if (!c.video_url) return null;
  if (c.youtube_id) {
    return (
      <div className="coach-video">
        <iframe src={`https://www.youtube-nocookie.com/embed/${c.youtube_id}`} title={`Présentation de ${c.name}`} loading="lazy"
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
      </div>
    );
  }
  return <a className="btnlink sec" href={c.video_url} target="_blank" rel="noreferrer"><Icon name="arrowR" size={15} /> Voir sa vidéo de présentation</a>;
}

function CoachCard({ c }) {
  return (
    <a className="coach-card card" href={`/coachs/${c.id}`}>
      <CoachPhoto c={c} size={56} />
      <span className="coach-card-txt">
        <b>{c.name}</b>
        {c.clubs.length > 0 && <span className="mut small-p"><Icon name="pin" size={12} /> {c.clubs.join(", ")}</span>}
        {c.reviews_count > 0 && <RatingLine rating={c.rating} count={c.reviews_count} />}
      </span>
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
  const shown = (coaches ?? []).filter((c) => `${c.name} ${c.clubs.join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Shell>
      <h1>Nos coachs</h1>
      <div className="searchbox"><Icon name="search" size={16} /><input placeholder="Nom ou club…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un coach" /></div>
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
  return (
    <Shell>
      <div className="coach-head">
        <CoachPhoto c={c} size={96} />
        <div>
          <h1>{c.name}</h1>
          {c.clubs.length > 0 && <p className="mut"><Icon name="pin" size={14} /> {c.clubs.join(", ")}</p>}
          {c.reviews_count > 0 && <RatingLine rating={c.rating} count={c.reviews_count} />}
        </div>
      </div>
      {c.bio && <p className="coach-bio">{c.bio}</p>}
      <CoachVideo c={c} />
      <div className="land-cta">
        <a className="btnlink big" href={c.join_path}>Réserver avec {c.name.split(" ")[0]}</a>
        <a className="link" href="/connexion">J'ai déjà un compte</a>
      </div>
      {c.reviews.length > 0 && <><h2>Avis des joueurs</h2><ReviewList reviews={c.reviews} /></>}
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
