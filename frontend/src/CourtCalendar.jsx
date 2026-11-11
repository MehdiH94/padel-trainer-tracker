import { useState } from "react";
import { dayLabel, hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import InvitePlayers from "./InvitePlayers.jsx";
import SessionCard from "./SessionCard.jsx";
import { Modal } from "./feedback.jsx";
import { clubCodes, reduction, swipe } from "./ui.jsx";

const TZ = "Africa/Tunis";
const PX_WEEK = 46, PX_DAY = 76; // hauteur d'une heure: semaine, et un seul jour (club, terrain et joueurs en clair)
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
  completable: { label: "Confirmée, encore des places : à compléter", short: "Confirmée · à compléter" },
  incomplet: { label: "Terrain, minimum de joueurs pas atteint", short: "Incomplet" },
  libre: { label: "Terrain réservé, encore aucun joueur", short: "Terrain libre" },
  demande: { label: "Terrain demandé au club, pas confirmé", short: "Demandé" },
  sans_terrain: { label: "Joueurs sans terrain réservé", short: "Sans terrain" },
  refuse: { label: "Terrain refusé par le club", short: "Refusé" },
  evenement: { label: "Autre chose (rendez-vous, tournoi…) : aucune séance à ce moment-là", short: "Autre" },
};

// Côte à côte quand plusieurs blocs se chevauchent le même jour
export function lanes(items) {
  const ends = [];
  return items.map((cb) => {
    const s = hourOf(cb.start), e = s + cb.duration_min / 60;
    let lane = ends.findIndex((end) => end <= s + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(e); } else ends[lane] = e;
    return { cb, s, e, lane };
  }).map((x, _, all) => ({ ...x, count: Math.max(...all.filter((y) => y.s < x.e && x.s < y.e).map((y) => y.lane)) + 1 }));
}

function Details({ cb, session, promo, cardProps, onClose, onRemove, onStopPromo, onChanged, onCreateAt }) {
  const [inviting, setInviting] = useState(false);
  const end = endIso(cb);
  const st = STATES[cb.state];
  return (
    <Modal onClose={onClose} label={session ? "Séance" : "Terrain"}>
      <div className="row"><span className={"cal-pill " + cb.state}>{st?.short}</span><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <b className="sheet-title" style={{ marginTop: 8 }}><span className="cap1">{dayLabel(cb.start)}</span> · {h24(cb.start)} – {h24(end)}</b>
      {cb.club_name && <div className="mut">{cb.club_name}{cb.court_label && ` · ${cb.court_label}`}{cb.series_id && <> · <Icon name="repeat" size={12} /> régulier</>}</div>}
      {cb.cost_millimes > 0 && <div className="mut small-p">Payé au club : {tnd(cb.cost_millimes)}</div>}
      <p className="small-p">{st?.label}.</p>
      {cb.state === "completable" && <p className="mut small-p">La séance a lieu quoi qu'il arrive (minimum atteint), mais les joueurs acceptent d'être plus nombreux : complétez-la jusqu'au dernier moment, ils paieront le prix du groupe.</p>}
      {cb.state === "sans_terrain" && <p className="small-p warn-txt">Pensez à réserver un terrain pour cette séance : ajoutez-le avec « + Terrain » (il sera utilisé automatiquement s'il couvre l'horaire) ou demandez-le au club.</p>}
      {cb.state === "demande" && <p className="mut small-p">{cb.sent_at ? "SMS envoyé au club, en attente de sa réponse." : "Demande prête : le SMS part 7 jours avant la séance (ou depuis Mes terrains)."}</p>}
      {/* Séance: la même carte que dans la liste du jour (joueurs, compléter, effectuée, annuler…) */}
      {session && cardProps && (session.status === "effectuee" && cardProps.renderDone
        ? cardProps.renderDone(session, onClose)
        : <SessionCard s={session} {...cardProps} onPrepare={(x) => { onClose(); cardProps.onPrepare(x); }} />)}
      {!session && cb.players?.length > 0 && (
        <div className="card" style={{ marginBottom: 8 }}>
          <b className="small-p">{cb.players_count} joueur{cb.players_count > 1 ? "s" : ""}{cb.min_needed > 1 && ` · minimum voulu ${cb.min_needed}`}</b>
          <div className="mut small-p">{cb.players.join(", ")}</div>
        </div>
      )}
      <div className="actions" style={{ flexDirection: "column" }}>
        {cb.state === "libre" && <p className="mut small-p" style={{ margin: "0 0 4px" }}>Ce terrain est libre. Vous pouvez :</p>}
        {cb.state === "libre" && (
          <button className="sec choice" onClick={() => setInviting("court")}>
            <Icon name="send" size={18} /><span><b>Prévenir mes joueurs</b><small>« Ce créneau est disponible, venez vous entraîner ! », en heures creuses si vous voulez (réduction en dinars). Chacun réserve sa formule (seul, à deux, en groupe) et vous confirmez comme d'habitude.</small></span>
          </button>
        )}
        {cb.state === "libre" && onCreateAt && (
          <button className="sec choice" onClick={() => { onCreateAt(cb); onClose(); }}>
            <Icon name="plus" size={18} /><span><b>Créer un entraînement précis</b><small>Vous choisissez l'heure, la formule (ex. groupe de 4), puis vous invitez vos joueurs en expliquant l'entraînement.</small></span>
          </button>
        )}
        {!session && (cb.state === "incomplet" || cb.state === "completable") && cb.session_id && <button onClick={() => setInviting(true)}><Icon name="users" size={15} /> Compléter la séance</button>}
        {cb.state === "libre" && promo && <button className="sec" onClick={() => { onStopPromo(promo); onClose(); }}>Arrêter les heures creuses {reduction(promo)}</button>}
        {cb.state === "libre" && cb.source === "manuel" && onRemove && <button className="sec danger" onClick={() => { onRemove(cb); onClose(); }}><Icon name="trash" size={15} /> Supprimer ce terrain</button>}
      </div>
      {inviting === true && <InvitePlayers sessionId={cb.session_id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); onChanged(); onClose(); }} />}
      {inviting === "court" && <InvitePlayers courtId={cb.id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); onClose(); }} />}
    </Modal>
  );
}

// Autre chose que des séances sur le planning (rendez-vous, tournoi…): le créneau est bloqué
function EventDetails({ ev, onClose, onRemove }) {
  return (
    <Modal onClose={onClose} label="Événement">
      <div className="row"><span className="cal-pill evenement">Autre</span><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <b className="sheet-title" style={{ marginTop: 8 }}>{ev.title}</b>
      <div className="mut"><span className="cap1">{dayLabel(ev.start)}</span> · {h24(ev.start)} – {h24(endIso(ev))}</div>
      {ev.note && <p className="small-p">{ev.note}</p>}
      <p className="mut small-p">Aucune séance ni réservation de joueur ne peut avoir lieu à ce moment-là.</p>
      {onRemove && <div className="actions"><button className="sec danger" onClick={() => { onRemove(ev); onClose(); }}><Icon name="trash" size={15} /> Supprimer</button></div>}
    </Modal>
  );
}

// Absence du coach ce jour-là ? (dates de Tunis « AAAA-MM-JJ », bornes incluses)
export const offOn = (offs, key) => offs.find((o) => o.start_date <= key && key <= o.end_date);

// Calendrier: semaine (par défaut) ou un seul jour (toucher l'en-tête d'un jour). Terrains (couleur selon leur état),
// séances qui n'ont pas encore de terrain, et absences du coach (vacances…).
// sessions / cardProps (facultatifs): séances du coach, pour ouvrir leur carte complète depuis le calendrier.
export default function CourtCalendar({ list, promos = [], sessions = [], offs = [], events = [], onRemoveEvent, cardProps, monday: weekStart, onWeek, onRemove, onStopPromo, onChanged, onCreateAt, onRemoveOff, maxMonday, onAddAt }) {
  const [adding, setAdding] = useState(null); // case vide touchée: { date, time }
  const [own, setOwn] = useState(mondayOf(new Date()));
  const monday = weekStart ?? own;
  const setMonday = onWeek ?? setOwn;
  const [sel, setSel] = useState(null);
  const [day, setDay] = useState(null); // vue d'un seul jour (date de Tunis), sinon la semaine
  const dayDate = day && new Date(day + "T12:00:00Z");
  const PX = day ? PX_DAY : PX_WEEK;
  const days = day ? [dayDate] : Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const today = ymd(new Date());
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const name = (id) => cardProps?.byId?.(id)?.name?.split(" ")[0] ?? "";
  // séances prévues sans terrain: des joueurs veulent jouer à cette heure, mais aucun terrain n'est réservé
  const noCourt = sessions.filter((s) => s.status === "prevue" && !s.court_status).map((s) => ({
    id: "s" + s.id, start: s.start, duration_min: s.duration_min, state: "sans_terrain", club_name: s.club, court_label: s.court,
    session_id: s.id, players: s.player_ids.map(name).filter(Boolean), players_count: s.player_ids.length, min_needed: s.min_players,
  }));
  // autres choses sur le planning (rendez-vous, tournoi…)
  const evs = events.map((e) => ({ ...e, id: "e" + e.id, event_id: e.id, state: "evenement" }));
  const shown = [...list.filter((cb) => cb.start && STATES[cb.state] && cb.session_status !== "annulee"), ...noCourt, ...evs];
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
  // Légende: seulement les couleurs présentes à l'écran
  const present = new Set(all.map((x) => x.cb.state));
  const legend = Object.entries(STATES).filter(([k]) => present.has(k));
  const dayOff = day && offOn(offs, day);
  const anyOff = days.some((d) => offOn(offs, ymd(d)));
  const lastDay = maxMonday ? ymd(addDays(maxMonday, 6)) : null;
  const moveDay = (n) => {
    const d = ymd(addDays(dayDate, n));
    if (n > 0 && lastDay && d > lastDay) return;
    setDay(d);
    setMonday(mondayOf(new Date(d + "T12:00:00Z")));
  };
  const removeOff = (o) => onRemoveOff?.(o);
  // Glisser le doigt: semaine (ou jour) suivante vers la gauche, précédente vers la droite
  const nextWeek = () => { const m = addDays(monday, 7); if (!maxMonday || ymd(m) <= ymd(maxMonday)) setMonday(m); };
  const swipeCal = swipe(day ? () => moveDay(1) : nextWeek, day ? () => moveDay(-1) : () => setMonday(addDays(monday, -7)));
  return (
    <>
      {!weekStart && !day && (
        <div className="row" style={{ margin: "6px 0" }}>
          <b className="cap1">{month}</b>
          <div className="row" style={{ gap: 4 }}>
            <button className="small sec iconbtn" aria-label="Semaine précédente" onClick={() => setMonday(addDays(monday, -7))}><Icon name="chevL" size={16} /></button>
            <button className="small sec" onClick={() => setMonday(mondayOf(new Date()))}>Cette semaine</button>
            <button className="small sec iconbtn" aria-label="Semaine suivante" disabled={!!maxMonday && ymd(monday) >= ymd(maxMonday)} onClick={() => setMonday(addDays(monday, 7))}><Icon name="chevR" size={16} /></button>
          </div>
        </div>
      )}
      {day && (
        <div className="row cal-daybar">
          <button className="small sec" onClick={() => setDay(null)}><Icon name="chevL" size={15} /> Semaine</button>
          <div className="row" style={{ gap: 4 }}>
            <button className="small sec iconbtn" aria-label="Jour précédent" onClick={() => moveDay(-1)}><Icon name="chevL" size={16} /></button>
            <b className="cap1">{dayDate.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</b>
            <button className="small sec iconbtn" aria-label="Jour suivant" disabled={!!lastDay && day >= lastDay} onClick={() => moveDay(1)}><Icon name="chevR" size={16} /></button>
          </div>
        </div>
      )}
      {!day && <p className="mut small-p" style={{ margin: "0 0 6px" }}>Touchez un jour pour l'afficher en grand, une case vide pour y ajouter une séance ou un terrain.</p>}
      {(legend.length > 0 || anyOff) && (
        <div className="cal-legend">
          {legend.map(([k, v]) => <span key={k}><i className={"cal-dot " + k} />{v.label}</span>)}
          {anyOff && <span><i className="cal-dot off" />Absence (aucun créneau proposé)</span>}
        </div>
      )}
      {dayOff && (
        <div className="note warn" style={{ marginBottom: 8 }}>
          <Icon name="sun" size={15} /> <b>Absent</b>{dayOff.reason && ` · ${dayOff.reason}`}{dayOff.start_date !== dayOff.end_date && ` (du ${dayOff.start_date.split("-").reverse().slice(0, 2).join("/")} au ${dayOff.end_date.split("-").reverse().slice(0, 2).join("/")})`} : aucun créneau n'est proposé aux joueurs.
          {onRemoveOff && <div><button className="link" onClick={() => removeOff(dayOff)}>Supprimer cette absence</button></div>}
        </div>
      )}
      <div className={"cal card" + (day ? " one" : "")} {...swipeCal} role="grid" aria-label={day ? "Calendrier du jour" : "Calendrier de la semaine : séances et terrains"}>
        <div className="cal-head">
          <span />
          {days.map((d) => {
            const k = ymd(d), off = offOn(offs, k);
            const label = <>{d.toLocaleDateString("fr-FR", { weekday: "short", timeZone: TZ }).replace(".", "")}<b>{d.toLocaleDateString("fr-FR", { day: "numeric", timeZone: TZ })}</b></>;
            return day ? <span key={k} className={k === today ? "today" : ""}>{label}</span> : (
              <button key={k} className={"cal-day" + (k === today ? " today" : "") + (off ? " off" : "")} onClick={() => setDay(k)}
                aria-label={`Afficher ${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })}${off ? " (absent)" : ""}`}>
                {label}
              </button>
            );
          })}
        </div>
        <div className="cal-body" style={{ height: (maxH - minH) * PX }}>
          <div className="cal-times">{hours.map((h) => <span key={h} style={{ top: (h - minH) * PX }}>{h} h</span>)}</div>
          {days.map((d) => {
            const off = offOn(offs, ymd(d));
            return (
              <div key={ymd(d)} className={"cal-col" + (ymd(d) === today ? " today" : "") + (off ? " off" : "") + (onAddAt ? " addable" : "")} style={{ backgroundSize: `100% ${PX}px` }}
                onClick={(e) => { // case vide touchée: ajouter une séance ou un terrain à ce jour et cette heure (à la demi-heure)
                  if (!onAddAt || e.target !== e.currentTarget) return;
                  const y = (e.clientY - e.currentTarget.getBoundingClientRect().top) / PX;
                  const t = Math.min(23.5, Math.max(6, Math.floor((minH + y) * 2) / 2));
                  setAdding({ date: ymd(d), time: `${String(Math.floor(t)).padStart(2, "0")}:${t % 1 ? "30" : "00"}` });
                }}>
                {off && !day && <button className="cal-off" onClick={() => setDay(ymd(d))} title={off.reason || "Absent"}>{off.reason || "Absent"}</button>}
                {byDay[ymd(d)].map(({ cb, s, e, lane, count }) => (
                  <button key={cb.id} className={"cal-block " + cb.state} onClick={() => setSel(cb)}
                    style={{ top: (s - minH) * PX, height: Math.max((e - s) * PX - 2, 18), left: `${(lane / count) * 100}%`, width: `${100 / count}%` }}
                    aria-label={`${STATES[cb.state].short}, ${h24(cb.start)}${cb.club_name ? ", " + cb.club_name : ""}`}>
                    {cb.state === "evenement" && <small className="ev-title">{cb.title}</small>}
                    <b>{byId[cb.session_id]?.feedback_missing && byId[cb.session_id]?.status === "effectuee" && <i className="todo-dot mini" title="À noter" />}{short(cb.start)}–{short(endIso(cb))}{day && cb.state !== "evenement" && ` · ${STATES[cb.state].short}`}</b>
                    {day && cb.club_name && <small>{cb.club_name}{cb.court_label && ` · ${cb.court_label}`}</small>}
                    {!day && multi && cb.club_name && <small className="club-code">{codes[cb.club_name]}</small>}
                    {day && cb.players?.length > 0 && <small>{cb.players.join(", ")}{cb.state === "completable" ? ` · encore ${cb.max_players - cb.players_count} place${cb.max_players - cb.players_count > 1 ? "s" : ""}` : cb.min_needed > 1 ? ` (${cb.players_count}/${cb.min_needed})` : ""}</small>}
                    {!day && cb.players_count > 0 && <small>{cb.state === "completable" ? `${cb.players_count}/${cb.max_players} j. +` : `${cb.players_count}${cb.min_needed > 1 ? `/${cb.min_needed}` : ""} j.`}</small>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {multi && weekClubs.length > 0 && !day && (
        <div className="club-legend">{weekClubs.map((n) => <span key={n}><b className="club-code">{codes[n]}</b> {n}</span>)}</div>
      )}
      {all.length === 0 && <p className="mut center small-p">{day ? "Rien ce jour-là." : "Rien cette semaine."} Ajoutez un terrain réservé ou une séance.</p>}
      {sel?.state === "evenement" && <EventDetails ev={sel} onClose={() => setSel(null)} onRemove={onRemoveEvent && ((x) => onRemoveEvent({ ...x, id: x.event_id }))} />}
      {sel && sel.state !== "evenement" && <Details cb={sel} session={byId[sel.session_id]} cardProps={cardProps} promo={promos.find((p) => p.court_booking_id === sel.id && p.active)}
        onClose={() => setSel(null)} onRemove={onRemove} onStopPromo={onStopPromo} onChanged={onChanged} onCreateAt={onCreateAt} />}
      {adding && (
        <Modal onClose={() => setAdding(null)} label="Ajouter">
          <div className="row"><b className="sheet-title cap1">{new Date(adding.date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })} · {adding.time.replace(":", " h ")}</b><button className="small sec iconbtn" aria-label="Fermer" onClick={() => setAdding(null)}><Icon name="x" size={15} /></button></div>
          <div className="actions" style={{ flexDirection: "column" }}>
            <button className="sec choice" onClick={() => { onAddAt("session", adding); setAdding(null); }}><Icon name="plus" size={18} /><span><b>Ajouter une séance</b><small>Formulaire prérempli à ce jour et cette heure.</small></span></button>
            <button className="sec choice" onClick={() => { onAddAt("court", adding); setAdding(null); }}><Icon name="pin" size={18} /><span><b>Ajouter un terrain</b><small>Terrain réservé au club à partir de cette heure.</small></span></button>
            <button className="sec choice" onClick={() => { onAddAt("event", adding); setAdding(null); }}><Icon name="calendar" size={18} /><span><b>Ajouter autre chose</b><small>Rendez-vous, tournoi, réunion… : pas de séance à ce moment-là.</small></span></button>
          </div>
        </Modal>
      )}
    </>
  );
}
