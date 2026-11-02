import { useEffect, useState } from "react";
import { api, dayLabel, hhmm, setToken, tnd, toDate } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { Book, CoachPage } from "./PlayerBook.jsx";
import { VerifyBanner } from "./VerifyEmail.jsx";
import { useRoute } from "./router.js";
import { Avatar, CategoryBadge, CHANNELS, ChannelPicker, InstallCard, KIND, Loading, OfflineBar, RadarChart } from "./ui.jsx";

const TZ = "Africa/Tunis";
const REASONS = { recharge: "Recharge", reservation: "Réservation", remboursement: "Remboursement", ajustement: "Ajustement" };
const STATUS_TXT = { en_attente: "En attente du coach", attente_joueurs: "En attente d'autres joueurs", acceptee: "Terrain à confirmer", confirmee: "Confirmée" };
const statusText = (s) => (s.status === "attente_joueurs" ? `En attente d'autres joueurs (${s.players_count}/${s.min_needed})` : STATUS_TXT[s.status] ?? "Confirmée");
const HOW = { individuel: "Seul", duo: "À deux", groupe: "En groupe" };

// Groupe pas encore formé: le joueur peut passer à une autre formule (ex. seul) ou annuler (remboursé)
function Reconsider({ s, reload }) {
  const [open, setOpen] = useState(false);
  const change = (kind) => api(`/me/bookings/${s.booking_id}/formula`, { method: "POST", body: { kind } })
    .then((r) => { toast(r.status === "confirmee" ? `Séance confirmée en formule « ${HOW[kind].toLowerCase()} » · ${tnd(r.price_millimes)}` : `Formule changée · ${tnd(r.price_millimes)}`); setOpen(false); reload(); })
    .catch(toastError);
  if (s.status !== "attente_joueurs") return null;
  return (
    <div className="reconsider-box">
      <div className="small-p">Pas encore assez de joueurs. Vous pouvez attendre, changer de formule ou annuler (remboursé).</div>
      {!open ? <button className="small sec" onClick={() => setOpen(true)}>Changer de formule</button> : (
        <div className="chips">{Object.keys(HOW).filter((k) => k !== s.booking_kind).map((k) => <button key={k} className="chip small" onClick={() => change(k)}>{HOW[k]}</button>)}</div>
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

async function cancelBooking(me, b, reload) {
  const late = toDate(b.start) - Date.now() < me.cancel_hours * 3600000 && b.status !== "en_attente";
  const ok = await confirmDialog({
    title: "Annuler cette séance ?",
    message: late ? `Vous êtes à moins de ${me.cancel_hours} h de la séance : vos crédits ne seront pas remboursés.` : "Vos crédits vous seront remboursés.",
    confirm: "Annuler la séance", cancel: "Garder ma séance", danger: late,
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
function ContactChoice({ me, reload, onClose }) {
  const [ch, setCh] = useState(me.contact_channel ?? "");
  const [err, setErr] = useState("");
  const save = () => api("/me/contact", { method: "PUT", body: { contact_channel: ch } }).then(() => { toast("Préférence enregistrée"); reload(); onClose?.(); }).catch((x) => setErr(x.message));
  return (
    <Modal onClose={onClose} label="Rappels de séance">
        <b className="sheet-title">{me.contact_channel ? "Mes rappels de séance" : `Bienvenue ${me.name.split(" ")[0]} !`}</b>
        <p className="mut">Vous recevrez un rappel automatique 24 h puis 2 h avant chaque séance. Comment voulez-vous être contacté ?</p>
        <ChannelPicker value={ch} onChange={setCh} />
        {ch === "email" && !me.email && <div className="err">Aucun e-mail sur votre compte : les rappels partiront par SMS.</div>}
        {err && <div className="err">{err}</div>}
        <div className="actions">
          <button disabled={!ch} onClick={save}>Valider</button>
          {onClose && <button className="sec" onClick={onClose}>Annuler</button>}
        </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Accueil
// Promotion d'un coach: ouvre la réservation sur ce coach et ce jour
function bookPromo(p, go) {
  try {
    sessionStorage.setItem("book-filters", JSON.stringify({ coachId: p.coach_id, day: toDate(p.start).toLocaleDateString("fr-CA", { timeZone: TZ }), kinds: ["individuel", "duo", "groupe"], period: "", hour: "", club: "" }));
  } catch { /* stockage indisponible */ }
  go("book");
}

function Home({ me, sessions, progress, credits, proposals, promos, go, reload }) {
  const [contact, setContact] = useState(false);
  const next = sessions.upcoming[0];
  const sessionsLeft = me.prices.individuel && me.credits_millimes > 0 ? Math.floor(me.credits_millimes / me.prices.individuel) : null;
  const answer = (p, what) => api(`/me/proposals/${p.id}/${what}`, { method: "POST" })
    .then(() => { toast(what === "accept" ? "C'est noté, vous êtes inscrit !" : "Proposition refusée"); reload(); })
    .catch(toastError);
  const rated = progress?.skills.filter((s) => s.score != null).length ?? 0;
  return (
    <>
      <div className="hero">
        <div className="hero-top">Votre coach · {me.coach_name}</div>
        <h1>Salut {me.name.split(" ")[0]}</h1>
        <div className="wallet">
          <div>
            <div className="hero-top">Mon solde de crédits</div>
            <div className="bignum">{tnd(me.credits_millimes)}</div>
            {me.credits_millimes < 0 && <div className="debt">À régler à {me.coach_name} : {tnd(-me.credits_millimes)}</div>}
            {sessionsLeft !== null && <div className="hero-top">≈ {sessionsLeft} séance{sessionsLeft > 1 ? "s" : ""} individuelle{sessionsLeft > 1 ? "s" : ""}</div>}
            {me.wallets.filter((w) => w.coach_id !== me.wallets[0].coach_id && w.credits_millimes).map((w) => (
              <div key={w.coach_id} className={w.credits_millimes < 0 ? "debt" : "hero-top"}>{w.credits_millimes < 0 ? `À régler à ${w.coach_name} : ${tnd(-w.credits_millimes)}` : `+ ${tnd(w.credits_millimes)} chez ${w.coach_name}`}</div>
            ))}
          </div>
          <CategoryBadge category={me.category} gender={me.gender} />
        </div>
      </div>

      {contact && <ContactChoice me={me} reload={reload} onClose={() => setContact(false)} />}
      {me.contact_channel && (
        <button className="link" onClick={() => setContact(true)}><Icon name="bell" size={14} /> Rappels de séance par {CHANNELS[me.contact_channel][0]} · modifier</button>
      )}

      <VerifyBanner me={me} />
      <InstallCard />
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
                  <div className="row"><b>{hhmm(p.start)} · {p.club}</b><span className="promo-tag">−{p.discount_pct} %</span></div>
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
          </div>
          {next.booking_id && <button className="small sec" onClick={() => cancelBooking(me, next, reload)}>Annuler</button>}
        </div>
      ) : <div className="card mut">Aucune séance prévue. Réservez la prochaine !</div>}

      {progress && progress.stats.done_count > 0 && (
        <>
          <h2>Ma progression</h2>
          <div className="grid kpis">
            <div className="kpi"><span className="ico"><Icon name="ball" size={18} /></span><div className="big">{progress.stats.done_count}</div><div className="mut">Séances</div></div>
            <div className="kpi"><span className="ico"><Icon name="clock" size={18} /></span><div className="big">{progress.stats.hours} h</div><div className="mut">De jeu</div></div>
          </div>
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
              </div>
              {s.booking_id ? <button className="small sec" onClick={() => cancelBooking(me, s, reload)}>Annuler</button> : null}
            </div>
          ))}
          {sessions.upcoming.some((s) => !s.booking_id && s.status !== "en_attente") && <div className="mut small-p">Pour modifier une séance fixée par {me.coach_name}, contactez-le.</div>}
        </>
      )}

      {view === "past" && (
        <>
          {done.length === 0 && <div className="card mut">Pas encore de séance terminée.</div>}
          {groups.map(([month, list]) => (
            <div key={month}>
              <h2 style={{ textTransform: "capitalize" }}>{month}</h2>
              {list.map((h) => (
                <div className={"card past" + (openId === h.session_id ? " open" : "")} key={h.session_id} onClick={() => setOpenId(openId === h.session_id ? null : h.session_id)}>
                  <div className="row">
                    <div className="row g10">
                      <span className="kdot" style={{ background: KIND[h.kind].color }}><Icon name={KIND[h.kind].icon} size={14} /></span>
                      <div><b style={{ textTransform: "capitalize" }}>{fmt(h.start, { weekday: "short", day: "numeric", month: "short" })}</b><div className="mut">{hhmm(h.start)} · {KIND[h.kind].label}</div></div>
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

export default function PlayerApp() {
  const [[tab = "home", sub], setTab] = useRoute("home");
  const [data, setData] = useState(null);
  const load = () =>
    Promise.all([api("/me"), api("/me/sessions"), api("/me/progress"), api("/me/credits"), api("/me/proposals"), api("/me/promotions").catch(() => [])])
      .then(([me, sessions, progress, credits, proposals, promos]) => setData({ me, sessions, progress, credits, proposals, promos }));
  useEffect(() => { load(); }, []);
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
      {!data.me.contact_channel && <ContactChoice me={data.me} reload={load} />}
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
