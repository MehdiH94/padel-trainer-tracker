import { useEffect, useRef, useState } from "react";
import { api, dayLabel, hhmm, setToken, tnd, toDate, useLive } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { Book, CoachPage } from "./PlayerBook.jsx";
import { VerifyBanner } from "./VerifyEmail.jsx";
import { useRoute } from "./router.js";
import { Avatar, CategoryBadge, InstallCard, KIND, Loading, OfflineBar, RadarChart, reduction } from "./ui.jsx";

const TZ = "Africa/Tunis";
const REASONS = { recharge: "Recharge", reservation: "Réservation", remboursement: "Remboursement", ajustement: "Ajustement", seance: "Séance effectuée", seance_annulee: "Séance effectuée" };
const STATUS_TXT = { en_attente: "En attente du coach", attente_joueurs: "En attente d'autres joueurs", acceptee: "Terrain à confirmer", confirmee: "Confirmée" };
const statusText = (s) => (s.status === "attente_joueurs" ? `En attente d'autres joueurs (${s.players_count}/${s.min_needed})` : STATUS_TXT[s.status] ?? "Confirmée");
const HOW = { individuel: "Seul", duo: "À deux", groupe: "En groupe" };

// Groupe pas encore formé: le joueur peut passer à une autre formule (ex. seul) ou annuler (remboursé)
function Reconsider({ s, reload }) {
  const [open, setOpen] = useState(false);
  const change = (kind) => api(`/me/bookings/${s.booking_id}/formula`, { method: "POST", body: { kind } })
    .then((r) => { toast(r.status === "confirmee" ? `Séance confirmée · ${tnd(r.price_millimes)}` : `Formule ajoutée · prix actuel ${tnd(r.price_millimes)}`); setOpen(false); reload(); })
    .catch(toastError);
  if (s.status !== "attente_joueurs") return null;
  return (
    <div className="reconsider-box">
      <div className="small-p">Pas encore assez de joueurs. Vous pouvez attendre, accepter une autre formule (ex. seul) ou annuler (remboursé). Le prix suit la formule réellement jouée.</div>
      {!open ? <button className="small sec" onClick={() => setOpen(true)}>Accepter une autre formule</button> : (
        <div className="chips">{Object.keys(HOW).filter((k) => !(s.accepted_kinds ?? []).includes(k)).map((k) => <button key={k} className="chip small" onClick={() => change(k)}>Accepter aussi : {HOW[k].toLowerCase()}</button>)}</div>
      )}
    </div>
  );
}
const fmt = (iso, o) => toDate(iso).toLocaleDateString("fr-FR", { ...o, timeZone: TZ });

function DateBlock({ iso }) {
  return (
    <div className="dateblock">
      <span>{fmt(iso, { weekday: "short" }).replace(".", "")}</span>
      <b>{fmt(iso, { day: "numeric" })}</b>
      <span>{fmt(iso, { month: "short" }).replace(".", "")}</span>
    </div>
  );
}

function KindPill({ kind }) {
  const k = KIND[kind];
  return <span className="kind-pill" style={{ background: k.color + "1a", color: k.color }}><Icon name={k.icon} size={13} /> {k.label}</span>;
}

async function cancelBooking(b, reload) {
  const ok = await confirmDialog({
    title: "Annuler cette séance ?",
    message: b.status === "en_attente" ? "Votre demande sera retirée." : "Vos crédits vous seront remboursés.",
    confirm: "Annuler la séance", cancel: "Garder ma séance",
  });
  if (!ok) return;
  try {
    const r = await api(`/me/bookings/${b.booking_id}/cancel`, { method: "POST" });
    toast(r.refunded_millimes ? `Séance annulée · ${tnd(r.refunded_millimes)} remboursés` : "Séance annulée");
    reload();
  } catch (x) {
    toastError(x);
  }
}

// Choix du moyen de contact pour les rappels: imposé à la première connexion, modifiable ensuite
// ---------------------------------------------------------------- Accueil
// Promotion d'un coach: ouvre la réservation sur ce coach et ce jour
function bookPromo(p, go) {
  try {
    sessionStorage.setItem("book-filters", JSON.stringify({ coachId: p.coach_id, day: toDate(p.start).toLocaleDateString("fr-CA", { timeZone: TZ }), kinds: ["individuel", "duo", "groupe"], period: "", hour: "", club: "" }));
  } catch { /* stockage indisponible */ }
  go("book");
}

// Annulation: jusqu'à 24 h avant (seul) ou 48 h avant (à deux, en groupe). Après, le bouton reste visible (autre couleur):
// un clic explique le délai et propose d'envoyer un lien pour qu'un autre joueur prenne sa place (ses crédits lui sont alors rendus).
function CancelBox({ s, reload }) {
  const [url, setUrl] = useState(null);
  const [open, setOpen] = useState(false); // explication affichée seulement si le joueur clique sur « Annuler »
  if (!s.booking_id && !s.session_id) return null;
  // Séance montée par le coach: la réservation est créée au moment d'annuler ou de céder sa place
  const bookingId = async () => s.booking_id ?? (await api(`/me/sessions/${s.session_id}/booking`, { method: "POST" })).booking_id;
  const when = (iso) => `${dayLabel(iso)} à ${hhmm(iso)}`;
  if (s.can_cancel) {
    return (
      <div className="cancel-row">
        <button className="small sec" onClick={async () => { try { cancelBooking({ ...s, booking_id: await bookingId() }, reload); } catch (x) { toastError(x); } }}>Annuler</button>
        {s.cancel_until && <small className="mut">Annulable jusqu'au {when(s.cancel_until)}</small>}
      </div>
    );
  }
  const h = s.booking_kind === "individuel" ? 24 : 48;
  const get = () => bookingId().then((id) => api(`/me/bookings/${id}/replacement`, { method: "POST" })).then((r) => setUrl(location.origin + r.path)).catch(toastError);
  const msg = url && `Je ne peux plus venir à ma séance de padel du ${when(s.start)} avec ${s.coach_name}${s.club ? ` (${s.club})` : ""}. Tu veux prendre ma place ? ${url}`;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ text: msg });
      else { await navigator.clipboard.writeText(msg); toast("Message copié"); }
    } catch { /* partage annulé */ }
  };
  return (
    <div className="cancel-row">
      <button className="small sec late-btn" onClick={() => setOpen(true)}>Annuler</button>
      {open && (
        <Modal onClose={() => setOpen(false)} label="Annulation impossible">
          <div className="row"><b className="sheet-title">Trop tard pour annuler</b><button className="small sec iconbtn" aria-label="Fermer" onClick={() => setOpen(false)}><Icon name="x" size={15} /></button></div>
          <p className="small-p">Une séance {s.booking_kind === "individuel" ? "seul" : "à deux ou en groupe"} s'annule au plus tard {h} h avant son début.</p>
          <p className="small-p">Vous pouvez quand même vous faire remplacer : envoyez le lien de la séance à un ami. Dès qu'il prend votre place, vos crédits vous sont rendus.</p>
          {!url ? (
            <div className="actions" style={{ flexDirection: "column" }}>
              <button onClick={get}><Icon name="users" size={15} /> Me faire remplacer</button>
              <button className="sec" onClick={() => setOpen(false)}>Garder ma séance</button>
            </div>
          ) : (
            <div className="replace-share">
              <input readOnly value={url} aria-label="Lien de la séance" onFocus={(e) => e.target.select()} />
              <div className="actions">
                <a className="btnlink wa" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={15} /> WhatsApp</a>
                <button className="small sec" onClick={share}><Icon name="send" size={14} /> Partager</button>
                <button className="small sec" onClick={() => navigator.clipboard?.writeText(url).then(() => toast("Lien copié"))}><Icon name="copy" size={14} /> Copier</button>
              </div>
              <small className="mut">Vous serez prévenu dès que quelqu'un prend votre place.</small>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// « 12 décembre » à partir de « 2026-12-12 »
const shortDay = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });

function Home({ me, sessions, progress, credits, proposals, promos, go, reload }) {
  const next = sessions.upcoming[0];
  // Pas de solde global: chaque coach a ses crédits (avance versée) et ses impayés (en rouge)
  const wallets = me.wallets.filter((w) => w.credits_millimes > 0 || w.due_millimes > 0);
  const answer = (p, what) => api(`/me/proposals/${p.id}/${what}`, { method: "POST" })
    .then(() => { toast(what === "accept" ? "C'est noté, vous êtes inscrit !" : "Proposition refusée"); reload(); })
    .catch(toastError);
  const rated = progress?.skills.filter((s) => s.score != null).length ?? 0;
  return (
    <>
      <div className="hero">
        <div className="hero-top">{me.coach_name ? `Votre coach · ${me.coach_name}` : "Bienvenue sur Padel Coach"}</div>
        <h1>Salut {me.name.split(" ")[0]}</h1>
        <div className="wallet" style={{ display: "block" }}>
          <div className="row" style={{ marginBottom: 2 }}>
            <div className="wlabel">Mes crédits, coach par coach</div>
            <CategoryBadge category={me.category} gender={me.gender} />
          </div>
          {wallets.length === 0 && <div className="wlabel">Aucun crédit ni impayé pour l'instant.</div>}
          {wallets.map((w) => (
            <div key={w.coach_id} className="wline">
              <span>{w.coach_name}</span>
              <span>
                {w.credits_millimes > 0 && <b>{tnd(w.credits_millimes)}</b>}
                {w.due_millimes > 0 && <b className="debt">Impayé {tnd(w.due_millimes)}</b>}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Version bêta: rappels et confirmations uniquement par e-mail (le choix WhatsApp / SMS reviendra) */}
      <div className="mut small-p"><Icon name="bell" size={14} /> Rappels et confirmations par e-mail{me.email ? ` (${me.email})` : ""}</div>

      <VerifyBanner me={me} />
      {/* Absences prochaines de ses coachs (vacances…): un petit message, sans prendre de place */}
      {(me.absences ?? []).map((a, i) => (
        <div key={i} className="note warn absence-note" role="status">
          <Icon name="sun" size={15} />
          <span><b>{a.coach_name}</b> {a.now ? "est absent jusqu'au" : `sera absent ${a.start_date === a.end_date ? "le" : "du"} ${a.start_date === a.end_date ? "" : shortDay(a.start_date) + " au"}`} {shortDay(a.end_date)}{a.reason && ` (${a.reason})`}.</span>
        </div>
      ))}
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
      {next ? (
        <div className="card ticket">
          <DateBlock iso={next.start} />
          <div style={{ flex: 1 }}>
            <div className="time">{hhmm(next.start)} <span className="mut">· {next.duration_min} min</span></div>
            <KindPill kind={next.kind} />
            <div className="mut" style={{ marginTop: 4 }}><Icon name="user" size={13} /> {next.coach_name}{next.club && <> · <Icon name="pin" size={13} /> {next.club}</>}</div>
            <div className={"status-line " + next.status}>{statusText(next)}</div>
            <Reconsider s={next} reload={reload} />
            <CancelBox s={next} reload={reload} />
          </div>
        </div>
      ) : <div className="card mut">Aucune séance prévue. Réservez la prochaine !</div>}

      {/* visible dès la première séance effectuée ou la première évaluation d'un coach */}
      {progress && (progress.stats.done_count > 0 || rated > 0) && (
        <>
          <h2>Ma progression</h2>
          {progress.stats.done_count > 0 && <div className="grid kpis">
            <div className="kpi"><span className="ico"><Icon name="ball" size={18} /></span><div className="big">{progress.stats.done_count}</div><div className="mut">Séances</div></div>
            <div className="kpi"><span className="ico"><Icon name="clock" size={18} /></span><div className="big">{progress.stats.hours} h</div><div className="mut">De jeu</div></div>
          </div>}
          {progress.goals && <div className="card"><div className="mut"><Icon name="target" size={14} /> Mon objectif</div><b>{progress.goals}</b></div>}
          {rated > 0 && (
            <div className="card">
              <b>Mon niveau technique</b>
              <RadarChart skills={progress.skills} />
              <div className="legend" style={{ justifyContent: "center" }}><span><i style={{ background: "#f97316" }} />Actuel</span><span><i style={{ background: "#94a3b8" }} />Évaluation précédente</span></div>
            </div>
          )}
          <div className="grid">
            <div className="card good"><b><Icon name="trophy" size={15} /> Points forts</b>{progress.strengths.length ? progress.strengths.map((s) => <div key={s}>• {s}</div>) : <div className="mut">À venir</div>}</div>
            <div className="card bad"><b><Icon name="target" size={15} /> À travailler</b>{progress.weaknesses.length ? progress.weaknesses.map((s) => <div key={s}>• {s}</div>) : <div className="mut">Rien de critique</div>}</div>
          </div>
          {progress.last_session && (
            <div className="card">
              <div className="mut">Dernière séance · {fmt(progress.last_session.start, { day: "numeric", month: "short" })}</div>
              <div className="chips" style={{ margin: "6px 0" }}>{progress.last_session.worked_on.map((t) => <span key={t} className="chip on small static">{t}</span>)}</div>
              {progress.last_session.note && <div>{progress.last_session.note}</div>}
              {progress.last_session.to_improve && <div className="red">À retravailler : {progress.last_session.to_improve}</div>}
            </div>
          )}
        </>
      )}

      <h2>Mes crédits</h2>
      {credits.slice(0, 5).map((t) => (
        <div className="card row" key={t.id}>
          <div className="row g10">
            <span className={"txico " + (t.amount_millimes > 0 ? "plus" : "minus")}><Icon name={t.amount_millimes > 0 ? "plus" : "arrowR"} size={14} /></span>
            <div><b>{REASONS[t.reason] ?? t.reason}</b><div className="mut">{fmt(t.created_at, { day: "numeric", month: "short" })}</div></div>
          </div>
          <b style={{ color: t.amount_millimes > 0 ? "var(--ok-txt)" : "var(--red)" }}>{t.amount_millimes > 0 ? "+" : ""}{tnd(t.amount_millimes)}</b>
        </div>
      ))}
      {!credits.length && <div className="card mut">Aucun mouvement. Demandez une recharge à votre coach.</div>}
    </>
  );
}

// ---------------------------------------------------------------- Mes séances
function Mine({ me, sessions, reload }) {
  const [view, setView] = useState("up");
  const [openId, setOpenId] = useState(null);
  const [more, setMore] = useState(false);
  const done = sessions.history.filter((h) => h.session_status === "effectuee");
  const thisMonth = done.filter((h) => fmt(h.start, { month: "numeric", year: "numeric" }) === fmt(new Date().toISOString(), { month: "numeric", year: "numeric" })).length;
  const shown = more ? done : done.slice(0, 6);
  const groups = [];
  shown.forEach((h) => {
    const m = fmt(h.start, { month: "long", year: "numeric" });
    (groups.find((g) => g[0] === m) ?? (groups.push([m, []]), groups[groups.length - 1]))[1].push(h);
  });
  return (
    <>
      <h1>Mes séances</h1>
      <div className="grid kpis">
        <div className="kpi"><span className="ico"><Icon name="calendar" size={18} /></span><div className="big">{sessions.upcoming.length}</div><div className="mut">À venir</div></div>
        <div className="kpi"><span className="ico"><Icon name="activity" size={18} /></span><div className="big">{thisMonth}</div><div className="mut">Ce mois-ci</div></div>
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={view === "up" ? "on" : ""} onClick={() => setView("up")}>À venir</button>
        <button className={view === "past" ? "on" : ""} onClick={() => setView("past")}>Passées</button>
      </div>

      {view === "up" && (
        <>
          {sessions.upcoming.length === 0 && <div className="card empty"><Icon name="calendar" size={30} /><b>Aucune séance prévue</b><div className="mut">Réservez depuis l'onglet Réserver.</div></div>}
          {sessions.upcoming.map((s, i) => (
            <div className="card ticket" key={(s.session_id ?? "b") + "-" + (s.booking_id ?? i)}>
              <DateBlock iso={s.start} />
              <div style={{ flex: 1 }}>
                <div className="time">{hhmm(s.start)} <span className="mut">· {s.duration_min} min</span></div>
                <KindPill kind={s.kind} />
                <div className="mut" style={{ marginTop: 4 }}><Icon name="user" size={13} /> {s.coach_name}{s.club && <> · <Icon name="pin" size={13} /> {s.club}</>}</div>
                {s.partners.length > 0 && <div className="partners">{s.partners.map((x) => <span key={x.name} className="partner"><Avatar name={x.name} size={20} /> {x.name.split(" ")[0]}</span>)}</div>}
                <div className={"status-line " + s.status}>{statusText(s)}</div>
                <Reconsider s={s} reload={reload} />
                <CancelBox s={s} reload={reload} />
              </div>
            </div>
          ))}
        </>
      )}

      {view === "past" && (
        <>
          {done.length === 0 && <div className="card mut">Pas encore de séance terminée.</div>}
          {groups.map(([month, list]) => (
            <div key={month}>
              <h2 className="cap1">{month}</h2>
              {list.map((h) => (
                <div className={"card past" + (openId === h.session_id ? " open" : "")} key={h.session_id} onClick={() => setOpenId(openId === h.session_id ? null : h.session_id)}>
                  <div className="row">
                    <div className="row g10">
                      <span className="kdot" style={{ background: KIND[h.kind].color }}><Icon name={KIND[h.kind].icon} size={14} /></span>
                      <div><b className="cap1">{fmt(h.start, { weekday: "short", day: "numeric", month: "short" })}</b><div className="mut">{hhmm(h.start)} · {KIND[h.kind].label}</div></div>
                    </div>
                    <div className="row g10">
                      {h.worked_on.slice(0, 1).map((t) => <span key={t} className="chip on small static">{t}</span>)}
                      {h.worked_on.length > 1 && <span className="mut">+{h.worked_on.length - 1}</span>}
                      <Icon name={openId === h.session_id ? "chevL" : "chevR"} size={16} className={openId === h.session_id ? "rot" : ""} />
                    </div>
                  </div>
                  {openId === h.session_id && (
                    <div className="editor">
                      {h.worked_on.length > 0 && <div className="chips" style={{ marginBottom: 6 }}>{h.worked_on.map((t) => <span key={t} className="chip on small static">{t}</span>)}</div>}
                      {h.note ? <div>{h.note}</div> : <div className="mut">Pas de commentaire de votre coach.</div>}
                      {h.to_improve && <div className="red" style={{ marginTop: 4 }}>À retravailler : {h.to_improve}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {!more && done.length > 6 && <button className="sec" style={{ width: "100%" }} onClick={() => setMore(true)}>Voir {done.length - 6} séance{done.length - 6 > 1 ? "s" : ""} précédente{done.length - 6 > 1 ? "s" : ""}</button>}
        </>
      )}
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
  const [[tab = "home", sub], setTab] = useRoute("home");
  const [data, setData] = useState(null);
  const last = useRef(null); // séances du chargement précédent: pour annoncer une validation du coach
  const load = () =>
    Promise.all([api("/me"), api("/me/sessions"), api("/me/progress"), api("/me/credits"), api("/me/proposals"), api("/me/promotions").catch(() => [])])
      .then(([me, sessions, progress, credits, proposals, promos]) => {
        announce(last.current, sessions); // hors de setData: une mise à jour d'état doit rester pure
        last.current = sessions;
        setData({ me, sessions, progress, credits, proposals, promos });
      });
  useEffect(() => { load(); }, []);
  useLive(load); // la validation du coach apparaît sans se reconnecter
  if (!data) return <main><Loading hero rows={3} /></main>;
  const props = { ...data, go: setTab, reload: load };
  const TABS = [["home", "home", "Accueil"], ["book", "calendar", "Réserver"], ["mine", "ball", "Mes séances"]];
  return (
    <>
      <OfflineBar />
      <main id="main">
        {tab === "home" && <Home {...props} />}
        {tab === "book" && <Book {...props} key={sub ?? ""} coachParam={sub} />}
        {tab === "coach" && <CoachPage id={+sub} go={setTab} onBack={() => (history.length > 1 ? history.back() : setTab("book"))} />}
        {tab === "mine" && <Mine {...props} />}
      </main>
      <nav>
        {TABS.map(([k, icon, label]) => (
          <button key={k} className={(tab === "coach" ? "book" : tab) === k ? "on" : ""} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
            <span className="navico"><Icon name={icon} size={22} strokeWidth={tab === k ? 2.3 : 1.8} />{k === "home" && data.proposals.length > 0 && <b className="navbadge">{data.proposals.length}</b>}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="topbtns"><button onClick={() => { setToken(null); location.reload(); }} title="Se déconnecter" aria-label="Se déconnecter"><Icon name="logout" size={17} /></button></div>
    </>
  );
}
