import { useState } from "react";
import { hhmm, tnd, toDate } from "./api.js";
import InvitePlayers from "./InvitePlayers.jsx";
import MessagePlayers from "./MessagePlayers.jsx";
import Icon from "./Icon.jsx";
import { AvatarStack, COURT_STATUS, KIND, PlayerTags, STATUS, Where } from "./ui.jsx";

export default function SessionCard({ s, name, byId, onStatus, onDuplicate, onPrepare, onChanged }) {
  const [inviting, setInviting] = useState(false);
  const [writing, setWriting] = useState(false); // message aux inscrits (séance incomplète)
  const short = s.status === "prevue" && s.player_ids.length < s.min_players; // pas encore assez de joueurs
  // Séance à deux ou en groupe pas encore pleine: le coach peut la compléter en un clic (joueurs compatibles)
  const upcoming = new Date(s.start.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s.start) ? s.start : s.start + "Z") > new Date();
  // aussi une séance « seul » dont le joueur accepte d'être à deux ou en groupe (max_players > 1)
  const canInvite = s.status === "prevue" && upcoming && s.max_players > s.player_ids.length;
  const names = s.player_ids.map(name);
  const k = KIND[s.kind];
  const end = new Date(new Date(s.start.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s.start) ? s.start : s.start + "Z").getTime() + s.duration_min * 60000).toISOString();
  const free = s.max_players - s.player_ids.length;
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
        {s.open && short && free > 0 && <span className="court-badge wait"><Icon name="users" size={12} /> {free} place{free > 1 ? "s" : ""} libre{free > 1 ? "s" : ""}</span>}
        {s.open && s.status === "prevue" && s.played_min < s.duration_min && <span className="court-badge idle"><Icon name="clock" size={12} /> {s.played_min} min s'il reste {s.player_ids.length > 1 ? "à " + s.player_ids.length : "seul"}</span>}
        {s.level && <span className="court-badge idle">Niveau {s.level}</span>}
        {canInvite && !short && s.player_ids.length > 0 && <span className="court-badge ok"><Icon name="plus" size={12} /> Confirmée · encore {s.max_players - s.player_ids.length} place{s.max_players - s.player_ids.length > 1 ? "s" : ""} à compléter</span>}
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
      {onPrepare && s.status === "prevue" && toDate(s.start).getTime() + s.duration_min * 60000 > Date.now() && ( /* séance passée: plus rien à préparer */
        <button className={"prepare" + (s.has_plan ? " done" : "")} onClick={() => onPrepare(s)}>
          <Icon name={s.has_plan ? "checkCircle" : "sparkles"} size={16} />
          <span>{s.has_plan ? "Plan de séance prêt" : "Préparer la séance"}<small>{s.has_plan ? "Voir les exercices" : "Points faibles et exercices"}</small></span>
          <Icon name="chevR" size={16} />
        </button>
      )}
      {canInvite && (
        <button className={"small" + (short ? "" : " sec")} style={{ marginTop: 10, width: "100%" }} onClick={() => setInviting(true)}>
          <Icon name="users" size={15} /> Compléter la séance · {s.max_players - s.player_ids.length} place{s.max_players - s.player_ids.length > 1 ? "s" : ""} libre{s.max_players - s.player_ids.length > 1 ? "s" : ""}
        </button>
      )}
      {canInvite && s.player_ids.length > 0 && (
        <button className="small sec" style={{ marginTop: 6, width: "100%" }} onClick={() => setWriting(true)}>
          <Icon name="message" size={15} /> Écrire aux inscrits{short ? " (pas assez de joueurs)" : ""}
        </button>
      )}
      {writing && <MessagePlayers sessionId={s.id} onClose={() => setWriting(false)} onDone={() => { setWriting(false); onChanged?.(); }} />}
      {inviting && <InvitePlayers sessionId={s.id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); onChanged?.(); }} />}
      {/* plus de bouton « Effectuée »: la séance passe effectuée toute seule à la fin; une séance passée peut être annulée si elle n'a pas eu lieu */}
      {(s.status === "prevue" || s.status === "effectuee") && onStatus && (
        <div className="actions">
          <button className="small sec" onClick={() => onStatus(s.id, "annulee")}>{s.status === "effectuee" ? "Pas eu lieu ? Annuler" : "Annuler"}</button>
          {onDuplicate && <button className="small sec iconbtn" title="Copier à la semaine suivante" aria-label="Copier à la semaine suivante" onClick={() => onDuplicate(s)}><Icon name="copy" size={15} /></button>}
        </div>
      )}
    </div>
  );
}
