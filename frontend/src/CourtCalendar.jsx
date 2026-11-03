import { useState } from "react";
import { dayLabel, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import InvitePlayers from "./InvitePlayers.jsx";
import SessionCard from "./SessionCard.jsx";
import { Modal } from "./feedback.jsx";
import { clubCodes } from "./ui.jsx";

const TZ = "Africa/Tunis";
const PX = 46; // hauteur d'une heure (assez pour l'heure, le club et les joueurs)
const toDate = (iso) => new Date(iso + (iso.endsWith("Z") || /[+-]\d\d:\d\d$/.test(iso) ? "" : "Z"));
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
export const mondayOf = (d) => addDays(d, -((new Date(ymd(d) + "T12:00:00Z").getUTCDay() + 6) % 7));
const hourOf = (iso) => { const [h, m] = hhmm(iso).split(":").map(Number); return h + m / 60; };
const h24 = (iso) => hhmm(iso).replace(":", " h ").replace(" h 00", " h");
// « 8–12 », « 17h30–19 »: heures de début et de fin, compactes pour les blocs
const short = (iso) => { const [h, m] = hhmm(iso).split(":"); return `${+h}${m === "00" ? "" : "h" + m}`; };
const endIso = (cb) => new Date(toDate(cb.start).getTime() + cb.duration_min * 60000).toISOString();

// Une couleur par situation (légende sous l'en-tête): terrains et séances dans le même calendrier
export const STATES = {
  complet: { label: "Terrain + joueurs au complet", short: "Complet" },
  incomplet: { label: "Terrain, minimum de joueurs pas atteint", short: "Incomplet" },
  libre: { label: "Terrain réservé, encore aucun joueur", short: "Terrain libre" },
  demande: { label: "Terrain demandé au club, pas confirmé", short: "Demandé" },
  sans_terrain: { label: "Joueurs sans terrain réservé", short: "Sans terrain" },
  refuse: { label: "Terrain refusé par le club", short: "Refusé" },
};

// Côte à côte quand plusieurs blocs se chevauchent le même jour
function lanes(items) {
  const ends = [];
  return items.map((cb) => {
    const s = hourOf(cb.start), e = s + cb.duration_min / 60;
    let lane = ends.findIndex((end) => end <= s + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(e); } else ends[lane] = e;
    return { cb, s, e, lane };
  }).map((x, _, all) => ({ ...x, count: Math.max(...all.filter((y) => y.s < x.e && x.s < y.e).map((y) => y.lane)) + 1 }));
}

function Details({ cb, session, promo, cardProps, onClose, onRemove, onPromo, onStopPromo, onChanged, onCreateAt }) {
  const [inviting, setInviting] = useState(false);
  const end = endIso(cb);
  const st = STATES[cb.state];
  return (
    <Modal onClose={onClose} label={session ? "Séance" : "Terrain"}>
      <div className="row"><span className={"cal-pill " + cb.state}>{st?.short}</span><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <b className="sheet-title" style={{ marginTop: 8 }}><span style={{ textTransform: "capitalize" }}>{dayLabel(cb.start)}</span> · {h24(cb.start)} – {h24(end)}</b>
      {cb.club_name && <div className="mut">{cb.club_name}{cb.court_label && ` · ${cb.court_label}`}{cb.series_id && <> · <Icon name="repeat" size={12} /> régulier</>}</div>}
      <p className="small-p">{st?.label}.</p>
      {cb.state === "sans_terrain" && <p className="small-p warn-txt">Pensez à réserver un terrain pour cette séance : ajoutez-le avec « + Terrain » (il sera utilisé automatiquement s'il couvre l'horaire) ou demandez-le au club.</p>}
      {cb.state === "demande" && <p className="mut small-p">{cb.sent_at ? "SMS envoyé au club, en attente de sa réponse." : "Demande prête : le SMS part 7 jours avant la séance (ou depuis Mes terrains)."}</p>}
      {/* Séance: la même carte que dans la liste du jour (joueurs, compléter, effectuée, annuler…) */}
      {session && cardProps && <SessionCard s={session} {...cardProps} onPrepare={(x) => { onClose(); cardProps.onPrepare(x); }} />}
      {!session && cb.players?.length > 0 && (
        <div className="card" style={{ marginBottom: 8 }}>
          <b className="small-p">{cb.players_count} joueur{cb.players_count > 1 ? "s" : ""}{cb.min_needed > 1 && ` · minimum voulu ${cb.min_needed}`}</b>
          <div className="mut small-p">{cb.players.join(", ")}</div>
        </div>
      )}
      <div className="actions" style={{ flexDirection: "column" }}>
        {cb.state === "libre" && onCreateAt && <button onClick={() => { onCreateAt(cb); onClose(); }}><Icon name="plus" size={15} /> Créer une séance sur ce terrain</button>}
        {!session && cb.state === "incomplet" && cb.session_id && <button onClick={() => setInviting(true)}><Icon name="users" size={15} /> Compléter la séance</button>}
        {cb.state === "libre" && <button className="sec" onClick={() => setInviting("court")}><Icon name="send" size={15} /> Prévenir mes joueurs</button>}
        {cb.state === "libre" && onPromo && (promo
          ? <button className="sec" onClick={() => { onStopPromo(promo); onClose(); }}>Arrêter la promotion −{promo.discount_pct} %</button>
          : <button className="sec" onClick={() => { onPromo(cb); onClose(); }}><Icon name="sparkles" size={15} /> Proposer une promotion</button>)}
        {cb.state === "libre" && cb.source === "manuel" && onRemove && <button className="sec danger" onClick={() => { onRemove(cb); onClose(); }}><Icon name="trash" size={15} /> Supprimer ce terrain</button>}
      </div>
      {inviting === true && <InvitePlayers sessionId={cb.session_id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); onChanged(); onClose(); }} />}
      {inviting === "court" && <InvitePlayers courtId={cb.id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); onClose(); }} />}
    </Modal>
  );
}

// Calendrier de la semaine: les terrains (couleur selon leur état) et les séances qui n'ont pas encore de terrain.
// sessions / cardProps (facultatifs): séances du coach, pour ouvrir leur carte complète depuis le calendrier.
export default function CourtCalendar({ list, promos = [], sessions = [], cardProps, monday: weekStart, onWeek, onRemove, onPromo, onStopPromo, onChanged, onCreateAt }) {
  const [own, setOwn] = useState(mondayOf(new Date()));
  const monday = weekStart ?? own;
  const setMonday = onWeek ?? setOwn;
  const [sel, setSel] = useState(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const today = ymd(new Date());
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const name = (id) => cardProps?.byId?.(id)?.name?.split(" ")[0] ?? "";
  // séances prévues sans terrain: des joueurs veulent jouer à cette heure, mais aucun terrain n'est réservé
  const noCourt = sessions.filter((s) => s.status === "prevue" && !s.court_status).map((s) => ({
    id: "s" + s.id, start: s.start, duration_min: s.duration_min, state: "sans_terrain", club_name: s.club, court_label: s.court,
    session_id: s.id, players: s.player_ids.map(name).filter(Boolean), players_count: s.player_ids.length, min_needed: s.min_players,
  }));
  const shown = [...list.filter((cb) => cb.start && STATES[cb.state] && cb.session_status !== "annulee"), ...noCourt];
  const byDay = Object.fromEntries(days.map((d) => [ymd(d), lanes(shown.filter((cb) => ymd(toDate(cb.start)) === ymd(d)).sort((a, b) => toDate(a.start) - toDate(b.start)))]));
  const all = Object.values(byDay).flat();
  const minH = Math.min(8, ...all.map((x) => Math.floor(x.s)));
  const maxH = Math.max(21, ...all.map((x) => Math.ceil(x.e)));
  const hours = Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i);
  const month = days[0].toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: TZ });
  // Plusieurs clubs: un code court du club sur chaque bloc (légende sous le calendrier)
  const codes = clubCodes(shown.map((cb) => cb.club_name));
  const multi = Object.keys(codes).length > 1;
  const weekClubs = [...new Set(all.map((x) => x.cb.club_name).filter(Boolean))];
  const present = new Set(shown.map((cb) => cb.state));
  return (
    <>
      {!weekStart && (
        <div className="row" style={{ margin: "6px 0" }}>
          <b style={{ textTransform: "capitalize" }}>{month}</b>
          <div className="row" style={{ gap: 4 }}>
            <button className="small sec iconbtn" aria-label="Semaine précédente" onClick={() => setMonday(addDays(monday, -7))}><Icon name="chevL" size={16} /></button>
            <button className="small sec" onClick={() => setMonday(mondayOf(new Date()))}>Cette semaine</button>
            <button className="small sec iconbtn" aria-label="Semaine suivante" onClick={() => setMonday(addDays(monday, 7))}><Icon name="chevR" size={16} /></button>
          </div>
        </div>
      )}
      <div className="cal-legend">
        {Object.entries(STATES).filter(([k]) => k !== "refuse" || present.has(k)).map(([k, v]) => <span key={k}><i className={"cal-dot " + k} />{v.label}</span>)}
      </div>
      <div className="cal card" role="grid" aria-label="Calendrier de la semaine : séances et terrains">
        <div className="cal-head">
          <span />
          {days.map((d) => (
            <span key={ymd(d)} className={ymd(d) === today ? "today" : ""}>
              {d.toLocaleDateString("fr-FR", { weekday: "short", timeZone: TZ }).replace(".", "")}<b>{d.toLocaleDateString("fr-FR", { day: "numeric", timeZone: TZ })}</b>
            </span>
          ))}
        </div>
        <div className="cal-body" style={{ height: (maxH - minH) * PX }}>
          <div className="cal-times">{hours.map((h) => <span key={h} style={{ top: (h - minH) * PX }}>{h} h</span>)}</div>
          {days.map((d) => (
            <div key={ymd(d)} className={"cal-col" + (ymd(d) === today ? " today" : "")} style={{ backgroundSize: `100% ${PX}px` }}>
              {byDay[ymd(d)].map(({ cb, s, e, lane, count }) => (
                <button key={cb.id} className={"cal-block " + cb.state} onClick={() => setSel(cb)}
                  style={{ top: (s - minH) * PX, height: Math.max((e - s) * PX - 2, 18), left: `${(lane / count) * 100}%`, width: `${100 / count}%` }}
                  aria-label={`${STATES[cb.state].short}, ${h24(cb.start)}${cb.club_name ? ", " + cb.club_name : ""}`}>
                  <b>{short(cb.start)}–{short(endIso(cb))}</b>
                  {multi && cb.club_name && <small className="club-code">{codes[cb.club_name]}</small>}
                  {cb.players_count > 0 && <small>{cb.players_count}{cb.min_needed > 1 ? `/${cb.min_needed}` : ""} j.</small>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      {multi && weekClubs.length > 0 && (
        <div className="club-legend">{weekClubs.map((n) => <span key={n}><b className="club-code">{codes[n]}</b> {n}</span>)}</div>
      )}
      {all.length === 0 && <p className="mut center small-p">Rien cette semaine. Ajoutez un terrain réservé ou une séance.</p>}
      {sel && <Details cb={sel} session={byId[sel.session_id]} cardProps={cardProps} promo={promos.find((p) => p.court_booking_id === sel.id && p.active)}
        onClose={() => setSel(null)} onRemove={onRemove} onPromo={onPromo} onStopPromo={onStopPromo} onChanged={onChanged} onCreateAt={onCreateAt} />}
    </>
  );
}
