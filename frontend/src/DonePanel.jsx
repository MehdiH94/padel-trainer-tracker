import { useEffect, useRef, useState } from "react";
import { api, dayKey, hhmm, shortDate } from "./api.js";
import FeedbackEditor from "./FeedbackEditor.jsx";
import Icon from "./Icon.jsx";
import SessionPayments, { PlayerSwitch } from "./SessionPayments.jsx";
import { AvatarStack, KIND, PlayerTag } from "./ui.jsx";

// Séance effectuée: un joueur à la fois (règlement: encaisser / rembourser un absent, puis retour de séance et araignée).
// Le même panneau sert à l'accueil (séances du jour à noter) et au planning (toutes les séances).

// Bandeau « N séances à noter » (point rouge): une pastille par séance, qui ouvre son panneau
export function ToRate({ list, openId, setOpen, name, title }) {
  if (!list.length) return null;
  const today = dayKey(new Date().toISOString());
  return (
    <div className="card torate">
      <div className="row"><b><i className="todo-dot" /> {list.length} séance{list.length > 1 ? "s" : ""} à noter{title ?? ""}</b><span className="mut small-p">retour et araignée</span></div>
      <div className="donestrip" style={{ marginTop: 8 }}>
        {list.map((s) => (
          <button key={s.id} className={"donechip" + (openId === s.id ? " on" : "")} onClick={() => setOpen(openId === s.id ? null : s.id)}>
            <i className="todo" />
            <AvatarStack names={s.player_ids.map(name)} size={24} />
            <b>{hhmm(s.start)}</b>
            <small>{dayKey(s.start) === today ? "aujourd'hui" : shortDate(s.start)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

// Panneau d'une séance terminée: un retour par joueur
export default function DonePanel({ s, name, byId, strokes, onSaved, onClose, children, scroll = true }) {
  const ref = useRef(null);
  const [list, setList] = useState(null);
  const [who, setWho] = useState(null);
  const load = () => api(`/sessions/${s.id}/feedback`).then((l) => { setList(l); setWho((w) => w ?? l[0]?.player_id); });
  useEffect(() => { setList(null); setWho(null); load(); }, [s.id]);
  // le panneau s'ouvre sous la liste: on l'amène à l'écran pour ne pas avoir à descendre
  useEffect(() => { if (list && scroll) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [s.id, !!list]);
  if (!list) return null;
  const cur = list.find((x) => x.player_id === who) ?? list[0];
  const idx = list.indexOf(cur);
  return (
    <div className="card donepanel" ref={ref}>
      <div className="row">
        <b className="cap1">{shortDate(s.start)} · {hhmm(s.start)} · {KIND[s.kind].label}</b>
        {onClose && <button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button>}
      </div>
      {/* un joueur à la fois: règlement puis retour de séance */}
      <PlayerSwitch ids={list.map((x) => x.player_id)} cur={cur?.player_id} setCur={setWho} byId={byId} name={name}
        mark={(id) => { const x = list.find((y) => y.player_id === id); return !(x.worked_on.length || x.note || x.to_improve); }} />
      {list.length === 1 && <div className="mut" style={{ margin: "4px 0" }}><PlayerTag p={byId?.(cur.player_id) ?? cur} /></div>}
      {s.payments?.length > 0 && cur && (
        <>
          <div className="mut small-p" style={{ marginTop: 8 }}>Règlement</div>
          <SessionPayments s={s} name={name} byId={byId} onPaid={onSaved} playerId={cur.player_id} />
        </>
      )}
      <div className="mut small-p" style={{ marginTop: 8 }}>Retour de séance</div>
      {cur && <FeedbackEditor key={cur.player_id} h={cur} playerId={cur.player_id} name={byId?.(cur.player_id)?.name} strokes={strokes} rate onSaved={() => { load(); onSaved(); }} />}
      {idx >= 0 && idx < list.length - 1 && (
        <button className="sec" style={{ width: "100%", marginTop: 8 }} onClick={() => { setWho(list[idx + 1].player_id); ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
          Joueur suivant : {name(list[idx + 1].player_id).split(" ")[0]} <Icon name="chevR" size={16} />
        </button>
      )}
      {children}
    </div>
  );
}

