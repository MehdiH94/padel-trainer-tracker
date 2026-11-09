import { useEffect, useRef, useState } from "react";
import { api, dayKey, dayLabel, hhmm, setToken, tnd, toDate, useLive } from "./api.js";
import Icon from "./Icon.jsx";
import { Modal, toast, toastError } from "./feedback.jsx";
import { Book, CoachPage } from "./PlayerBook.jsx";
import { GroupPage } from "./PlayerGroup.jsx";
import { Planning } from "./PlayerPlanning.jsx";
import { Credits, Progression } from "./PlayerProgress.jsx";
import { DateBlock, KindPill, statusText, TZ } from "./PlayerShared.jsx";
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

// Autre horaire proposé par le coach (comme une invitation de réunion): accepter = séance acceptée à ce nouvel horaire
export const answerProposal = (bookingId, yes, reload) => api(`/me/bookings/${bookingId}/proposal`, { method: "POST", body: { accept: yes } })
  .then(() => { toast(yes ? "C'est noté : séance acceptée à ce nouvel horaire" : "Proposition refusée"); reload(); })
  .catch(toastError);

function ProposalCard({ s, reload }) {
  return (
    <div className="card proposal-card">
      <div className="mut small-p"><b>{s.coach_name}</b> ne peut pas <s>{dayLabel(s.start)} à {hhmm(s.start)}</s>, mais vous propose :</div>
      <div className="row g10" style={{ alignItems: "flex-start", marginTop: 6 }}>
        <DateBlock iso={s.proposed_start} />
        <div style={{ flex: 1 }}>
          <b>{hhmm(s.proposed_start)} · {s.proposed_minutes} min</b>
          <div><KindPill kind={s.kind} /></div>
        </div>
      </div>
      <div className="actions">
        <button onClick={() => answerProposal(s.booking_id, true, reload)}><Icon name="check" size={16} /> Accepter</button>
        <button className="sec" onClick={() => answerProposal(s.booking_id, false, reload)}>Refuser</button>
      </div>
    </div>
  );
}

// Notifications de l'appli: messages des coachs (promotions, places libres, invitations, horaires proposés)
// et suivi des réservations. Ouvrir la liste les marque comme lues.
const NOTIF_ICON = { promo: "sparkles", place: "pin", invitation: "users", invitation_groupe: "users", contre_proposition: "clock", message: "bell" };
function Notifications({ data, go, reload, onClose }) {
  useEffect(() => { if (data.unread) api("/me/notifications/read", { method: "POST" }).catch(() => {}); }, []);
  const book = (n) => {
    try { sessionStorage.setItem("book-filters", JSON.stringify({ ...JSON.parse(sessionStorage.getItem("book-filters") || "{}"), coachIds: n.coach_id ? [n.coach_id] : [] })); } catch { /* stockage indisponible */ }
    onClose();
    go("book");
  };
  return (
    <Modal onClose={onClose} label="Notifications">
      <div className="row"><b className="sheet-title">Notifications</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      {data.items.length === 0 && <p className="mut">Aucune notification pour l'instant.</p>}
      {data.items.map((n) => (
        <div key={n.id} className={"notif" + (n.read ? "" : " unread")}>
          <span className="news-ico"><Icon name={NOTIF_ICON[n.kind] ?? "bell"} size={16} /></span>
          <div style={{ flex: 1 }}>
            <b className="notif-title">{n.title}</b>
            <div className="mut small-p">{dayLabel(n.created_at)} · {hhmm(n.created_at)}</div>
            <div className="notif-body">{n.body}</div>
            {n.proposal?.open && (
              <div className="actions">
                <button className="small" onClick={() => { onClose(); answerProposal(n.proposal.booking_id, true, reload); }}>Accepter</button>
                <button className="small sec" onClick={() => { onClose(); answerProposal(n.proposal.booking_id, false, reload); }}>Refuser</button>
              </div>
            )}
            {(n.kind === "promo" || n.kind === "place") && <button className="small sec" style={{ marginTop: 6 }} onClick={() => book(n)}>Voir les créneaux</button>}
            {n.kind === "invitation_groupe" && n.group_token && <button className="small" style={{ marginTop: 6 }} onClick={() => { onClose(); go(`groupe/${n.group_token}`); }}>Voir l'invitation</button>}
            {n.kind === "invitation" && <button className="small sec" style={{ marginTop: 6 }} onClick={() => { onClose(); go("home"); }}>Voir la proposition</button>}
          </div>
        </div>
      ))}
    </Modal>
  );
}

// Accueil: ce qui compte maintenant. La prochaine séance (en couleur, orange le jour même), un impayé s'il y en a,
// réserver, puis « Quoi de neuf » (propositions, promotions, retours des coachs, résultats à saisir, absences):
// rien quand il n'y a rien de neuf. La progression détaillée est dans son onglet.
const DAY = 86400000;
const recent = (iso, days) => iso && Date.now() - toDate(iso).getTime() < days * DAY;

function NextSession({ s, go }) {
  if (!s) return <div className="next-card empty"><Icon name="calendar" size={18} /> Aucune séance prévue : réservez la prochaine !</div>;
  const start = toDate(s.start);
  const today = dayKey(s.start) === dayKey(new Date().toISOString());
  const hoursLeft = Math.round((start - Date.now()) / 3600000);
  const when = today ? (hoursLeft <= 0 ? "En cours" : `Aujourd'hui · dans ${hoursLeft} h`) : hoursLeft < 48 && dayKey(new Date(Date.now() + DAY).toISOString()) === dayKey(s.start) ? "Demain" : dayLabel(s.start);
  return (
    <button className={"next-card" + (today ? " today" : "")} onClick={() => go("planning")}>
      <span className="next-label">Prochaine séance</span>
      <span className="next-when cap1">{when}</span>
      <span className="next-time">{hhmm(s.start)} <small>· {s.duration_min} min · {KIND_LABEL[s.kind]}</small></span>
      <span className="next-where"><Icon name="user" size={13} /> {s.coach_name}{s.club && <> · <Icon name="pin" size={13} /> {s.club}</>}</span>
      <span className={"next-status " + s.status}>{statusText(s)}</span>
    </button>
  );
}
const KIND_LABEL = { individuel: "Seul", duo: "À deux", groupe: "En groupe" };

function Home({ me, sessions, progress, proposals, promos, events, go, reload }) {
  const answer = (p, what) => api(`/me/proposals/${p.id}/${what}`, { method: "POST" })
    .then(() => { toast(what === "accept" ? "C'est noté, vous êtes inscrit !" : "Proposition refusée"); reload(); })
    .catch(toastError);
  const debts = me.wallets.filter((w) => w.due_millimes > 0);
  // « Quoi de neuf »: seulement ce qui est récent ou à faire
  const news = [];
  const last = progress?.last_session;
  if (last && recent(last.start, 7)) news.push({ k: "fb", icon: "message", tone: "ok", text: <>Nouveau retour de votre coach sur la séance du {dayLabel(last.start)}</>, go: "progress" });
  events.filter((e) => e.coach_feedback && recent(e.feedback_at, 14)).forEach((e) => news.push({ k: "m" + e.id, icon: "swords", tone: "ok", text: <><b>{e.coach_name}</b> a commenté votre {e.kind === "tournoi" ? "tournoi" : "match"} du {dayLabel(e.start)}</>, go: "planning" }));
  events.filter((e) => e.kind !== "autre" && toDate(e.start) < new Date() && recent(e.start, 14) && !e.result && e.rating == null).forEach((e) => news.push({ k: "r" + e.id, icon: "edit", tone: "warn", text: <>Comment s'est passé votre {e.kind === "tournoi" ? "tournoi" : "match"} du {dayLabel(e.start)} ? Ajoutez le résultat.</>, go: "planning" }));
  sessions.upcoming.filter((s) => s.status === "invitation" && s.group).forEach((s) => news.push({ k: "g" + s.booking_id, icon: "users", tone: "ok", text: <><b>{s.group.host}</b> vous invite à un entraînement le {dayLabel(s.start)} à {hhmm(s.start)}</>, go: `groupe/${s.group.token}` }));
  (me.absences ?? []).forEach((a, i) => news.push({ k: "a" + i, icon: "sun", tone: "warn", text: <><b>{a.coach_name}</b> {absenceText(a)}</> }));
  const counters = sessions.upcoming.filter((s) => s.status === "contre_proposition"); // autre horaire proposé par le coach
  const nothing = !proposals.length && !promos.length && !news.length && !counters.length;
  return (
    <>
      <div className="hero home-hero">
        <div className="hero-top">{me.coach_name ? `Votre coach · ${me.coach_name}` : "Bienvenue sur Padel Coach"}</div>
        <div className="row"><h1>Salut {me.name.split(" ")[0]}</h1><CategoryBadge category={me.category} /></div>
        <NextSession s={sessions.upcoming[0]} go={go} />
      </div>

      <VerifyBanner me={me} />
      {debts.map((w) => (
        <button key={w.coach_id} className="debt-card" onClick={() => go("credits")}>
          <Icon name="wallet" size={20} />
          <span><b>Vous devez {tnd(w.due_millimes)} à {w.coach_name}</b><small>À régler directement auprès de votre coach.</small></span>
          <Icon name="chevR" size={16} />
        </button>
      ))}
      {!me.coach_name && (
        <div className="card" style={{ marginBottom: 10 }}>
          <b><Icon name="users" size={16} /> Choisissez votre coach</b>
          <div className="mut small-p">Vous n'avez pas encore de coach : découvrez-les dans « Réserver », avec leur page, leurs clubs et leurs prix. Votre première réservation vous rattache au coach choisi.</div>
        </div>
      )}
      <button className="cta" onClick={() => go("book")}><Icon name="calendar" size={20} /> Réserver une séance <Icon name="chevR" size={18} /></button>
      <InstallCard />

      {!nothing && <h2 className="accent-h"><Icon name="sparkles" size={16} /> Quoi de neuf</h2>}
      {counters.map((s) => <ProposalCard key={s.booking_id} s={s} reload={reload} />)}
      {proposals.map((p) => (
        <div className="card proposal" key={p.id}>
          <div className="row g10" style={{ alignItems: "flex-start" }}>
            <DateBlock iso={p.start} />
            <div style={{ flex: 1 }}>
              <div className="mut small-p"><b>{p.coach_name}</b> vous propose une séance</div>
              <div className="row"><b>{hhmm(p.start)} · {p.duration_min} min</b><KindPill kind={p.kind} /></div>
              {p.club && <div className="mut"><Icon name="pin" size={13} /> {p.club}</div>}
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
      {promos.map((p) => (
        <div className="card promo-card" key={p.id}>
          <div className="row g10" style={{ alignItems: "flex-start" }}>
            <DateBlock iso={p.start} />
            <div style={{ flex: 1 }}>
              <div className="row"><b>{hhmm(p.start)} · {p.club}</b><span className="promo-tag">{reduction(p)}</span></div>
              <div className="mut"><Icon name="user" size={13} /> {p.coach_name} · terrain déjà réservé</div>
            </div>
          </div>
          <button style={{ width: "100%", marginTop: 10 }} onClick={() => bookPromo(p, go)}>J'en profite</button>
        </div>
      ))}
      {news.length > 0 && (
        <div className="news">
          {news.map((n) => (
            <button key={n.k} className={"news-row " + n.tone} onClick={() => n.go && go(n.go)} disabled={!n.go}>
              <span className="news-ico"><Icon name={n.icon} size={16} /></span>
              <span className="news-txt">{n.text}</span>
              {n.go && <Icon name="chevR" size={15} />}
            </button>
          ))}
        </div>
      )}
      {/* Version bêta: rappels et confirmations uniquement par e-mail */}
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
  const [bell, setBell] = useState(false); // liste des notifications ouverte
  const last = useRef(null); // séances du chargement précédent: pour annoncer une validation du coach
  const load = () =>
    Promise.all([api("/me"), api("/me/sessions"), api("/me/progress"), api("/me/credits"), api("/me/proposals"), api("/me/promotions").catch(() => []), api("/me/events").catch(() => []),
      api("/me/notifications").catch(() => ({ items: [], unread: 0 }))])
      .then(([me, sessions, progress, credits, proposals, promos, events, notifs]) => {
        announce(last.current, sessions); // hors de setData: une mise à jour d'état doit rester pure
        last.current = sessions;
        setData({ me, sessions, progress, credits, proposals, promos, events, notifs });
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
        {tab === "groupe" && <GroupPage token={sub} {...props} />}
      </main>
      <nav>
        {TABS.map(([k, icon, label]) => (
          <button key={k} className={(tab === "coach" ? "book" : tab) === k ? "on" : ""} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
            <span className="navico"><Icon name={icon} size={22} strokeWidth={tab === k ? 2.3 : 1.8} />{badge[k] > 0 && <b className="navbadge">{badge[k]}</b>}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="topbtns">
        <button className="bell" onClick={() => setBell(true)} title="Notifications" aria-label={`Notifications${data.notifs.unread ? ` (${data.notifs.unread} non lues)` : ""}`}>
          <Icon name="bell" size={17} />{data.notifs.unread > 0 && <b className="navbadge">{data.notifs.unread}</b>}
        </button>
        <button onClick={() => { setToken(null); location.reload(); }} title="Se déconnecter" aria-label="Se déconnecter"><Icon name="logout" size={17} /></button>
      </div>
      {bell && <Notifications data={data.notifs} go={setTab} reload={load} onClose={() => { setBell(false); load(); }} />}
    </>
  );
}
