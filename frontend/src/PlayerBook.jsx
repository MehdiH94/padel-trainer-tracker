import { useEffect, useState } from "react";
import { api, peek, dayLabel, hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { toastError } from "./feedback.jsx";
import { VerifyBanner } from "./VerifyEmail.jsx";
import { Avatar, CategoryBadge, KIND, Loading, reduction } from "./ui.jsx";

const TZ = "Africa/Tunis";
const fmt = (d, o) => d.toLocaleDateString("fr-FR", { ...o, timeZone: TZ });
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const PERIODS = [["", "Toute la journée"], ["matin", "Matin"], ["apres-midi", "Après-midi"], ["soir", "Soir"]];
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const HOW = { individuel: "Seul", duo: "À deux", groupe: "En groupe" };
const dur = (m) => (m % 60 ? `${Math.floor(m / 60) ? Math.floor(m / 60) + " h " : ""}${m % 60}` : `${m / 60} h`); // 90 -> « 1 h 30 »

// Le prix est débité des crédits chez ce coach quand il valide la réservation; le solde peut passer en négatif (dette)
const payment = (me, coachId, price) => {
  const bal = me.wallets.find((x) => x.coach_id === coachId)?.credits_millimes ?? 0;
  const after = bal - price;
  return `Débité de vos crédits quand le coach valide : solde ${tnd(bal)} → ${tnd(after)}` + (after < 0 ? " (à régler au coach)" : "");
};

// Prix affiché: la formule choisie une fois la carte ouverte, sinon la moins chère (« dès »)
function Price({ o, open }) {
  const opts = o.options ?? [];
  const cheapest = opts.length ? opts.reduce((a, x) => (x.price_millimes < a.price_millimes ? x : a)) : o;
  const opt = open && o.chosen ? o.chosen : cheapest;
  const base = opt.base_millimes;
  return (
    <span className="offer-price">
      {opt.reduction_millimes > 0 && <span className="promo-tag">{opt.reason === "promo" ? "Promo" : "Heures creuses"} {reduction(opt)}</span>}
      <span>{!open && opts.length > 1 && <small className="mut">dès </small>}{tnd(opt.price_millimes)}</span>
      {opt.reduction_millimes > 0 && base > opt.price_millimes && <span className="old-price">{tnd(base)}</span>}
    </span>
  );
}

function CourtTag({ court }) {
  return court === "reserve"
    ? <span className="court-badge ok"><Icon name="pin" size={12} /> Terrain réservé</span>
    : <span className="court-badge wait"><Icon name="clock" size={12} /> Terrain à confirmer</span>;
}

// Une proposition (groupe à rejoindre ou créneau à créer), avec confirmation sur place
function Offer({ o, me, kinds, durs, onBooked, openCoach }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Créneau proposé en 1 h et/ou 1 h 30 (durées choisies par le joueur): il choisit la durée, chacune son prix.
  // Pas de formule à choisir: on démarre avec la plus petite formule cochée, et le prix suit la formule
  // réellement jouée (seul, à deux, en groupe) selon le nombre de joueurs final.
  const lengths = [...new Set((o.options ?? []).map((x) => x.duration_min))].sort((a, b) => a - b);
  const [chosenLen, setLen] = useState(null);
  const len = lengths.includes(chosenLen) ? chosenLen : lengths[lengths.length - 1]; // 1 h 30 par défaut
  const options = (o.options ?? []).filter((x) => x.duration_min === len);
  const start = options[0]; // plus petite formule cochée possible sur ce créneau, à cette durée
  const pick = start?.kind ?? o.kind;
  const shown = o.type === "slot" ? { ...o, options, chosen: start } : o;
  const firstAt = (m) => (o.options ?? []).find((x) => x.duration_min === m);
  const book = async () => {
    setBusy(true);
    try {
      // séance d'une autre durée que celle choisie: le joueur l'accepte en la rejoignant
      const accept = o.other_duration ? { duo: [...durs.duo, o.duration_min], groupe: [...durs.groupe, o.duration_min] } : durs;
      const body = o.type === "group" ? { session_id: o.session_id, kinds, durations: accept } : { kind: pick, start: o.start, coach_id: o.coach.id, kinds, minutes: len, durations: durs };
      onBooked({ ...(await api("/me/book", { method: "POST", body })), start: o.start });
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <div className={"card offer" + (open ? " open" : "")}>
      <button className="offer-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="offer-time"><b>{hhmm(o.start)}</b><small>{o.type === "slot" ? lengths.map(dur).join(" / ") : dur(o.duration_min)}</small></span>
        <span className="offer-main">
          <span className="offer-coach">{o.coach.name}</span>
          <small>{o.club || "Club à confirmer"}</small>
          <span><CourtTag court={o.court} />{o.other_duration && <span className="court-badge wait"><Icon name="clock" size={12} /> Autre durée</span>}{o.type === "group" && <span className="court-badge idle"><Icon name="users" size={12} /> {o.count} inscrit{o.count > 1 ? "s" : ""} · {o.spots_left} place{o.spots_left > 1 ? "s" : ""}</span>}</span>
        </span>
        {o.type === "slot" && lengths.length > 1 && !open
          ? <span className="offer-price two">{lengths.map((m) => <span key={m}><small className="mut">{dur(m)} </small>{tnd(firstAt(m).price_millimes)}</span>)}</span>
          : <Price o={shown} open={open} />}
      </button>
      {o.type === "group" && (
        <div className="partners">
          {o.players.map((p) => <span key={p.name} className="partner"><Avatar name={p.name} size={22} /> {p.name.split(" ")[0]} <CategoryBadge category={p.category} /></span>)}
        </div>
      )}
      {open && (
        <div className="confirm-box">
          {lengths.length > 1 && (
            <div className="seg-choice" role="group" aria-label="Durée">
              {lengths.map((m) => <button key={m} type="button" className={len === m ? "on" : ""} aria-pressed={len === m} onClick={() => setLen(m)}>{dur(m)} · {tnd(firstAt(m).price_millimes)}</button>)}
            </div>
          )}
          {o.other_duration && <div className="note warn small-p"><Icon name="clock" size={13} /> Cette séance dure {dur(o.duration_min)}, pas la durée choisie. Ça vous va quand même ?</div>}
          {options.length > 1 && (
            <div className="price-table" aria-label="Prix selon la formule jouée">
              <div className="small-p"><b>Vous paierez selon le nombre de joueurs final :</b></div>
              {options.map((x) => (
                <div key={x.kind} className="row small-p"><span>{HOW[x.kind]}{x.kind === pick && " (si personne ne vous rejoint)"}</span><b>{tnd(x.price_millimes)}</b></div>
              ))}
            </div>
          )}
          <div className="mut small-p"><Icon name="wallet" size={13} /> {payment(me, o.coach.id, (start ?? o).price_millimes)}</div>
          {o.type === "slot" && pick !== "individuel" && (
            <div className="mut small-p"><Icon name="users" size={13} /> Vous serez le premier : la séance sera confirmée dès que {pick === "duo" ? "1 autre joueur" : "2 autres joueurs"} vous aur{pick === "duo" ? "a" : "ont"} rejoint (les places sont proposées aux joueurs de votre niveau). Sinon, 6 h avant, vous pourrez accepter une autre formule ou annuler (remboursé).</div>
          )}
          {o.type === "group" && o.missing > 0 && (
            <div className="mut small-p"><Icon name="users" size={13} /> Après vous, il manquera encore {o.missing} joueur{o.missing > 1 ? "s" : ""} : la séance sera confirmée quand le groupe sera complet.</div>
          )}
          {o.type === "group" && o.missing === 0 && <div className="mut small-p"><Icon name="check" size={13} /> Avec vous, la séance a assez de joueurs.</div>}
          {o.type === "slot" && kinds.length > 1 && <div className="mut small-p"><Icon name="check" size={13} /> Le coach verra les formules que vous acceptez : {kinds.map((k) => HOW[k].toLowerCase()).join(", ")}.</div>}
          <div className="actions">
            <button className="sec" onClick={() => openCoach(o.coach.id)}>Voir le coach</button>
            <button disabled={busy || !me.can_book} title={me.can_book ? undefined : "Vérifiez d'abord votre adresse e-mail"} onClick={book}>{busy ? "Réservation…" : o.type === "group" ? "Rejoindre ce groupe" : "Réserver ce créneau"}</button>
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
  const [coaches, setCoaches] = useState(() => peek("/me/coaches") ?? []);
  const [clubs, setClubs] = useState(() => peek("/me/clubs") ?? []);
  // un, plusieurs ou tous les coachs (liste vide = tous)
  const [coachIds, setCoachIds] = useState(coachParam ? [+coachParam] : k0.coachIds ?? (k0.coachId ? [k0.coachId] : []));
  const toggleCoach = (id) => setCoachIds(coachIds.includes(id) ? coachIds.filter((x) => x !== id) : [...coachIds, id]);
  const [club, setClub] = useState(k0.club ?? "");
  const [day, setDay] = useState(k0.day && k0.day >= ymd(new Date()) ? k0.day : null);
  const [period, setPeriod] = useState(k0.hour ? "" : k0.period ?? ""); // heure précise choisie: pas de période en plus
  const [hour, setHour] = useState(k0.hour ?? "");
  const [kinds, setKinds] = useState(k0.kinds ?? me.pref_kinds);
  // durées acceptées: seul = toujours 1 h; à deux / en groupe = 1 h 30 par défaut, 1 h ou les deux
  const [durs, setDurs] = useState(k0.durs ?? { duo: [90], groupe: [90] });
  const toggleDur = (k, m) => setDurs({ ...durs, [k]: durs[k].includes(m) ? (durs[k].length > 1 ? durs[k].filter((x) => x !== m) : durs[k]) : [...durs[k], m].sort() });
  const toggleKind = (k) => setKinds(kinds.includes(k) ? (kinds.length > 1 ? kinds.filter((x) => x !== k) : kinds) : ["individuel", "duo", "groupe"].filter((x) => x === k || kinds.includes(x)));
  const solo = kinds.length === 1 && kinds[0] === "individuel";
  const [more, setMore] = useState(false);
  useEffect(() => {
    try { sessionStorage.setItem(KEEP, JSON.stringify({ coachIds, club, day, period, hour, kinds, durs })); } catch { /* stockage indisponible */ }
    setMore(false);
  }, [coachIds.join(","), club, day, period, hour, kinds.join(","), JSON.stringify(durs)]);
  const [offers, setOffers] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { api("/me/coaches").then(setCoaches); api("/me/clubs").then(setClubs); }, []);
  useEffect(() => {
    if (!day) return;
    const q = new URLSearchParams({ day, kinds: kinds.join(","), duo_min: durs.duo.join(","), groupe_min: durs.groupe.join(","), ...(coachIds.length && { coach_ids: coachIds.join(",") }), ...(club && { club }), ...(period && { period }), ...(hour !== "" && { hour }) });
    setOffers(peek("/me/offers?" + q) ?? null); // même recherche déjà faite: affichée tout de suite, puis mise à jour
    api("/me/offers?" + q).then(setOffers).catch(toastError);
  }, [day, kinds.join(","), JSON.stringify(durs), coachIds.join(","), club, period, hour]);

  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + i * 86400000));
  const openCoach = (id) => go(`coach/${id}`);
  const booked = (r) => { setDone(r); reload(); };
  const coach = coachIds.length === 1 ? coaches.find((c) => c.id === coachIds[0]) : null;

  if (done) {
    const confirmed = done.status === "confirmee";
    return (
      <div className="card empty success">
        <div className={"bigcheck " + (confirmed ? "ok" : "wait")}><Icon name={confirmed ? "checkCircle" : "clock"} size={44} strokeWidth={1.6} /></div>
        <h1>{confirmed ? "Séance réservée !" : "Demande envoyée"}</h1>
        <b className="cap1">{dayLabel(done.start)} à {hhmm(done.start)}</b>
        <p className="mut">
          {confirmed ? `${done.coach_name} vous attend.` : `${done.coach_name} doit valider votre demande et confirmer le terrain.`}{" "}
          {done.charged_millimes ? `${tnd(done.charged_millimes)} débités de vos crédits.` : `${tnd(done.price_millimes)} seront débités de vos crédits à la validation.`}
        </p>
        <button onClick={() => go("planning")}>Voir mon planning</button>
      </div>
    );
  }

  const nothing = offers && !offers.groups.length && !offers.slots_with_court.length && !offers.slots_other.length;
  const list = (items) => items.map((o) => <Offer key={(o.session_id ?? "") + o.coach.id + o.start} o={o} me={me} kinds={kinds} durs={durs} onBooked={booked} openCoach={openCoach} />);
  return (
    <>
      <h1>Réserver</h1>
      <VerifyBanner me={me} />

      <h2 className="step"><span>1</span> Avec qui, où ?</h2>
      <div className="mut small-p">Coachs (un ou plusieurs)</div>
      <div className="coach-chips" role="group" aria-label="Coachs">
        <button className={"chip small" + (coachIds.length === 0 ? " on" : "")} aria-pressed={coachIds.length === 0} onClick={() => setCoachIds([])}>Tous</button>
        {coaches.map((c) => (
          <button key={c.id} className={"chip small" + (coachIds.includes(c.id) ? " on" : "")} aria-pressed={coachIds.includes(c.id)} onClick={() => toggleCoach(c.id)}>
            {coachIds.includes(c.id) && <Icon name="check" size={13} />} {c.name}{c.mine ? " ★" : ""}
          </button>
        ))}
      </div>
      <div className="grid">
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
        {/* Une heure précise remplace la période (matin, soir…): les deux ne se combinent pas */}
        {/* heure précise choisie: les périodes restent affichées mais aucune n'est sélectionnée; en choisir une retire l'heure */}
        {PERIODS.map(([k, l]) => <button key={k} className={"chip small" + (hour === "" && period === k ? " on" : "")} aria-pressed={hour === "" && period === k} onClick={() => { setPeriod(k); setHour(""); }}>{l}</button>)}
        <select className="hoursel" aria-label="Heure idéale (facultatif)" value={hour} onChange={(e) => { setHour(e.target.value); if (e.target.value !== "") setPeriod(""); }}>
          <option value="">Heure : peu importe</option>
          {Array.from({ length: 15 }, (_, i) => i + 8).map((h) => <option key={h} value={h}>Vers {h} h</option>)}
        </select>
      </div>

      <h2 className="step"><span>3</span> Comment voulez-vous jouer ?</h2>
      <div className="multi-hint"><Icon name="checkCircle" size={16} /> <span><b>Cochez une ou plusieurs options.</b> Plus vous en cochez, plus vous aurez de propositions.</span></div>
      <div className="kindcards" role="group" aria-label="Formules acceptées (plusieurs choix possibles)">
        {Object.entries(KIND).map(([k, v]) => (
          <button key={k} className={"kindcard" + (kinds.includes(k) ? " on" : "")} role="checkbox" aria-checked={kinds.includes(k)} style={{ "--c": v.color }} onClick={() => toggleKind(k)}>
            <span className="ki"><Icon name={v.icon} size={22} /></span>
            <b>{HOW[k]}</b>
            <small>{v.short}</small>
            <span className={"tick" + (kinds.includes(k) ? "" : " off")}>{kinds.includes(k) && <Icon name="check" size={12} strokeWidth={3} />}</span>
          </button>
        ))}
      </div>
      <div className="dur-choice" aria-label="Durée de l'entraînement">
        {kinds.includes("individuel") && <div className="dur-row"><span>Seul</span><span className="mut small-p">toujours 1 h</span></div>}
        {["duo", "groupe"].filter((k) => kinds.includes(k)).map((k) => (
          <div key={k} className="dur-row" role="group" aria-label={`Durée ${HOW[k].toLowerCase()}`}>
            <span>{HOW[k]}</span>
            <span className="chips">{[60, 90].map((m) => <button key={m} type="button" className={"chip small" + (durs[k].includes(m) ? " on" : "")} aria-pressed={durs[k].includes(m)} onClick={() => toggleDur(k, m)}>{dur(m)}</button>)}</span>
          </div>
        ))}
      </div>
      <div className="accept-summary">
        Vous acceptez : <b>{kinds.map((k) => HOW[k].toLowerCase()).join(" ou ")}</b>
        {kinds.length < 3 && <span className="mut"> · pas {["individuel", "duo", "groupe"].filter((k) => !kinds.includes(k)).map((k) => HOW[k].toLowerCase()).join(" ni ")}</span>}
      </div>

      {!day && <div className="card empty"><Icon name="calendar" size={26} /><b>Choisissez un jour</b><div>L'heure est facultative : on vous montre tout ce qui est possible ce jour-là.</div></div>}
      {day && offers === null && <Loading rows={2} />}
      {offers && Object.keys(offers.other_kinds ?? {}).length > 0 && (
        <div className="card reconsider" role="note">
          <Icon name="users" size={20} />
          <div style={{ flex: 1 }}>
            <b>Ces séances ne correspondent pas à vos critères…</b>
            <div className="small-p">
              Ce jour-là, il existe aussi {Object.entries(offers.other_kinds).map(([k, n]) => `${n} séance${n > 1 ? "s" : ""} ${k === "duo" ? "à deux" : "en groupe"}`).join(" et ")} de votre niveau. Si vous reconsidérez votre choix :
            </div>
            <div className="actions" style={{ marginTop: 8 }}>
              {Object.keys(offers.other_kinds).map((k) => <button key={k} className="small sec" onClick={() => toggleKind(k)}><Icon name="plus" size={14} /> Accepter aussi {HOW[k].toLowerCase()}</button>)}
            </div>
          </div>
        </div>
      )}
      {offers && offers.too_late.length > 0 && (
        <div className="mut small-p late-hint"><Icon name="clock" size={14} /> À moins de 24 h, on ne peut plus ouvrir seul une séance {offers.too_late.map((k) => HOW[k].toLowerCase()).join(" ou ")} (pas le temps de la compléter) : rejoignez une séance existante, ou choisissez un autre jour.</div>
      )}
      {offers && !solo && (
        <>
          <h2 className="accent-h"><Icon name="users" size={16} /> Rejoindre une séance</h2>
          {offers.groups.length ? list(offers.groups) : <div className="card mut">Aucune séance de votre niveau à rejoindre ce jour-là.</div>}
        </>
      )}
      {offers && (
        <>
          <h2 className="accent-h"><Icon name="pin" size={16} /> Créneaux avec un terrain déjà réservé</h2>
          {!solo && offers.slots_with_court.length > 0 && <div className="mut small-p" style={{ marginTop: -4, marginBottom: 8 }}>Vous pouvez être le premier : la séance sera confirmée quand assez de joueurs vous auront rejoint.</div>}
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
      <h2>Tarifs par heure et par joueur</h2>
      <div className="grid three">
        {Object.entries(KIND).map(([k, v]) => <div key={k} className="kpi"><div className="mut small-p">{HOW[k]}</div><b className="big sm">{tnd(c.prices[k])}</b></div>)}
      </div>
      {c.credits_millimes !== 0 && <div className={"small-p " + (c.credits_millimes < 0 ? "red" : "mut")} style={{ marginTop: 6 }}><Icon name="wallet" size={13} /> {c.credits_millimes < 0 ? `Vous devez ${tnd(-c.credits_millimes)} à ce coach` : `Vos crédits chez ce coach : ${tnd(c.credits_millimes)}`}</div>}
      {c.clubs.length > 0 && (<><h2>Clubs</h2><div className="card">{c.clubs.map((n) => <div key={n} className="clubline"><Icon name="pin" size={15} /> {n}</div>)}</div></>)}
      <h2>Disponibilités</h2>
      <div className="card">
        {byDay.map(([d, ws]) => (
          <div key={d} className="row avail"><span>{d}</span><span className={ws.length ? "" : "mut"}>{ws.length ? ws.map((w) => `${w.start_time}–${w.end_time}`).join(" · ") : "Fermé"}</span></div>
        ))}
        <div className="mut small-p" style={{ marginTop: 8 }}>Durées : seul 1 h · à deux ou en groupe 1 h ou 1 h 30 · annulation jusqu'à 24 h avant (seul) ou 48 h avant (à deux, en groupe).</div>
      </div>
      {c.happy_hours.length > 0 && (
        <>
          <h2>Heures creuses</h2>
          <div className="card">
            {c.happy_hours.map((h, i) => <div key={i} className="row avail"><span>{DAYS[h.weekday]} · {h.start_time}–{h.end_time}</span><span className="promo-tag">{reduction(h)}</span></div>)}
          </div>
        </>
      )}
    </>
  );
}
