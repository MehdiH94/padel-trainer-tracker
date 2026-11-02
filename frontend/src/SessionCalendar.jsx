import { useState } from "react";
import { hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import SessionCard from "./SessionCard.jsx";
import { Modal } from "./feedback.jsx";
import { KIND } from "./ui.jsx";

const TZ = "Africa/Tunis";
const PX = 40; // hauteur d'une heure
const toDate = (iso) => new Date(iso + (iso.endsWith("Z") || /[+-]\d\d:\d\d$/.test(iso) ? "" : "Z"));
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const hourOf = (iso) => { const [h, m] = hhmm(iso).split(":").map(Number); return h + m / 60; };

// Côte à côte quand plusieurs séances se chevauchent le même jour
function lanes(items) {
  const ends = [];
  return items.map((s) => {
    const a = hourOf(s.start), e = a + s.duration_min / 60;
    let lane = ends.findIndex((end) => end <= a + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(e); } else ends[lane] = e;
    return { s, a, e, lane };
  }).map((x, _, all) => ({ ...x, count: Math.max(...all.filter((y) => y.a < x.e && x.a < y.e).map((y) => y.lane)) + 1 }));
}

// Semaine du planning en calendrier: une séance = un bloc de la couleur de sa formule
export default function SessionCalendar({ week, sessions, byId, name, today, cardProps }) {
  const [open, setOpen] = useState(null);
  const shown = sessions.filter((s) => s.status !== "annulee");
  const byDay = Object.fromEntries(week.map((d) => [ymd(d), lanes(shown.filter((s) => ymd(toDate(s.start)) === ymd(d)).sort((a, b) => toDate(a.start) - toDate(b.start)))]));
  const all = Object.values(byDay).flat();
  const minH = Math.min(8, ...all.map((x) => Math.floor(x.a)));
  const maxH = Math.max(21, ...all.map((x) => Math.ceil(x.e)));
  const hours = Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i);
  const sel = open && sessions.find((s) => s.id === open);
  const first = (s) => s.player_ids.map((id) => byId(id)?.name.split(" ")[0]).filter(Boolean).join(", ");
  return (
    <>
      <div className="cal card" role="grid" aria-label="Séances de la semaine">
        <div className="cal-head">
          <span />
          {week.map((d) => (
            <span key={ymd(d)} className={ymd(d) === today ? "today" : ""}>
              {d.toLocaleDateString("fr-FR", { weekday: "short", timeZone: TZ }).replace(".", "")}<b>{d.toLocaleDateString("fr-FR", { day: "numeric", timeZone: TZ })}</b>
            </span>
          ))}
        </div>
        <div className="cal-body" style={{ height: (maxH - minH) * PX }}>
          <div className="cal-times">{hours.map((h) => <span key={h} style={{ top: (h - minH) * PX }}>{h} h</span>)}</div>
          {week.map((d) => (
            <div key={ymd(d)} className={"cal-col" + (ymd(d) === today ? " today" : "")} style={{ backgroundSize: `100% ${PX}px` }}>
              {byDay[ymd(d)].map(({ s, a, e, lane, count }) => (
                <button key={s.id} className={"cal-block sess-block " + s.status} onClick={() => setOpen(s.id)}
                  style={{ top: (a - minH) * PX, height: Math.max((e - a) * PX - 2, 18), left: `${(lane / count) * 100}%`, width: `${100 / count}%`, background: KIND[s.kind]?.color }}
                  aria-label={`${KIND[s.kind]?.label}, ${hhmm(s.start)}, ${first(s) || "sans joueur"}${s.club ? ", " + s.club : ""}`}>
                  <b>{hhmm(s.start)}</b>
                  <small>{first(s) || "—"}</small>
                  {s.court && <small>{s.court}</small>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      {all.length === 0 && <p className="mut center small-p">Aucune séance cette semaine.</p>}
      {sel && (
        <Modal onClose={() => setOpen(null)} label="Séance">
          <div className="row" style={{ marginBottom: 6 }}>
            <b className="sheet-title" style={{ textTransform: "capitalize" }}>{toDate(sel.start).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })}</b>
            <button className="small sec iconbtn" aria-label="Fermer" onClick={() => setOpen(null)}><Icon name="x" size={15} /></button>
          </div>
          <SessionCard s={sel} name={name} byId={byId} {...cardProps} onPrepare={(x) => { setOpen(null); cardProps.onPrepare(x); }} />
        </Modal>
      )}
    </>
  );
}
