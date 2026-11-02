import { useState } from "react";
import { hhmm, tnd } from "./api.js";
import InvitePlayers from "./InvitePlayers.jsx";
import Icon from "./Icon.jsx";
import { AvatarStack, COURT_STATUS, KIND, PlayerTags, STATUS, Where } from "./ui.jsx";

export default function SessionCard({ s, name, byId, onStatus, onDuplicate, onPrepare, onChanged }) {
  const [inviting, setInviting] = useState(false);
  const short = s.status === "prevue" && s.player_ids.length < s.min_players; // pas encore assez de joueurs
  const canInvite = s.status === "prevue" && s.open && s.max_players > s.player_ids.length;
  const names = s.player_ids.map(name);
  const k = KIND[s.kind];
  const end = new Date(new Date(s.start.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s.start) ? s.start : s.start + "Z").getTime() + s.duration_min * 60000).toISOString();
  const free = k.cap - s.player_ids.length;
  return (
    <div className={"card sess " + s.status} style={{ borderLeft: `5px solid ${k.color}` }}>
      <div className="row">
        <div>
          <div className="time">{hhmm(s.start)} <span className="mut">→ {hhmm(end)}</span></div>
          <div className="mut">
            {k.label}{s.recurrence_id && <> · <Icon name="repeat" size={13} /></>}
          </div>
          <Where s={s} />
        </div>
        <span className={"badge " + s.status}>{STATUS[s.status]}</span>
      </div>
      <div className="tags">
        {s.court_status && s.status === "prevue" && <span className={"court-badge " + COURT_STATUS[s.court_status].cls}><Icon name="pin" size={12} /> {COURT_STATUS[s.court_status].label}</span>}
        {s.open && s.status === "prevue" && free > 0 && <span className="court-badge wait"><Icon name="users" size={12} /> {free} place{free > 1 ? "s" : ""} libre{free > 1 ? "s" : ""}</span>}
        {s.level && <span className="court-badge idle">Niveau {s.level}</span>}
        {short && <span className="court-badge wait"><Icon name="clock" size={12} /> En attente de joueurs {s.player_ids.length}/{s.min_players}</span>}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {names.length ? <AvatarStack names={names} /> : <span className="mut">Aucun joueur</span>}
        <div style={{ textAlign: "right" }}>
          <div className="who">{byId ? <PlayerTags ids={s.player_ids} byId={byId} empty="" /> : names.join(", ")}</div>
          {s.price_millimes > 0 && (
            <div className="mut">{tnd(s.price_millimes)}{s.price_mode === "groupe" ? " (total)" : s.kind !== "individuel" ? " / joueur" : ""}</div>
          )}
        </div>
      </div>
      {onPrepare && s.status !== "annulee" && (
        <button className={"prepare" + (s.has_plan ? " done" : "")} onClick={() => onPrepare(s)}>
          <Icon name={s.has_plan ? "checkCircle" : "sparkles"} size={16} />
          <span>{s.has_plan ? "Plan de séance prêt" : "Préparer la séance"}<small>{s.has_plan ? "Voir les exercices" : "Points faibles et exercices"}</small></span>
          <Icon name="chevR" size={16} />
        </button>
      )}
      {canInvite && <button className="small sec" style={{ marginTop: 10, width: "100%" }} onClick={() => setInviting(true)}><Icon name="send" size={15} /> Notifier mes joueurs ({s.max_players - s.player_ids.length} place{s.max_players - s.player_ids.length > 1 ? "s" : ""})</button>}
      {inviting && <InvitePlayers sessionId={s.id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); onChanged?.(); }} />}
      {s.status === "prevue" && onStatus && (
        <div className="actions">
          <button className="small" onClick={() => onStatus(s.id, "effectuee")}><Icon name="check" size={15} /> Effectuée</button>
          <button className="small sec" onClick={() => onStatus(s.id, "annulee")}>Annuler</button>
          {onDuplicate && <button className="small sec iconbtn" title="Copier à la semaine suivante" aria-label="Copier à la semaine suivante" onClick={() => onDuplicate(s)}><Icon name="copy" size={15} /></button>}
        </div>
      )}
    </div>
  );
}
