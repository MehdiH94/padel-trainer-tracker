import { useEffect, useState } from "react";
import { api, dayLabel, hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { toastError } from "./feedback.jsx";
import { Avatar, CategoryBadge, KIND, Loading } from "./ui.jsx";

const TZ = "Africa/Tunis";
const fmt = (d, o) => d.toLocaleDateString("fr-FR", { ...o, timeZone: TZ });
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const PERIODS = [["", "Toute la journée"], ["matin", "Matin"], ["apres-midi", "Après-midi"], ["soir", "Soir"]];
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const HOW = { individuel: "Seul", duo: "À deux", groupe: "En groupe" };

// Comment le joueur paiera: avec ses crédits chez ce coach s'il en a assez, sinon sur place
const payment = (me, coachId, price) => {
  const w = me.wallets.find((x) => x.coach_id === coachId);
  return w && w.credits_millimes >= price ? `Payé avec vos crédits chez ce coach (solde ${tnd(w.credits_millimes)})` : "À régler sur place auprès du coach";
};

// Prix affiché: la formule choisie une fois la carte ouverte, sinon la moins chère (« dès »)
function Price({ o, open }) {
  const opts = o.options ?? [];
  const cheapest = opts.length ? opts.reduce((a, x) => (x.price_millimes < a.price_millimes ? x : a)) : o;
  const opt = open && o.chosen ? o.chosen : cheapest;
  const base = opt.base_millimes;
  return (
    <span className="offer-price">
      {opt.discount_pct > 0 && <span className="promo-tag">{opt.reason === "promo" ? "Promo" : "Happy hour"} −{opt.discount_pct} %</span>}
      <span>{!open && opts.length > 1 && <small className="mut">dès </small>}{tnd(opt.price_millimes)}</span>
      {opt.discount_pct > 0 && base > opt.price_millimes && <span className="old-price">{tnd(base)}</span>}
    </span>
  );
}

function CourtTag({ court }) {
  return court === "reserve"
    ? <span className="court-badge ok"><Icon name="pin" size={12} /> Terrain réservé</span>
    : <span className="court-badge wait"><Icon name="clock" size={12} /> Terrain à confirmer</span>;
}

// Une proposition (groupe à rejoindre ou créneau à créer), avec confirmation sur place
function Offer({ o, me, kinds, onBooked, openCoach }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const options = o.options ?? [];
  const [pick, setPick] = useState(options[0]?.kind ?? o.kind);
  const chosen = options.find((x) => x.kind === pick) ?? options[0];
  const shown = o.type === "slot" ? { ...o, chosen } : o;
  const book = async () => {
    setBusy(true);
    try {
      const body = o.type === "group" ? { session_id: o.session_id } : { kind: pick, start: o.start, coach_id: o.coach.id, kinds };
      onBooked({ ...(await api("/me/book", { method: "POST", body })), start: o.start });
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <div className={"card offer" + (open ? " open" : "")}>
      <button className="offer-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="offer-time"><b>{hhmm(o.start)}</b><small>{(chosen ?? o).duration_min} min</small></span>
        <span className="offer-main">
          <span className="offer-coach">{o.coach.name}</span>
          <small>{o.club || "Club à confirmer"}</small>
          <span><CourtTag court={o.court} />{o.type === "group" && <span className="court-badge idle"><Icon name="users" size={12} /> {o.spots_left} place{o.spots_left > 1 ? "s" : ""}</span>}</span>
        </span>
        <Price o={shown} open={open} />
      </button>
      {o.type === "group" && (
        <div className="partners">
          {o.players.map((p) => <span key={p.name} className="partner"><Avatar name={p.name} size={22} /> {p.name.split(" ")[0]} <CategoryBadge category={p.category} /></span>)}
        </div>
      )}
      {open && (
        <div className="confirm-box">
          {options.length > 1 && (
            <div className="seg" style={{ marginBottom: 8 }} role="group" aria-label="Formule">
              {options.map((x) => (
                <button key={x.kind} className={pick === x.kind ? "on" : ""} aria-pressed={pick === x.kind} onClick={() => setPick(x.kind)}>
                  {HOW[x.kind]}<small className="seg-sub">{x.duration_min} min · {tnd(x.price_millimes)}</small>
                </button>
              ))}
            </div>
          )}
          <div className="mut small-p"><Icon name="wallet" size={13} /> {payment(me, o.coach.id, (chosen ?? o).price_millimes)}</div>
          {o.type === "slot" && pick !== "individuel" && <div className="mut small-p"><Icon name="users" size={13} /> Les autres places seront proposées à des joueurs de votre niveau.</div>}
          {o.type === "slot" && kinds.length > 1 && <div className="mut small-p"><Icon name="check" size={13} /> Le coach verra que vous acceptez aussi : {kinds.filter((k) => k !== pick).map((k) => HOW[k].toLowerCase()).join(", ")}.</div>}
          <div className="actions">
            <button className="sec" onClick={() => openCoach(o.coach.id)}>Voir le coach</button>
            <button disabled={busy} onClick={book}>{busy ? "Réservation…" : o.type === "group" ? "Rejoindre ce groupe" : "Réserver ce créneau"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Les choix du joueur sont gardés le temps de la visite: en revenant de la page d'un coach, rien n'est perdu
const KEEP = "book-filters";
const kept = () => { try { return JSON.parse(sessionStorage.getItem(KEEP)) || {}; } catch { return {}; } };

export function Book({ me, reload, go, coachParam }) {
  const k0 = kept();
  const [coaches, setCoaches] = useState([]);
  const [clubs, setClubs] = useState([]);
  const [coachId, setCoachId] = useState(coachParam ? +coachParam : k0.coachId ?? "");
  const [club, setClub] = useState(k0.club ?? "");
  const [day, setDay] = useState(k0.day && k0.day >= ymd(new Date()) ? k0.day : null);
  const [period, setPeriod] = useState(k0.period ?? "");
  const [hour, setHour] = useState(k0.hour ?? "");
  const [kinds, setKinds] = useState(k0.kinds ?? me.pref_kinds);
  const toggleKind = (k) => setKinds(kinds.includes(k) ? (kinds.length > 1 ? kinds.filter((x) => x !== k) : kinds) : ["individuel", "duo", "groupe"].filter((x) => x === k || kinds.includes(x)));
  const solo = kinds.length === 1 && kinds[0] === "individuel";
  const [more, setMore] = useState(false);
  useEffect(() => {
    try { sessionStorage.setItem(KEEP, JSON.stringify({ coachId, club, day, period, hour, kinds })); } catch { /* stockage indisponible */ }
    setMore(false);
  }, [coachId, club, day, period, hour, kinds.join(",")]);
  const [offers, setOffers] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { api("/me/coaches").then(setCoaches); api("/me/clubs").then(setClubs); }, []);
  useEffect(() => {
    if (!day) return;
    setOffers(null);
    const q = new URLSearchParams({ day, kinds: kinds.join(","), ...(coachId && { coach_id: coachId }), ...(club && { club }), ...(period && { period }), ...(hour !== "" && { hour }) });
    api("/me/offers?" + q).then(setOffers).catch(toastError);
  }, [day, kinds.join(","), coachId, club, period, hour]);

  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + i * 86400000));
  const openCoach = (id) => go(`coach/${id}`);
  const booked = (r) => { setDone(r); reload(); };
  const coach = coaches.find((c) => c.id === coachId);

  if (done) {
    const confirmed = done.status === "confirmee";
    return (
      <div className="card empty success">
        <div className={"bigcheck " + (confirmed ? "ok" : "wait")}><Icon name={confirmed ? "checkCircle" : "clock"} size={44} strokeWidth={1.6} /></div>
        <h1>{confirmed ? "Séance réservée !" : "Demande envoyée"}</h1>
        <b style={{ textTransform: "capitalize" }}>{dayLabel(done.start)} à {hhmm(done.start)}</b>
        <p className="mut">
          {confirmed ? `${done.coach_name} vous attend.` : `${done.coach_name} doit valider votre demande et confirmer le terrain.`}{" "}
          {done.paid_with === "credits" ? "Payé avec vos crédits." : "À régler sur place."}
        </p>
        <button onClick={() => go("mine")}>Voir mes séances</button>
      </div>
    );
  }

  const nothing = offers && !offers.groups.length && !offers.slots_with_court.length && !offers.slots_other.length;
  const list = (items) => items.map((o) => <Offer key={(o.session_id ?? "") + o.coach.id + o.start} o={o} me={me} kinds={kinds} onBooked={booked} openCoach={openCoach} />);
  return (
    <>
      <h1>Réserver</h1>

      <h2 className="step"><span>1</span> Avec qui, où ?</h2>
      <div className="grid">
        <label className="field"><span className="mut">Coach</span>
          <select value={coachId} onChange={(e) => setCoachId(e.target.value ? +e.target.value : "")}>
            <option value="">Tous les coachs</option>
            {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}{c.mine ? " (mon coach)" : ""}</option>)}
          </select>
        </label>
        <label className="field"><span className="mut">Club</span>
          <select value={club} onChange={(e) => setClub(e.target.value)}>
            <option value="">Tous les clubs</option>
            {clubs.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {coach && <button className="link" onClick={() => openCoach(coach.id)}><Icon name="user" size={14} /> Découvrir {coach.name}</button>}

      <h2 className="step"><span>2</span> Quel jour ?</h2>
      <div className="daystrip">
        {days.map((d) => {
          const k = ymd(d);
          return (
            <button key={k} className={"daypill" + (day === k ? " on" : "")} aria-pressed={day === k} onClick={() => setDay(k)}>
              <span>{fmt(d, { weekday: "short" }).replace(".", "")}</span>
              <b>{fmt(d, { day: "numeric" })}</b>
              <small>{fmt(d, { month: "short" }).replace(".", "")}</small>
            </button>
          );
        })}
      </div>
      <div className="chips" style={{ marginBottom: 8 }}>
        {PERIODS.map(([k, l]) => <button key={k} className={"chip small" + (period === k ? " on" : "")} onClick={() => setPeriod(k)}>{l}</button>)}
        <select className="hoursel" aria-label="Heure idéale (facultatif)" value={hour} onChange={(e) => setHour(e.target.value)}>
          <option value="">Heure : peu importe</option>
          {Array.from({ length: 15 }, (_, i) => i + 8).map((h) => <option key={h} value={h}>Vers {h} h</option>)}
        </select>
      </div>

      <h2 className="step"><span>3</span> Comment voulez-vous jouer ?</h2>
      <div className="mut small-p" style={{ marginTop: -4, marginBottom: 8 }}>Plusieurs choix possibles : vous verrez plus de propositions.</div>
      <div className="kindcards">
        {Object.entries(KIND).map(([k, v]) => (
          <button key={k} className={"kindcard" + (kinds.includes(k) ? " on" : "")} aria-pressed={kinds.includes(k)} style={{ "--c": v.color }} onClick={() => toggleKind(k)}>
            <span className="ki"><Icon name={v.icon} size={22} /></span>
            <b>{HOW[k]}</b>
            <small>{v.short}</small>
            {kinds.includes(k) && <span className="tick"><Icon name="check" size={12} strokeWidth={3} /></span>}
          </button>
        ))}
      </div>

      {!day && <div className="card empty"><Icon name="calendar" size={26} /><b>Choisissez un jour</b><div>L'heure est facultative : on vous montre tout ce qui est possible ce jour-là.</div></div>}
      {day && offers === null && <Loading rows={2} />}
      {offers && !solo && (
        <>
          <h2 className="accent-h"><Icon name="users" size={16} /> Rejoindre un groupe déjà formé</h2>
          {offers.groups.length ? list(offers.groups) : <div className="card mut">Aucun groupe de votre niveau ce jour-là.</div>}
          <h2>Ou créer un nouveau créneau</h2>
          <div className="mut small-p" style={{ marginTop: -4, marginBottom: 8 }}>Vous ouvrez le groupe : les places restantes seront proposées à des joueurs de votre niveau.</div>
          {list(offers.slots_with_court)}
          {list(more ? offers.slots_other : offers.slots_other.slice(0, 6))}
          {!more && offers.slots_other.length > 6 && <button className="link center" onClick={() => setMore(true)}>Voir les {offers.slots_other.length - 6} autres créneaux</button>}
          {!offers.slots_with_court.length && !offers.slots_other.length && <div className="card mut">Aucun créneau libre ce jour-là.</div>}
        </>
      )}
      {offers && solo && (
        <>
          <h2 className="accent-h"><Icon name="pin" size={16} /> Créneaux avec un terrain déjà réservé</h2>
          {offers.slots_with_court.length ? list(offers.slots_with_court) : <div className="card mut">Aucun terrain déjà réservé ce jour-là.</div>}
          {offers.slots_other.length > 0 && (
            <>
              <h2>Autres créneaux</h2>
              <div className="mut small-p" style={{ marginTop: -4, marginBottom: 8 }}>Le coach réservera le terrain et confirmera.</div>
              {list(more ? offers.slots_other : offers.slots_other.slice(0, 6))}
              {!more && offers.slots_other.length > 6 && <button className="link center" onClick={() => setMore(true)}>Voir les {offers.slots_other.length - 6} autres créneaux</button>}
            </>
          )}
        </>
      )}
      {nothing && <div className="mut center small-p" style={{ marginTop: 8 }}>Essayez un autre jour, un autre moment ou tous les coachs.</div>}
    </>
  );
}

// Page d'un coach, vue par le joueur
export function CoachPage({ id, go, onBack }) {
  const [c, setC] = useState(null);
  useEffect(() => { api(`/me/coaches/${id}`).then(setC).catch(toastError); }, [id]);
  if (!c) return <><button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button><Loading hero rows={2} /></>;
  const byDay = DAYS.map((d, i) => [d, c.availability.filter((w) => w.weekday === i)]);
  return (
    <>
      <div className="hero coach-hero">
        <button className="small light" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button>
        <div className="row g10" style={{ marginTop: 12 }}>
          <Avatar name={c.name} size={64} />
          <div>
            <h1 style={{ margin: 0 }}>{c.name}</h1>
            <div className="hero-top" style={{ textTransform: "none" }}>{c.mine ? "Votre coach" : "Coach de padel"} · {c.stats.sessions_done} séance{c.stats.sessions_done > 1 ? "s" : ""} donnée{c.stats.sessions_done > 1 ? "s" : ""} · {c.stats.players} joueur{c.stats.players > 1 ? "s" : ""}</div>
          </div>
        </div>
      </div>
      <button className="cta" onClick={() => go(`book/${c.id}`)}><Icon name="calendar" size={20} /> Réserver avec {c.name.split(" ")[0]} <Icon name="chevR" size={18} /></button>

      {c.bio && <div className="card"><div className="mut small-p">À propos</div><div style={{ whiteSpace: "pre-line" }}>{c.bio}</div></div>}
      {c.specialties.length > 0 && (
        <><h2>Spécialités</h2><div className="chips">{c.specialties.map((t) => <span key={t} className="theme big-theme">{t}</span>)}</div></>
      )}
      <h2>Tarifs par joueur</h2>
      <div className="grid three">
        {Object.entries(KIND).map(([k, v]) => <div key={k} className="kpi"><div className="mut small-p">{HOW[k]}</div><b className="big sm">{tnd(c.prices[k])}</b></div>)}
      </div>
      {c.credits_millimes > 0 && <div className="mut small-p" style={{ marginTop: 6 }}><Icon name="wallet" size={13} /> Vos crédits chez ce coach : {tnd(c.credits_millimes)}</div>}
      {c.clubs.length > 0 && (<><h2>Clubs</h2><div className="card">{c.clubs.map((n) => <div key={n} className="clubline"><Icon name="pin" size={15} /> {n}</div>)}</div></>)}
      <h2>Disponibilités</h2>
      <div className="card">
        {byDay.map(([d, ws]) => (
          <div key={d} className="row avail"><span>{d}</span><span className={ws.length ? "" : "mut"}>{ws.length ? ws.map((w) => `${w.start_time}–${w.end_time}`).join(" · ") : "Fermé"}</span></div>
        ))}
        <div className="mut small-p" style={{ marginTop: 8 }}>Durées : seul {c.durations.individuel} min · à deux {c.durations.duo} min · en groupe {c.durations.groupe} min · annulation remboursée jusqu'à {c.cancel_hours} h avant.</div>
      </div>
      {c.happy_hours.length > 0 && (
        <>
          <h2>Happy hours</h2>
          <div className="card">
            {c.happy_hours.map((h, i) => <div key={i} className="row avail"><span>{DAYS[h.weekday]} · {h.start_time}–{h.end_time}</span><span className="promo-tag">−{h.discount_pct} %</span></div>)}
          </div>
        </>
      )}
    </>
  );
}
