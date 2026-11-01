import { useEffect, useState } from "react";
import { api, tnd, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import { Avatar, ago, ContactLinks, Loading } from "./ui.jsx";

const KINDS = {
  impaye: ["alert", "Impayés"],
  seance: ["ball", "Séances demain"],
  invitation: ["link", "Invitations"],
  credits: ["card", "Crédits bas"],
};

export default function Reminders({ openPlayer }) {
  const [items, setItems] = useState(null);
  const [kind, setKind] = useState("all");
  const [edits, setEdits] = useState({});
  const load = () => api("/reminders?base=" + encodeURIComponent(location.origin)).then(setItems);
  useEffect(() => { load(); }, []);
  if (!items) return <><h1>Relances</h1><Loading rows={3} /></>;

  const counts = Object.fromEntries(Object.keys(KINDS).map((k) => [k, items.filter((i) => i.kind === k).length]));
  const shown = items.filter((i) => kind === "all" || i.kind === kind);
  const sent = (i, channel) => api("/reminders/log", { method: "POST", body: { player_id: i.player_id, kind: i.kind, channel } }).then(load);

  return (
    <>
      <h1>Relances</h1>
      <p className="mut" style={{ marginTop: -6 }}>Touchez un bouton : l'application SMS, WhatsApp ou e-mail s'ouvre avec le message déjà écrit. Il ne reste qu'à envoyer.</p>

      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={"chip" + (kind === "all" ? " on" : "")} onClick={() => setKind("all")}>Tout ({items.length})</button>
        {Object.entries(KINDS).map(([k, [icon, label]]) => (
          <button key={k} className={"chip" + (kind === k ? " on" : "")} onClick={() => setKind(k)}><Icon name={icon} size={14} /> {label} ({counts[k]})</button>
        ))}
      </div>

      {shown.length === 0 && <div className="card empty"><Icon name="checkCircle" size={34} /><b>Rien à relancer</b></div>}
      {shown.map((i) => {
        const text = edits[i.key] ?? i.message;
        return (
          <div className="card" key={i.key}>
            <div className="row">
              <div className="row g10" style={{ cursor: "pointer" }} onClick={() => openPlayer(i.player_id)}>
                <Avatar name={i.name} size={38} />
                <div>
                  <b>{i.name}</b>
                  <div className="mut"><Icon name={KINDS[i.kind][0]} size={13} /> {KINDS[i.kind][1]}{i.amount_millimes ? ` · ${tnd(i.amount_millimes)}` : ""}{i.start ? ` · ${hhmm(i.start)}` : ""}</div>
                </div>
              </div>
              {i.last_sent && <span className="chip-state ok-sent"><Icon name="check" size={12} /> {i.last_sent.channel} {ago(i.last_sent.sent_at)}</span>}
            </div>
            <textarea className="msg" rows={3} value={text} onChange={(e) => setEdits({ ...edits, [i.key]: e.target.value })} />
            <ContactLinks phone={i.phone} email={i.email} message={text} subject={i.subject} onSent={(ch) => sent(i, ch)} />
          </div>
        );
      })}
    </>
  );
}
