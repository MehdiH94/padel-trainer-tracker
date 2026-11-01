import { hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { AvatarStack, COURT_STATUS, KIND, STATUS } from "./ui.jsx";

export default function SessionCard({ s, name, onStatus, onDuplicate }) {
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
            {k.label}{s.club && ` · ${s.club}`}{s.recurrence_id && <> · <Icon name="repeat" size={13} /></>}
          </div>
        </div>
        <span className={"badge " + s.status}>{STATUS[s.status]}</span>
      </div>
      <div className="tags">
        {s.court_status && s.status === "prevue" && <span className={"court-badge " + COURT_STATUS[s.court_status].cls}><Icon name="pin" size={12} /> {COURT_STATUS[s.court_status].label}</span>}
        {s.open && s.status === "prevue" && free > 0 && <span className="court-badge wait"><Icon name="users" size={12} /> {free} place{free > 1 ? "s" : ""} libre{free > 1 ? "s" : ""}</span>}
        {s.level && <span className="court-badge idle">Niveau {s.level}</span>}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {names.length ? <AvatarStack names={names} /> : <span className="mut">Aucun joueur</span>}
        <div style={{ textAlign: "right" }}>
          <div className="who">{names.join(", ")}</div>
          {s.price_millimes > 0 && (
            <div className="mut">{tnd(s.price_millimes)}{s.price_mode === "groupe" ? " (total)" : s.kind !== "individuel" ? " / joueur" : ""}</div>
          )}
        </div>
      </div>
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
