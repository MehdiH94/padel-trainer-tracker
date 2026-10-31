import { useEffect, useMemo, useState } from "react";
import { api, dayKey, dayLabel, hhmm, setToken, tnd, toDate } from "./api.js";
import Icon from "./Icon.jsx";
import { Avatar, CategoryBadge, KIND, RadarChart } from "./ui.jsx";

const TZ = "Africa/Tunis";
const REASONS = { recharge: "Recharge", reservation: "Réservation", remboursement: "Remboursement", ajustement: "Ajustement" };
const STATUS_TXT = { en_attente: "En attente du coach", acceptee: "Terrain à confirmer", confirmee: "Confirmée" };
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

function cancelBooking(me, b, reload) {
  const soon = toDate(b.start) - Date.now() < me.cancel_hours * 3600000;
  const ok = window.confirm(soon && b.status !== "en_attente"
    ? `Annulation à moins de ${me.cancel_hours} h de la séance : vos crédits ne seront PAS remboursés. Annuler quand même ?`
    : "Annuler cette séance ? Vos crédits seront remboursés.");
  if (ok) return api(`/me/bookings/${b.booking_id}/cancel`, { method: "POST" }).then(reload);
}

// ---------------------------------------------------------------- Accueil
function Home({ me, sessions, progress, credits, proposals, go, reload }) {
  const next = sessions.upcoming[0];
  const sessionsLeft = me.prices.individuel ? Math.floor(me.credits_millimes / me.prices.individuel) : null;
  const answer = (p, what) => api(`/me/proposals/${p.id}/${what}`, { method: "POST" }).then(reload).catch((x) => window.alert(x.message));
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
            {sessionsLeft !== null && <div className="hero-top">≈ {sessionsLeft} séance{sessionsLeft > 1 ? "s" : ""} individuelle{sessionsLeft > 1 ? "s" : ""}</div>}
          </div>
          <CategoryBadge category={me.category} gender={me.gender} />
        </div>
      </div>

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
        </>
      )}

      <h2>Ma prochaine séance</h2>
      {next ? (
        <div className="card ticket">
          <DateBlock iso={next.start} />
          <div style={{ flex: 1 }}>
            <div className="time">{hhmm(next.start)} <span className="mut">· {next.duration_min} min</span></div>
            <KindPill kind={next.kind} />
            {next.club && <div className="mut" style={{ marginTop: 4 }}><Icon name="pin" size={13} /> {next.club}</div>}
            <div className={"status-line " + next.status}>{STATUS_TXT[next.status] ?? "Confirmée"}</div>
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
              <div className="legend" style={{ justifyContent: "center" }}><span><i style={{ background: "#2563eb" }} />Actuel</span><span><i style={{ background: "#94a3b8" }} />Évaluation précédente</span></div>
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
          <b style={{ color: t.amount_millimes > 0 ? "#16a34a" : "#dc2626" }}>{t.amount_millimes > 0 ? "+" : ""}{tnd(t.amount_millimes)}</b>
        </div>
      ))}
      {!credits.length && <div className="card mut">Aucun mouvement. Demandez une recharge à votre coach.</div>}
    </>
  );
}

// ---------------------------------------------------------------- Réserver
function Suggestion({ s, me, onJoined }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const after = me.credits_millimes - s.price_millimes;
  const join = async () => {
    try { onJoined(await api("/me/book", { method: "POST", body: { session_id: s.session_id } }), s); } catch (x) { setErr(x.message); }
  };
  return (
    <div className="card sugg">
      <div className="row g10" style={{ alignItems: "flex-start" }}>
        <DateBlock iso={s.start} />
        <div style={{ flex: 1 }}>
          <div className="row"><b>{hhmm(s.start)} · {s.duration_min} min</b><KindPill kind={s.kind} /></div>
          <span className={"match " + s.match}>{s.match === "ideal" ? <><Icon name="star" size={12} /> Idéal pour vous</> : "Proche de votre demande"}</span>
          {s.club && <div className="mut"><Icon name="pin" size={13} /> {s.club}</div>}
          <div className="partners">
            {s.players.map((p) => <span key={p.name} className="partner"><Avatar name={p.name} size={22} /> {p.name.split(" ")[0]} <CategoryBadge category={p.category} /></span>)}
          </div>
          <div className="mut">{s.spots_left} place{s.spots_left > 1 ? "s" : ""} libre{s.spots_left > 1 ? "s" : ""} sur {s.capacity} · <b>{tnd(s.price_millimes)}</b></div>
        </div>
      </div>
      {!open ? (
        <div className="actions"><button onClick={() => setOpen(true)}>Rejoindre</button></div>
      ) : (
        <div className="confirm-box">
          <div className="row"><span className="mut">Solde après réservation</span><b className={after < 0 ? "red" : ""}>{tnd(after)}</b></div>
          {after < 0 && <div className="err">Crédits insuffisants : rechargez auprès de {me.coach_name}.</div>}
          {err && <div className="err">{err}</div>}
          <div className="actions">
            <button disabled={after < 0} onClick={join}>Confirmer</button>
            <button className="sec" onClick={() => setOpen(false)}>Retour</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Book({ me, reload, go }) {
  const [kinds, setKinds] = useState(me.pref_kinds);
  const [sugg, setSugg] = useState(null);
  const [hidden, setHidden] = useState([]);
  const [slots, setSlots] = useState(null);
  const [day, setDay] = useState(null);
  const [slot, setSlot] = useState(null);
  const [slotKind, setSlotKind] = useState(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);

  useEffect(() => { api("/me/slots").then(setSlots); }, []);
  useEffect(() => { api(`/me/suggestions?kinds=${kinds.join(",")}`).then(setSugg); }, [kinds.join(",")]);
  const days = useMemo(() => {
    const m = {};
    (slots ?? []).forEach((s) => (m[dayKey(s)] ||= []).push(s));
    return Object.entries(m);
  }, [slots]);
  useEffect(() => { if (days.length && !day) setDay(days[0][0]); }, [days]);

  const toggle = (k) => setKinds(kinds.includes(k) ? (kinds.length > 1 ? kinds.filter((x) => x !== k) : kinds) : [...kinds, k]);
  const all = kinds.length === 3;
  const kind = kinds.includes(slotKind) ? slotKind : kinds[0];
  const price = me.prices[kind];
  const after = me.credits_millimes - price;

  async function bookNew() {
    setErr("");
    try {
      setDone({ ...(await api("/me/book", { method: "POST", body: { kind, start: slot } })), start: slot, kind });
      reload();
    } catch (x) {
      setErr(x.message);
    }
  }

  if (done) {
    const confirmed = done.status === "confirmee";
    return (
      <div className="card empty success">
        <div className={"bigcheck " + (confirmed ? "ok" : "wait")}><Icon name={confirmed ? "checkCircle" : "clock"} size={44} strokeWidth={1.6} /></div>
        <h1>{confirmed ? "Séance réservée !" : "Demande envoyée"}</h1>
        <b style={{ textTransform: "capitalize" }}>{dayLabel(done.start)} à {hhmm(done.start)}</b>
        <p className="mut">{confirmed ? `${me.coach_name} vous attend.` : `${me.coach_name} doit valider votre demande et confirmer le terrain. Vous serez remboursé en cas de refus.`}</p>
        <button onClick={() => go("mine")}>Voir mes séances</button>
      </div>
    );
  }

  const visible = (sugg ?? []).filter((s) => !hidden.includes(s.session_id));
  return (
    <>
      <h1>Réserver</h1>

      <h2 className="step"><span>1</span> Quel type de séance ?</h2>
      <div className="kindcards">
        {Object.entries(KIND).map(([k, v]) => (
          <button key={k} className={"kindcard" + (kinds.includes(k) ? " on" : "")} style={{ "--c": v.color }} onClick={() => toggle(k)}>
            <span className="ki"><Icon name={v.icon} size={22} /></span>
            <b>{v.label}</b>
            <small>{v.short}</small>
            <em>{tnd(me.prices[k])}</em>
            {kinds.includes(k) && <span className="tick"><Icon name="check" size={12} strokeWidth={3} /></span>}
          </button>
        ))}
      </div>
      <button className={"chip" + (all ? " on" : "")} onClick={() => setKinds(all ? [kinds[0]] : ["individuel", "duo", "groupe"])}>
        <Icon name="sparkles" size={14} /> Pas de préférence
      </button>

      <h2 className="step"><span>2</span> Séances déjà prévues pour vous</h2>
      <div className="mut" style={{ marginTop: -4, marginBottom: 8 }}>Selon votre classement ({me.category}) et vos choix. Rejoindre une séance existante est souvent le plus rapide.</div>
      {sugg === null && <div className="card mut">Recherche…</div>}
      {sugg !== null && visible.length === 0 && <div className="card mut">Aucune séance existante ne correspond pour le moment. Créez un nouveau créneau ci-dessous.</div>}
      {visible.map((s) => (
        <div key={s.session_id}>
          <Suggestion s={s} me={me} onJoined={(r, sess) => { setDone({ ...r, start: sess.start }); reload(); }} />
          <button className="link center" onClick={() => setHidden([...hidden, s.session_id])}>Pas pour moi</button>
        </div>
      ))}

      <h2 className="step"><span>3</span> Ou choisissez un nouveau créneau</h2>
      {slots === null && <div className="card mut">Chargement…</div>}
      {days.length === 0 && slots !== null && <div className="card mut">Aucun créneau disponible pour le moment.</div>}
      {days.length > 0 && (
        <>
          <div className="daystrip">
            {days.map(([k, list]) => (
              <button key={k} className={"daypill" + (day === k ? " on" : "")} onClick={() => { setDay(k); setSlot(null); }}>
                <span>{fmt(list[0], { weekday: "short" }).replace(".", "")}</span>
                <b>{fmt(list[0], { day: "numeric" })}</b>
                <small>{fmt(list[0], { month: "short" }).replace(".", "")}</small>
              </button>
            ))}
          </div>
          <div className="timegrid">
            {(days.find(([k]) => k === day)?.[1] ?? []).map((s) => (
              <button key={s} className={"timepill" + (slot === s ? " on" : "")} onClick={() => setSlot(s)}>{hhmm(s)}</button>
            ))}
          </div>
        </>
      )}
      {slot && (
        <div className="card confirm">
          <div className="row"><b style={{ textTransform: "capitalize" }}>{dayLabel(slot)} · {hhmm(slot)}</b><span className="mut">{me.slot_minutes} min</span></div>
          {kinds.length > 1 && (
            <div className="seg" style={{ margin: "10px 0" }}>
              {kinds.map((k) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setSlotKind(k)}>{KIND[k].label}</button>)}
            </div>
          )}
          {kind !== "individuel" && <div className="mut"><Icon name="users" size={13} /> Les autres places seront proposées à des joueurs de votre niveau.</div>}
          <div className="row"><span className="mut">Prix</span><b>{tnd(price)}</b></div>
          <div className="row"><span className="mut">Solde après réservation</span><b className={after < 0 ? "red" : ""}>{tnd(after)}</b></div>
          {after < 0 && <div className="err">Crédits insuffisants : rechargez auprès de {me.coach_name}.</div>}
          {err && <div className="err">{err}</div>}
          <button style={{ width: "100%", marginTop: 8 }} disabled={after < 0} onClick={bookNew}>Confirmer la réservation</button>
          <div className="mut" style={{ marginTop: 6 }}>Annulation remboursée jusqu'à {me.cancel_hours} h avant la séance.</div>
        </div>
      )}
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
                {s.club && <div className="mut" style={{ marginTop: 4 }}><Icon name="pin" size={13} /> {s.club}</div>}
                {s.partners.length > 0 && <div className="partners">{s.partners.map((x) => <span key={x.name} className="partner"><Avatar name={x.name} size={20} /> {x.name.split(" ")[0]}</span>)}</div>}
                <div className={"status-line " + s.status}>{STATUS_TXT[s.status] ?? "Confirmée"}</div>
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
  const [tab, setTab] = useState("home");
  const [data, setData] = useState(null);
  const load = () =>
    Promise.all([api("/me"), api("/me/sessions"), api("/me/progress"), api("/me/credits"), api("/me/proposals")])
      .then(([me, sessions, progress, credits, proposals]) => setData({ me, sessions, progress, credits, proposals }));
  useEffect(() => { load(); }, []);
  if (!data) return null;
  const props = { ...data, go: setTab, reload: load };
  const TABS = [["home", "home", "Accueil"], ["book", "calendar", "Réserver"], ["mine", "ball", "Mes séances"]];
  return (
    <>
      <main>
        {tab === "home" && <Home {...props} />}
        {tab === "book" && <Book {...props} />}
        {tab === "mine" && <Mine {...props} />}
      </main>
      <nav>
        {TABS.map(([k, icon, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            <span className="navico"><Icon name={icon} size={22} strokeWidth={tab === k ? 2.3 : 1.8} />{k === "home" && data.proposals.length > 0 && <b className="navbadge">{data.proposals.length}</b>}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="topbtns"><button onClick={() => { setToken(null); location.reload(); }} title="Se déconnecter"><Icon name="logout" size={17} /></button></div>
    </>
  );
}
