import { useEffect, useRef, useState } from "react";
import { api, dayLabel, hhmm, setToken, tnd, toDate, useLive } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";
import { Book, CoachPage } from "./PlayerBook.jsx";
import { Planning, PlayTime } from "./PlayerPlanning.jsx";
import { CoachRadars, Credits, Progression } from "./PlayerProgress.jsx";
import { DateBlock, KindPill, SessionTicket, TZ } from "./PlayerShared.jsx";
import { VerifyBanner } from "./VerifyEmail.jsx";
import { useRoute } from "./router.js";
import { Avatar, CategoryBadge, InstallCard, Loading, OfflineBar, reduction } from "./ui.jsx";

// ---------------------------------------------------------------- Accueil
// Promotion d'un coach: ouvre la réservation sur ce coach et ce jour
function bookPromo(p, go) {
  try {
    sessionStorage.setItem("book-filters", JSON.stringify({ coachIds: [p.coach_id], day: toDate(p.start).toLocaleDateString("fr-CA", { timeZone: TZ }), kinds: ["individuel", "duo", "groupe"], period: "", hour: "", club: "" }));
  } catch { /* stockage indisponible */ }
  go("book");
}

// « 12 décembre » à partir de « 2026-12-12 »
const shortDay = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
const absenceText = (a) => (a.now ? `absent jusqu'au ${shortDay(a.end_date)}` : a.start_date === a.end_date ? `absent le ${shortDay(a.end_date)}` : `absent du ${shortDay(a.start_date)} au ${shortDay(a.end_date)}`) + (a.reason ? ` (${a.reason})` : "");

// Accueil simple: prochaine séance, mes coachs (et leurs absences), une araignée résumée et l'objectif; le détail est dans « Ma progression »
function Home({ me, sessions, progress, proposals, promos, go, reload }) {
  const next = sessions.upcoming[0];
  const answer = (p, what) => api(`/me/proposals/${p.id}/${what}`, { method: "POST" })
    .then(() => { toast(what === "accept" ? "C'est noté, vous êtes inscrit !" : "Proposition refusée"); reload(); })
    .catch(toastError);
  const rated = progress?.by_coach?.some((c) => c.skills.some((s) => s.score != null));
  const absences = me.absences ?? [];
  return (
    <>
      <div className="hero">
        <div className="hero-top">{me.coach_name ? `Votre coach · ${me.coach_name}` : "Bienvenue sur Padel Coach"}</div>
        <div className="row"><h1>Salut {me.name.split(" ")[0]}</h1><CategoryBadge category={me.category} gender={me.gender} /></div>
      </div>

      <VerifyBanner me={me} />
      <InstallCard />
      {!me.coach_name && (
        <div className="card" style={{ marginBottom: 10 }}>
          <b><Icon name="users" size={16} /> Choisissez votre coach</b>
          <div className="mut small-p">Vous n'avez pas encore de coach : découvrez-les dans « Réserver », avec leur page, leurs clubs et leurs prix. Votre première réservation vous rattache au coach choisi.</div>
        </div>
      )}
      <button className="cta" onClick={() => go("book")}><Icon name="calendar" size={20} /> Réserver une séance <Icon name="chevR" size={18} /></button>

      {proposals.length > 0 && (
        <>
          <h2 className="accent-h"><Icon name="sparkles" size={16} /> {me.coach_name} vous propose</h2>
          {proposals.map((p) => (
            <div className="card proposal" key={p.id}>
              <div className="row g10" style={{ alignItems: "flex-start" }}>
                <DateBlock iso={p.start} />
                <div style={{ flex: 1 }}>
                  <div className="row"><b>{hhmm(p.start)} · {p.duration_min} min</b><KindPill kind={p.kind} /></div>
                  <div className="mut"><Icon name="user" size={13} /> {p.coach_name}{p.club && <> · <Icon name="pin" size={13} /> {p.club}</>}</div>
                  <div className="partners">
                    {p.partners.map((x) => <span key={x.name} className="partner"><Avatar name={x.name} size={22} /> {x.name.split(" ")[0]} <CategoryBadge category={x.category} /></span>)}
                  </div>
                  <div className="mut">{p.spots_left} place{p.spots_left > 1 ? "s" : ""} libre{p.spots_left > 1 ? "s" : ""} · <b>{tnd(p.price_millimes)}</b></div>
                </div>
              </div>
              <div className="actions">
                <button onClick={() => answer(p, "accept")}><Icon name="check" size={16} /> Accepter</button>
                <button className="sec" onClick={() => answer(p, "decline")}>Refuser</button>
              </div>
            </div>
          ))}
        </>
      )}

      {promos.length > 0 && (
        <>
          <h2 className="accent-h"><Icon name="sparkles" size={16} /> Promotions</h2>
          {promos.map((p) => (
            <div className="card promo-card" key={p.id}>
              <div className="row g10" style={{ alignItems: "flex-start" }}>
                <DateBlock iso={p.start} />
                <div style={{ flex: 1 }}>
                  <div className="row"><b>{hhmm(p.start)} · {p.club}</b><span className="promo-tag">{reduction(p)}</span></div>
                  <div className="mut"><Icon name="user" size={13} /> {p.coach_name} · terrain déjà réservé</div>
                  <div className="mut small-p">Seul {tnd(p.prices.individuel)} · à deux {tnd(p.prices.duo)} · en groupe {tnd(p.prices.groupe)} par joueur</div>
                </div>
              </div>
              <button style={{ width: "100%", marginTop: 10 }} onClick={() => bookPromo(p, go)}>J'en profite</button>
            </div>
          ))}
        </>
      )}

      <h2>Ma prochaine séance</h2>
      {next ? <SessionTicket s={next} reload={reload} /> : <div className="card mut">Aucune séance prévue. Réservez la prochaine !</div>}

      {(me.wallets.length > 0 || absences.length > 0) && (
        <>
          <h2>Mes coachs</h2>
          <div className="card">
            {me.wallets.map((w) => {
              const off = absences.filter((a) => a.coach_name === w.coach_name);
              return (
                <button key={w.coach_id} className="mycoach" onClick={() => go(`coach/${w.coach_id}`)}>
                  <Avatar name={w.coach_name} size={34} />
                  <span style={{ flex: 1, textAlign: "left" }}>
                    <b>{w.coach_name}</b>
                    {off.map((a, i) => <div key={i} className="small-p" style={{ color: "var(--warn-txt)" }}><Icon name="sun" size={13} /> {absenceText(a)}</div>)}
                  </span>
                  <Icon name="chevR" size={16} />
                </button>
              );
            })}
          </div>
        </>
      )}

      {progress && (rated || progress.goals || progress.play) && (
        <>
          <h2>Ma progression</h2>
          {progress.goals && <div className="card"><div className="mut"><Icon name="target" size={14} /> Mon objectif</div><b>{progress.goals}</b></div>}
          {rated && <div className="card"><CoachRadars progress={progress} small /></div>}
          <PlayTime play={progress.play} compact />
          <button className="link center" style={{ width: "100%", marginTop: 6 }} onClick={() => go("progress")}>Voir ma progression <Icon name="chevR" size={14} /></button>
        </>
      )}
      {/* Version bêta: rappels et confirmations uniquement par e-mail */}
      <div className="mut small-p" style={{ marginTop: 14 }}><Icon name="bell" size={14} /> Rappels et confirmations par e-mail{me.email ? ` (${me.email})` : ""}</div>
    </>
  );
}

// Prévient le joueur quand une de ses réservations change pendant qu'il a l'appli ouverte
const NEWS = { confirmee: "est confirmée", acceptee: "est acceptée par le coach", attente_joueurs: "est acceptée (en attente d'autres joueurs)" };
function announce(before, after) {
  if (!before) return;
  const old = Object.fromEntries(before.upcoming.filter((s) => s.booking_id).map((s) => [s.booking_id, s.status]));
  for (const s of after.upcoming) {
    if (s.booking_id && old[s.booking_id] && old[s.booking_id] !== s.status && NEWS[s.status]) {
      toast(`Votre séance du ${dayLabel(s.start)} à ${hhmm(s.start)} ${NEWS[s.status]}`);
    }
  }
}

export default function PlayerApp() {
  const [[tab0 = "home", sub], setTab] = useRoute("home");
  const tab = tab0 === "mine" ? "planning" : tab0; // ancien lien « Mes séances »
  const [data, setData] = useState(null);
  const last = useRef(null); // séances du chargement précédent: pour annoncer une validation du coach
  const load = () =>
    Promise.all([api("/me"), api("/me/sessions"), api("/me/progress"), api("/me/credits"), api("/me/proposals"), api("/me/promotions").catch(() => []), api("/me/events").catch(() => [])])
      .then(([me, sessions, progress, credits, proposals, promos, events]) => {
        announce(last.current, sessions); // hors de setData: une mise à jour d'état doit rester pure
        last.current = sessions;
        setData({ me, sessions, progress, credits, proposals, promos, events });
      });
  useEffect(() => { load(); }, []);
  useLive(load); // la validation du coach apparaît sans se reconnecter
  if (!data) return <main><Loading hero rows={3} /></main>;
  const props = { ...data, go: setTab, reload: load };
  const todo = data.events.filter((e) => toDate(e.start) <= new Date() && !e.result && e.rating == null).length;
  const TABS = [["home", "home", "Accueil"], ["progress", "activity", "Progression"], ["book", "calendar", "Réserver"], ["planning", "list", "Planning"], ["credits", "wallet", "Crédits"]];
  const badge = { home: data.proposals.length, planning: todo };
  return (
    <>
      <OfflineBar />
      <main id="main">
        {tab === "home" && <Home {...props} />}
        {tab === "progress" && <Progression {...props} />}
        {tab === "book" && <Book {...props} key={sub ?? ""} coachParam={sub} />}
        {tab === "coach" && <CoachPage id={+sub} go={setTab} onBack={() => (history.length > 1 ? history.back() : setTab("book"))} />}
        {tab === "planning" && <Planning {...props} />}
        {tab === "credits" && <Credits {...props} />}
      </main>
      <nav>
        {TABS.map(([k, icon, label]) => (
          <button key={k} className={(tab === "coach" ? "book" : tab) === k ? "on" : ""} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
            <span className="navico"><Icon name={icon} size={22} strokeWidth={tab === k ? 2.3 : 1.8} />{badge[k] > 0 && <b className="navbadge">{badge[k]}</b>}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="topbtns"><button onClick={() => { setToken(null); location.reload(); }} title="Se déconnecter" aria-label="Se déconnecter"><Icon name="logout" size={17} /></button></div>
    </>
  );
}
