import { useEffect, useState } from "react";
import { api, peek, dayLabel, hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { Modal, toast, toastError } from "./feedback.jsx";
import { RatingLine, ReviewList } from "./Public.jsx";
import { VerifyBanner } from "./VerifyEmail.jsx";
import { Avatar, CategoryBadge, KIND, Loading, reduction } from "./ui.jsx";
import { GroupStart } from "./PlayerGroup.jsx";

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
  return `Débité à la validation · solde ${tnd(bal)} → ${tnd(after)}`;
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
      {o.vip && <VipPrice />}
    </span>
  );
}

// Séance complète: le joueur demande à être prévenu si une place se libère
function FullOffer({ o }) {
  const [on, setOn] = useState(o.waitlisted);
  const flip = () => api(`/me/sessions/${o.session_id}/waitlist`, { method: on ? "DELETE" : "POST" })
    .then((r) => { setOn(r.waitlisted); toast(r.waitlisted ? "Vous serez prévenu si une place se libère" : "Retiré de la liste d'attente"); }).catch(toastError);
  return (
    <div className="card join-req">
      <div className="row">
        <b className="join-time">{hhmm(o.start)} <span className="mut">· {dur(o.duration_min)} · {HOW[o.kind]?.toLowerCase()}</span></b>
        <span className="court-badge idle">Complet</span>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="partners" style={{ margin: 0 }}>{o.players.map((p) => <span key={p.name} className="partner"><Avatar name={p.name} size={22} /> {p.name.split(" ")[0]} <CategoryBadge category={p.category} /></span>)}</span>
        <small className="mut">{o.coach.name}</small>
      </div>
      <button className={"small" + (on ? " sec" : "")} style={{ width: "100%", marginTop: 10 }} onClick={flip}>
        <Icon name={on ? "check" : "bell"} size={14} /> {on ? "Prévenu si une place se libère · retirer" : "M'avertir si une place se libère"}
      </button>
    </div>
  );
}

// Joueur de la liste VIP du coach: ses prix sont déjà ses tarifs privilégiés (mention discrète sous le prix)
const VipPrice = () => <small className="vip-price">tarif privilégié</small>;

function CourtTag({ court }) {
  return court === "reserve"
    ? <span className="court-badge ok"><Icon name="pin" size={12} /> Terrain réservé</span>
    : <span className="court-badge wait"><Icon name="clock" size={12} /> Terrain à confirmer</span>;
}

// Une proposition (groupe à rejoindre ou créneau à créer), avec confirmation sur place
function Offer({ o, me, kinds, durs, onBooked, openCoach, startOpen, compact }) {
  const [open, setOpen] = useState(!!startOpen);
  const [busy, setBusy] = useState(false);
  const [grouping, setGrouping] = useState(false); // réservation en groupe: choix de la formule puis invitations
  // Rien à choisir: ni la formule ni la durée. Le joueur est prêt pour tout ce qu'il a coché (ex. à deux ou en groupe,
  // 1 h ou 1 h 30); la séance démarre avec la plus petite formule et la plus longue durée, et le prix suit ce qui
  // est réellement joué: nombre de joueurs final et durée (un joueur qui n'accepte que 1 h la raccourcit).
  const options = o.options ?? [];
  const lengths = [...new Set(options.map((x) => x.duration_min))].sort((a, b) => a - b);
  const pick = options[0]?.kind ?? o.kind;
  const start = [...options].filter((x) => x.kind === pick).sort((a, b) => b.duration_min - a.duration_min)[0]; // départ: plus petite formule, plus longue durée
  const shown = o.type === "slot" ? { ...o, chosen: start } : o;
  const rows = [...new Set(options.map((x) => x.kind))].map((k) => [k, options.filter((x) => x.kind === k).sort((a, b) => a.duration_min - b.duration_min)]);
  const book = async () => {
    setBusy(true);
    try {
      // séance d'une autre durée que celle choisie: le joueur l'accepte en la rejoignant
      const accept = o.other_duration ? { ...durs, duo: [...durs.duo, o.duration_min], groupe: [...durs.groupe, o.duration_min] } : durs;
      const body = o.type === "group" ? { session_id: o.session_id, kinds, durations: accept } : { kind: pick, start: o.start, coach_id: o.coach.id, kinds, durations: durs };
      onBooked({ ...(await api("/me/book", { method: "POST", body })), start: o.start });
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <div className={"card offer" + (open ? " open" : "") + (compact ? " compact" : "")}>
      {/* dans la carte du coach (compact): coach et club déjà affichés au-dessus */}
      {!compact && <button className="offer-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="offer-time"><b>{hhmm(o.start)}</b><small>{o.type === "slot" ? lengths.map(dur).join(" / ") : dur(o.duration_min)}</small></span>
        <span className="offer-main">
          <span className="offer-coach">{o.coach.name}</span>
          <small>{o.club || "Club à confirmer"}</small>
          <span><CourtTag court={o.court} />{o.other_duration && <span className="court-badge wait"><Icon name="clock" size={12} /> Autre durée</span>}{o.type === "group" && <span className="court-badge idle"><Icon name="users" size={12} /> {o.count} inscrit{o.count > 1 ? "s" : ""} · {o.spots_left} place{o.spots_left > 1 ? "s" : ""}</span>}</span>
        </span>
        <Price o={shown} open={open} />
      </button>}
      {compact && <div className="row" style={{ marginBottom: 6 }}><b>{hhmm(o.start)} <span className="mut">· {lengths.map(dur).join(" / ")}</span></b><b>{tnd((start ?? o).price_millimes)}</b></div>}
      {o.type === "group" && (
        <div className="partners">
          {o.players.map((p) => <span key={p.name} className="partner"><Avatar name={p.name} size={22} /> {p.name.split(" ")[0]} <CategoryBadge category={p.category} /></span>)}
        </div>
      )}
      {open && (
        <div className="confirm-box">
          {o.other_duration && <div className="note warn small-p"><Icon name="clock" size={13} /> Cette séance dure {dur(o.duration_min)}, pas la durée choisie. Ça vous va quand même ?</div>}
          {o.type === "slot" && options.length > 1 && (
            <div className="price-table" aria-label="Prix selon la formule et la durée jouées">
              <div className="small-p"><b>Vous paierez selon le nombre de joueurs final{lengths.length > 1 ? " et la durée" : ""} :</b></div>
              {rows.map(([k, xs]) => (
                <div key={k} className="row small-p">
                  <span>{HOW[k]}{k === pick && rows.length > 1 && " (si personne ne vous rejoint)"}</span>
                  <span className="price-cells">{xs.map((x) => <span key={x.duration_min}><small className="mut">{dur(x.duration_min)}</small> <b>{tnd(x.price_millimes)}</b></span>)}</span>
                </div>
              ))}
              {lengths.length > 1 && <div className="mut small-p" style={{ marginTop: 4 }}><Icon name="clock" size={12} /> {dur(lengths[lengths.length - 1])} au départ ; {dur(lengths[0])} si un joueur qui vous rejoint ne veut jouer que {dur(lengths[0])}.</div>}
            </div>
          )}
          {o.requested > 0 && <div className="mut small-p"><Icon name="users" size={13} /> {o.requested === 1 ? "Un autre joueur a déjà demandé" : `${o.requested} autres joueurs ont déjà demandé`} ce créneau : le coach choisira.</div>}
          <div className="mut small-p"><Icon name="wallet" size={13} /> {payment(me, o.coach.id, (start ?? o).price_millimes)}</div>
          {o.type === "slot" && pick !== "individuel" && (
            <div className="mut small-p"><Icon name="users" size={13} /> Confirmée dès que {pick === "duo" ? "1 joueur vous rejoint" : "2 joueurs vous rejoignent"}.</div>
          )}
          {o.type === "group" && o.missing > 0 && (
            <div className="mut small-p"><Icon name="users" size={13} /> Après vous, il manquera encore {o.missing} joueur{o.missing > 1 ? "s" : ""} : la séance sera confirmée quand le groupe sera complet.</div>
          )}
          {o.type === "group" && o.missing === 0 && <div className="mut small-p"><Icon name="check" size={13} /> Avec vous, la séance a assez de joueurs.</div>}
          <div className="actions">
            {!compact && <button className="sec" onClick={() => openCoach(o.coach.id)}>Voir le coach</button>}
            <button disabled={busy || !me.can_book} title={me.can_book ? undefined : "Vérifiez d'abord votre adresse e-mail"} onClick={book}>{busy ? "Réservation…" : o.type === "group" ? "Rejoindre ce groupe" : "Réserver ce créneau"}</button>
          </div>
          {o.type === "slot" && (
            <button className="group-cta" disabled={!me.can_book} onClick={() => setGrouping(true)}>
              <Icon name="users" size={20} /><span><b>Ou réserver en groupe avec mes amis</b><small>Invitez-les, une seule demande part au coach.</small></span><Icon name="chevR" size={16} />
            </button>
          )}
          {grouping && <GroupStart o={o} durs={durs} onClose={() => setGrouping(false)} />}
        </div>
      )}
    </div>
  );
}

// Demande d'un autre joueur pas encore traitée par le coach (même niveau, formules communes): s'y joindre
function RequestOffer({ o, me, kinds, durs, onBooked }) {
  const [busy, setBusy] = useState(false);
  const host = o.players[0].name.split(" ")[0];
  const join = () => {
    setBusy(true);
    api(`/me/requests/${o.booking_id}/join`, { method: "POST", body: { kinds, durations: durs } })
      .then((r) => onBooked({ ...r, start: o.start })).catch((x) => { toastError(x); setBusy(false); });
  };
  return (
    <div className="card join-req">
      <div className="row">
        <b className="join-time">{hhmm(o.start)} <span className="mut">· {dur(o.duration_min)} · {o.kinds.map((k) => HOW[k].toLowerCase()).join(" ou ")}</span></b>
        <span className="offer-price"><b>{tnd(o.price_millimes)}</b>{o.vip && <VipPrice />}</span>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="partners" style={{ margin: 0 }}>{o.players.map((p) => <span key={p.name} className="partner"><Avatar name={p.name} size={22} /> {p.name.split(" ")[0]} <CategoryBadge category={p.category} /></span>)}</span>
        <small className="mut" style={{ textAlign: "right" }}>{o.coach.name}<br /><span className="court-badge wait">En attente du coach</span></small>
      </div>
      <button style={{ width: "100%", marginTop: 10 }} disabled={busy || !me.can_book} onClick={join}>{busy ? "Envoi…" : `Rejoindre ${host}`}</button>
    </div>
  );
}

// Coachs et clubs favoris: choisis d'office à chaque réservation
function Favorites({ fav, coaches, clubs, onClose, onSaved }) {
  const [ids, setIds] = useState(fav.coach_ids);
  const [names, setNames] = useState(fav.clubs);
  const flip = (list, set, x) => set(list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const save = () => api("/me/favorites", { method: "PUT", body: { coach_ids: ids, clubs: names } })
    .then((f) => { toast("Favoris enregistrés"); onSaved(f); }).catch(toastError);
  return (
    <Modal onClose={onClose} label="Mes favoris">
      <div className="row"><b className="sheet-title">Mes favoris</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <p className="mut small-p">Ils seront choisis d'office quand vous réservez (vous pouvez toujours en changer).</p>
      <div className="mut small-p">Coachs</div>
      <div className="coach-chips">{coaches.map((c) => <button key={c.id} className={"chip small" + (ids.includes(c.id) ? " on" : "")} aria-pressed={ids.includes(c.id)} onClick={() => flip(ids, setIds, c.id)}>{ids.includes(c.id) && <Icon name="star" size={13} />} {c.name}</button>)}</div>
      <div className="mut small-p">Clubs</div>
      <div className="coach-chips">{clubs.map((c) => <button key={c} className={"chip small" + (names.includes(c) ? " on" : "")} aria-pressed={names.includes(c)} onClick={() => flip(names, setNames, c)}>{names.includes(c) && <Icon name="star" size={13} />} {c}</button>)}</div>
      <button style={{ width: "100%", marginTop: 8 }} onClick={save}>Enregistrer mes favoris</button>
    </Modal>
  );
}

// Créneaux libres d'un même coach au même club ce jour-là: une seule carte, l'heure se choisit sur des pastilles
// (toutes les 30 min). « Idéal » = collé au bord de la plage libre: ne coupe pas le terrain en deux.
function SlotGroup({ items, me, kinds, durs, onBooked, openCoach }) {
  const [pick, setPick] = useState(null);
  const first = items[0];
  const cheapest = Math.min(...items.flatMap((o) => (o.options ?? []).map((x) => x.price_millimes)));
  const promo = items.some((o) => o.reduction_millimes > 0);
  const chosen = items.find((o) => o.start === pick);
  return (
    <div className="card slotgroup">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="offer-main">
          <button className="offer-coach link-plain" onClick={() => openCoach(first.coach.id)}>{first.coach.name} <Icon name="chevR" size={13} /></button>
          <small>{first.club || "Club à confirmer"}</small>
          <span><CourtTag court={first.court} />{promo && <span className="promo-tag">Réductions</span>}</span>
        </span>
        <span className="offer-price"><span><small className="mut">dès </small>{tnd(cheapest)}</span>{first.vip && <VipPrice />}</span>
      </div>
      <div className="mut small-p" style={{ margin: "8px 0 4px" }}>Choisissez l'heure{items.some((o) => o.ideal) && items.some((o) => !o.ideal) ? " · ★ idéal" : ""}</div>
      <div className="chips" role="group" aria-label={`Heures avec ${first.coach.name}`}>
        {items.map((o) => (
          <button key={o.start} className={"chip small" + (pick === o.start ? " on" : "")} aria-pressed={pick === o.start} onClick={() => setPick(pick === o.start ? null : o.start)}>
            {hhmm(o.start)}{o.ideal && items.some((x) => !x.ideal) ? " ★" : ""}
          </button>
        ))}
      </div>
      {chosen && <Offer key={chosen.start} o={chosen} me={me} kinds={kinds} durs={durs} onBooked={onBooked} openCoach={openCoach} startOpen compact />}
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
  const fav = me.favorites ?? { coach_ids: [], clubs: [] };
  const [coachIds, setCoachIds] = useState(coachParam ? [+coachParam] : k0.coachIds ?? (k0.coachId ? [k0.coachId] : fav.coach_ids)); // favoris d'office
  const [editFav, setEditFav] = useState(false);
  const toggleCoach = (id) => setCoachIds(coachIds.includes(id) ? coachIds.filter((x) => x !== id) : [...coachIds, id]);
  const [places, setPlaces] = useState(k0.places ?? (k0.club ? [k0.club] : fav.clubs)); // clubs choisis (vide = tous), favoris d'office
  const [showClubs, setShowClubs] = useState(false); // clubs repliés: « Tous les clubs ▾ »
  const togglePlace = (c) => setPlaces(places.includes(c) ? places.filter((x) => x !== c) : [...places, c]);
  const [day, setDay] = useState(k0.day && k0.day >= ymd(new Date()) ? k0.day : null);
  const [period, setPeriod] = useState(k0.hour ? "" : k0.period ?? ""); // heure précise choisie: pas de période en plus
  const [hour, setHour] = useState(k0.hour ?? "");
  const [kinds, setKinds] = useState(k0.kinds ?? me.pref_kinds);
  // durées acceptées: seul et à deux 1 h par défaut, en groupe 1 h 30 (1 h, 1 h 30 ou les deux; chaque coach propose les siennes)
  const [durs, setDurs] = useState({ individuel: [60], duo: [60], groupe: [90], ...k0.durs });
  const toggleDur = (k, m) => setDurs({ ...durs, [k]: durs[k].includes(m) ? (durs[k].length > 1 ? durs[k].filter((x) => x !== m) : durs[k]) : [...durs[k], m].sort() });
  const toggleKind = (k) => setKinds(kinds.includes(k) ? (kinds.length > 1 ? kinds.filter((x) => x !== k) : kinds) : ["individuel", "duo", "groupe"].filter((x) => x === k || kinds.includes(x)));
  const solo = kinds.length === 1 && kinds[0] === "individuel";
  useEffect(() => {
    try { sessionStorage.setItem(KEEP, JSON.stringify({ coachIds, places, day, period, hour, kinds, durs })); } catch { /* stockage indisponible */ }
  }, [coachIds.join(","), places.join("|"), day, period, hour, kinds.join(","), JSON.stringify(durs)]);
  const [offers, setOffers] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => { api("/me/coaches").then(setCoaches); api("/me/clubs").then(setClubs); }, []);
  // jours où les coachs choisis sont tous absents ou complets: grisés, on ne peut pas les choisir
  const daysUrl = "/me/days?coach_ids=" + coachIds.join(",");
  const [blocked, setBlocked] = useState(() => peek(daysUrl)?.days ?? {});
  useEffect(() => { api(daysUrl).then((r) => setBlocked(r.days)).catch(() => {}); }, [daysUrl]);
  useEffect(() => { if (day && blocked[day]) setDay(null); }, [blocked, day]);
  useEffect(() => {
    if (!day) return;
    const q = new URLSearchParams({ day, kinds: kinds.join(","), individuel_min: durs.individuel.join(","), duo_min: durs.duo.join(","), groupe_min: durs.groupe.join(","), ...(coachIds.length && { coach_ids: coachIds.join(",") }), ...(places.length && { clubs: places.join("|") }), ...(period && { period }), ...(hour !== "" && { hour }) });
    setOffers(peek("/me/offers?" + q) ?? null); // même recherche déjà faite: affichée tout de suite, puis mise à jour
    api("/me/offers?" + q).then(setOffers).catch(toastError);
  }, [day, kinds.join(","), JSON.stringify(durs), coachIds.join(","), places.join("|"), period, hour]);

  // jours proposés: jusqu'à la limite de réservation des coachs choisis (1 semaine à 3 mois, 2 semaines par défaut)
  const horizon = Math.max(7, ...coaches.filter((c) => !coachIds.length || coachIds.includes(c.id)).map((c) => c.horizon_days ?? 14));
  const days = Array.from({ length: horizon + 1 }, (_, i) => new Date(Date.now() + i * 86400000));
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
  // créneaux libres regroupés par coach et club (une carte, les heures en pastilles), dans l'ordre de la meilleure heure
  const grouped = (items) => {
    const g = new Map();
    items.forEach((o) => { const k = `${o.coach.id}|${o.club}|${o.court}`; g.set(k, [...(g.get(k) ?? []), o]); });
    return [...g.values()].map((xs) => (
      <SlotGroup key={xs[0].coach.id + xs[0].club + xs[0].court} items={[...xs].sort((a, b) => (a.start < b.start ? -1 : 1))} me={me} kinds={kinds} durs={durs} onBooked={booked} openCoach={openCoach} />
    ));
  };
  return (
    <>
      <h1>Réserver</h1>
      <VerifyBanner me={me} />

      <h2 className="step"><span>1</span> Avec qui, où ?</h2>
      <div className="coach-chips" role="group" aria-label="Coachs">
        <button className={"chip small" + (coachIds.length === 0 ? " on" : "")} aria-pressed={coachIds.length === 0} onClick={() => setCoachIds([])}>Tous</button>
        {coaches.map((c) => (
          <button key={c.id} className={"chip small" + (coachIds.includes(c.id) ? " on" : "")} aria-pressed={coachIds.includes(c.id)} onClick={() => toggleCoach(c.id)}>
            {coachIds.includes(c.id) && <Icon name="check" size={13} />} {c.name}{fav.coach_ids.includes(c.id) ? " ★" : ""}
          </button>
        ))}
      </div>
      {!showClubs && <button className="link" onClick={() => setShowClubs(true)}><Icon name="pin" size={14} /> {places.length ? places.join(", ") : "Tous les clubs"} <Icon name="chevD" size={14} /></button>}
      {showClubs && <div className="coach-chips" role="group" aria-label="Clubs">
        <button className={"chip small" + (places.length === 0 ? " on" : "")} aria-pressed={places.length === 0} onClick={() => setPlaces([])}>Tous</button>
        {clubs.map((c) => (
          <button key={c} className={"chip small" + (places.includes(c) ? " on" : "")} aria-pressed={places.includes(c)} onClick={() => togglePlace(c)}>
            {places.includes(c) && <Icon name="check" size={13} />} {c}{fav.clubs.includes(c) ? " ★" : ""}
          </button>
        ))}
      </div>}
      <a className="link" href="/coachs"><Icon name="users" size={14} /> Voir tous les coachs et leurs avis</a>
      <button className="link" onClick={() => setEditFav(true)}><Icon name="star" size={14} /> {fav.coach_ids.length || fav.clubs.length ? "Modifier mes favoris" : "Choisir mes coachs et clubs favoris"}</button>
      {editFav && <Favorites fav={fav} coaches={coaches} clubs={clubs} onClose={() => setEditFav(false)}
        onSaved={(f) => { setEditFav(false); setCoachIds(f.coach_ids); setPlaces(f.clubs); reload(); }} />}

      <h2 className="step"><span>2</span> Quel jour ?</h2>
      <div className="daystrip">
        {days.map((d) => {
          const k = ymd(d);
          const off = blocked[k]; // « absent » ou « complet »
          return (
            <button key={k} className={"daypill" + (day === k ? " on" : "") + (off ? " " + off : "")} aria-pressed={day === k} disabled={!!off}
              aria-label={off ? `${fmt(d, { weekday: "long", day: "numeric", month: "long" })} : ${off === "absent" ? "coach absent" : "complet"}` : undefined}
              onClick={() => setDay(k)}>
              <span>{fmt(d, { weekday: "short" }).replace(".", "")}</span>
              <b>{fmt(d, { day: "numeric" })}</b>
              <small>{off === "absent" ? "Absent" : off === "complet" ? "Complet" : fmt(d, { month: "short" }).replace(".", "")}</small>
            </button>
          );
        })}
      </div>
      {Object.keys(blocked).some((k) => days.some((d) => ymd(d) === k)) && (
        <div className="day-legend">
          {Object.values(blocked).includes("complet") && <span><i className="daykey complet" />Complet : plus de créneau libre</span>}
          {Object.values(blocked).includes("absent") && <span><i className="daykey absent" />Coach absent</span>}
        </div>
      )}
      <div className="chips" style={{ marginBottom: 8 }}>
        {/* Une heure précise remplace la période (matin, soir…): les deux ne se combinent pas */}
        {/* heure précise choisie: les périodes restent affichées mais aucune n'est sélectionnée; en choisir une retire l'heure */}
        {PERIODS.map(([k, l]) => <button key={k} className={"chip small" + (hour === "" && period === k ? " on" : "")} aria-pressed={hour === "" && period === k} onClick={() => { setPeriod(k); setHour(""); }}>{l}</button>)}
        <select className="hoursel" aria-label="Heure idéale (facultatif)" value={hour} onChange={(e) => { setHour(e.target.value); if (e.target.value !== "") setPeriod(""); }}>
          <option value="">Heure : peu importe</option>
          {Array.from({ length: 15 }, (_, i) => i + 8).map((h) => <option key={h} value={h}>Vers {h} h</option>)}
        </select>
      </div>

      <h2 className="step"><span>3</span> Comment voulez-vous jouer ? <small className="mut">plusieurs choix possibles</small></h2>
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
        {["individuel", "duo", "groupe"].filter((k) => kinds.includes(k)).map((k) => (
          <div key={k} className="dur-row" role="group" aria-label={`Durée ${HOW[k].toLowerCase()}`}>
            <span>{HOW[k]}</span>
            <span className="chips">{[60, 90].map((m) => <button key={m} type="button" className={"chip small" + (durs[k].includes(m) ? " on" : "")} aria-pressed={durs[k].includes(m)} onClick={() => toggleDur(k, m)}>{dur(m)}</button>)}</span>
          </div>
        ))}
      </div>

      {!day && <div className="card empty"><Icon name="calendar" size={26} /><b>Choisissez un jour</b></div>}
      {day && offers === null && <Loading rows={2} />}
      {offers && Object.keys(offers.other_kinds ?? {}).length > 0 && (
        <div className="card reconsider" role="note">
          <Icon name="users" size={20} />
          <div style={{ flex: 1 }}>
            <div className="small-p">
              Aussi ce jour-là : {Object.entries(offers.other_kinds).map(([k, n]) => `${n} séance${n > 1 ? "s" : ""} ${k === "duo" ? "à deux" : "en groupe"}`).join(" et ")} de votre niveau.
            </div>
            <div className="actions" style={{ marginTop: 8 }}>
              {Object.keys(offers.other_kinds).map((k) => <button key={k} className="small sec" onClick={() => toggleKind(k)}><Icon name="plus" size={14} /> Accepter aussi {HOW[k].toLowerCase()}</button>)}
            </div>
          </div>
        </div>
      )}
      {offers && offers.too_late.length > 0 && (
        <div className="mut small-p late-hint"><Icon name="clock" size={14} /> À moins de 24 h : seulement rejoindre une séance {offers.too_late.map((k) => HOW[k].toLowerCase()).join(" ou ")} existante.</div>
      )}
      {offers && !solo && (offers.requests ?? []).length > 0 && (
        <>
          <h2 className="accent-h"><Icon name="users" size={16} /> Jouer avec un joueur de votre niveau</h2>
          {offers.requests.map((o) => <RequestOffer key={o.booking_id} o={o} me={me} kinds={kinds} durs={durs} onBooked={booked} />)}
        </>
      )}
      {offers && !solo && offers.groups.length > 0 && (
        <>
          <h2 className="accent-h"><Icon name="users" size={16} /> Rejoindre une séance</h2>
          {list(offers.groups)}
        </>
      )}
      {offers && !solo && (offers.full ?? []).length > 0 && (
        <>
          <h2 className="accent-h"><Icon name="clock" size={16} /> Séances complètes <small className="mut">liste d'attente</small></h2>
          {offers.full.map((o) => <FullOffer key={o.session_id} o={o} />)}
        </>
      )}
      {offers && (
        <>
          {offers.slots_with_court.length > 0 && <h2 className="accent-h"><Icon name="pin" size={16} /> Créneaux libres</h2>}
          {grouped(offers.slots_with_court)}
          {offers.slots_other.length > 0 && (
            <>
              <h2>Autres créneaux <small className="mut">terrain à confirmer</small></h2>
              {grouped(offers.slots_other)}
            </>
          )}
        </>
      )}
      {/* ce que le joueur a déjà ce jour-là (séances, demandes, kiné…): ces heures ne lui sont pas proposées */}
      {offers?.my_day?.length > 0 && (
        <div className="my-day small-p">
          <Icon name="clock" size={13} /> <span>Ce jour-là, vous avez déjà {offers.my_day.map((x) => `${x.label} de ${hhmm(x.start).replace(":", " h ")} à ${hhmm(x.end).replace(":", " h ")}`).join(", ")} : ces heures ne vous sont pas proposées.</span>
        </div>
      )}
      {offers && (offers.hints ?? []).length > 0 && !offers.slots_with_court.length && !offers.slots_other.length && (
        <div className="card note warn" role="note">{offers.hints.map((h) => <div key={h} className="small-p"><Icon name="clock" size={13} /> {h}</div>)}</div>
      )}
      {nothing && !(offers.hints ?? []).length && <div className="card empty"><Icon name="calendar" size={26} /><b>Rien ce jour-là</b><div className="mut">Essayez un autre jour ou tous les coachs.</div></div>}
    </>
  );
}

// Page d'un coach, vue par le joueur
// Le joueur note son coach (après au moins une séance), et peut modifier son avis
function ReviewForm({ coachId, mine, onSaved }) {
  const [r, setR] = useState(mine?.rating ?? 0);
  const [txt, setTxt] = useState(mine?.comment ?? "");
  const [open, setOpen] = useState(!mine);
  const save = () => api(`/me/coaches/${coachId}/review`, { method: "PUT", body: { rating: r, comment: txt } })
    .then(() => { toast("Merci pour votre avis"); setOpen(false); onSaved(); }).catch(toastError);
  if (!open) return <button className="link small-p" onClick={() => setOpen(true)}>Modifier mon avis</button>;
  return (
    <div className="card review-form">
      <b className="small-p">{mine ? "Votre avis" : "Donnez votre avis"}</b>
      <div className="stars pick" role="radiogroup" aria-label="Votre note">
        {[1, 2, 3, 4, 5].map((i) => <button key={i} type="button" role="radio" aria-checked={r === i} aria-label={`${i} sur 5`} className={i <= r ? "on" : ""} onClick={() => setR(i)}><Icon name="star" size={24} /></button>)}
      </div>
      <textarea className="msg" rows={2} maxLength={1000} placeholder="Ce que vous avez aimé (facultatif)" value={txt} onChange={(e) => setTxt(e.target.value)} />
      <div className="actions"><button className="small" disabled={!r} onClick={save}>Publier</button></div>
    </div>
  );
}

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
            <div style={{ marginTop: 4 }}><RatingLine rating={c.rating} count={c.reviews_count} /></div>
          </div>
        </div>
      </div>
      <button className="cta" onClick={() => go(`book/${c.id}`)}><Icon name="calendar" size={20} /> Réserver avec {c.name.split(" ")[0]} <Icon name="chevR" size={18} /></button>

      {c.bio && <div className="card"><div className="mut small-p">À propos</div><div style={{ whiteSpace: "pre-line" }}>{c.bio}</div></div>}
      {c.specialties.length > 0 && (
        <><h2>Spécialités</h2><div className="chips">{c.specialties.map((t) => <span key={t} className="theme big-theme">{t}</span>)}</div></>
      )}
      <h2>Tarifs par heure et par joueur{c.vip && <small className="vip-price inline">vos tarifs privilégiés</small>}</h2>
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
      {c.packs?.length > 0 && (
        <>
          <h2>Packs de crédits</h2>
          <div className="card">
            {c.packs.map((p) => <div key={p.id} className="row avail"><span>{p.name}</span><span>{tnd(p.price_millimes)} <span className="mut">→ {tnd(p.credit_millimes)} de crédits</span></span></div>)}
            <div className="mut small-p" style={{ marginTop: 6 }}>À régler directement à votre coach, qui ajoute les crédits.</div>
          </div>
        </>
      )}
      <h2>Avis des joueurs</h2>
      {c.can_review && <ReviewForm coachId={c.id} mine={c.my_review} onSaved={() => api(`/me/coaches/${id}`).then(setC)} />}
      <ReviewList reviews={c.reviews} />
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
