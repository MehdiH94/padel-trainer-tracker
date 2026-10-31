import { useEffect, useState } from "react";
import { api, dayLabel, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import { COURT_STATUS } from "./ui.jsx";

const PLACEHOLDERS = "{date} {debut} {fin} {duree} {joueurs} {coach} {club}";
const toDate = (iso) => new Date(iso + (iso.endsWith("Z") || /[+-]\d\d:\d\d$/.test(iso) ? "" : "Z"));
const endTime = (cb) => hhmm(new Date(toDate(cb.start).getTime() + cb.duration_min * 60000).toISOString());

function ClubForm({ club, onDone }) {
  const [f, setF] = useState(club ?? { name: "", phone: "", sms_template: "", auto_send: true });
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    try {
      await api(club ? `/clubs/${club.id}` : "/clubs", { method: club ? "PUT" : "POST", body: f });
      onDone();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <form className="card" onSubmit={save}>
      <label className="field"><span className="mut">Nom du club</span><input value={f.name} onChange={set("name")} required /></label>
      <label className="field"><span className="mut">Téléphone du club (reçoit le SMS)</span><input inputMode="tel" placeholder="71 123 456" value={f.phone} onChange={set("phone")} /></label>
      <label className="field"><span className="mut">Modèle de message (vide = modèle par défaut)</span>
        <textarea className="msg" rows={4} value={f.sms_template} onChange={set("sms_template")} placeholder={club?.default_template ?? "Bonjour, je souhaiterais réserver un terrain le {date} de {debut} à {fin}…"} />
      </label>
      <div className="mut" style={{ marginTop: -4, marginBottom: 8 }}>Variables : {PLACEHOLDERS}</div>
      <label className="check"><input type="checkbox" checked={f.auto_send} onChange={(e) => setF({ ...f, auto_send: e.target.checked })} />Envoyer le SMS automatiquement à la création d'une séance</label>
      {err && <div className="err">{err}</div>}
      <button style={{ width: "100%" }}>{club ? "Enregistrer" : "Ajouter le club"}</button>
    </form>
  );
}

function ManualForm({ clubs, onDone }) {
  const today = new Date().toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const [f, setF] = useState({ club_id: clubs[0]?.id ?? "", date: today, time: "18:00", duration_min: 60, court_label: "" });
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    try {
      await api("/court-bookings/manual", { method: "POST", body: { club_id: +f.club_id, start: `${f.date}T${f.time}:00+01:00`, duration_min: +f.duration_min, court_label: f.court_label } });
      onDone();
    } catch (x) {
      setErr(x.message);
    }
  }
  if (!clubs.length) return <div className="card mut">Ajoutez d'abord un club (en bas de cette page).</div>;
  return (
    <form className="card" onSubmit={save}>
      <b>Saisir un terrain déjà réservé</b>
      <div className="mut" style={{ marginBottom: 8 }}>Il sera proposé automatiquement quand une demande tombe sur ce créneau.</div>
      <label className="field"><span className="mut">Club</span><select value={f.club_id} onChange={set("club_id")}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <div className="grid">
        <label className="field"><span className="mut">Date</span><input type="date" value={f.date} onChange={set("date")} required /></label>
        <label className="field"><span className="mut">Début</span><input type="time" value={f.time} onChange={set("time")} required /></label>
        <label className="field"><span className="mut">Durée</span>
          <select value={f.duration_min} onChange={set("duration_min")}>{[60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m / 60} h</option>)}</select>
        </label>
        <label className="field"><span className="mut">Terrain</span><input placeholder="ex. Terrain 2" value={f.court_label} onChange={set("court_label")} /></label>
      </div>
      {err && <div className="err">{err}</div>}
      <button style={{ width: "100%" }}>Enregistrer le terrain</button>
    </form>
  );
}

function CourtCard({ cb, reload }) {
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const st = COURT_STATUS[cb.status];
  const manual = cb.source === "manuel";
  const act = (path, body) => api(`/court-bookings/${cb.id}/${path}`, { method: "POST", body }).then(reload).catch((x) => setNote(x.message));
  async function sendReply() {
    const r = await api(`/court-bookings/${cb.id}/reply`, { method: "POST", body: { text: reply } });
    setNote(r.understood ? `Réponse comprise : ${r.status === "confirmee" ? "terrain confirmé" : "terrain refusé"}` : "Réponse pas claire : choisissez le statut à la main.");
    setReply("");
    reload();
  }
  return (
    <div className="card">
      <div className="row">
        <div>
          <b style={{ textTransform: "capitalize" }}>{dayLabel(cb.start)} · {hhmm(cb.start)}–{endTime(cb)}</b>
          <div className="mut">{cb.club_name}{cb.court_label && ` · ${cb.court_label}`} · {cb.players.join(", ") || "sans joueur"}</div>
        </div>
        <span className={"court-badge " + st.cls}>{manual ? "Réservé à la main" : st.label}</span>
      </div>
      {cb.reply && <div className="reply"><Icon name="message" size={14} /> « {cb.reply} »</div>}
      {!manual && (
        <>
          <div className="actions">
            {cb.status === "a_envoyer" && <button className="small" onClick={() => act("send")}><Icon name="send" size={14} /> Envoyer le SMS</button>}
            {cb.status === "en_attente" && <button className="small sec" onClick={() => act("send")}><Icon name="repeat" size={14} /> Renvoyer</button>}
            {cb.status !== "confirmee" && <button className="small sec" onClick={() => act("status", { status: "confirmee" })}><Icon name="check" size={14} /> Confirmé</button>}
            {cb.status !== "refusee" && <button className="small sec danger" onClick={() => act("status", { status: "refusee" })}><Icon name="x" size={14} /> Refusé</button>}
          </div>
          <button className="link" onClick={() => setOpen(!open)}>{open ? "Masquer" : "Message & réponse du club"}</button>
          {open && (
            <div className="editor">
              <div className="mut">Message {cb.sent_at ? "envoyé" : "qui sera envoyé"} à {cb.club_phone || "(pas de numéro)"}</div>
              <div className="linkbox">{cb.message}</div>
              {cb.club_phone && <a className="btnlink" style={{ display: "flex", marginBottom: 8 }} href={`sms:${cb.club_phone}?body=${encodeURIComponent(cb.message)}`}><Icon name="phone" size={15} /> L'envoyer depuis mon téléphone</a>}
              <textarea className="msg" rows={2} placeholder="Collez ici la réponse reçue du club…" value={reply} onChange={(e) => setReply(e.target.value)} />
              <button className="small" disabled={!reply.trim()} onClick={sendReply}>Analyser la réponse</button>
            </div>
          )}
        </>
      )}
      {note && <div className="mut" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}

export default function Courts() {
  const [list, setList] = useState(null);
  const [clubs, setClubs] = useState([]);
  const [editing, setEditing] = useState(null); // club, "new" ou null
  const [filter, setFilter] = useState("todo");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => {
    api("/court-bookings").then(setList);
    api("/clubs").then(setClubs);
  };
  useEffect(load, []);
  if (!list) return null;

  const now = Date.now();
  const upcoming = list.filter((cb) => toDate(cb.start).getTime() + cb.duration_min * 60000 >= now);
  const attached = upcoming.filter((cb) => !cb.free);
  const free = upcoming.filter((cb) => cb.free);
  const count = (s) => attached.filter((cb) => s.includes(cb.status)).length;
  const shown = attached.filter((cb) => (filter === "todo" ? ["a_envoyer", "en_attente", "refusee"].includes(cb.status) : filter === "ok" ? cb.status === "confirmee" : true));
  const sendDue = async () => {
    const r = await api("/court-bookings/send-due", { method: "POST" });
    setMsg(r.sent ? `${r.sent} SMS envoyé${r.sent > 1 ? "s" : ""}` : "Rien à envoyer pour le moment (les demandes partent 7 jours avant la séance).");
    load();
  };
  const remove = (cb) => api(`/court-bookings/${cb.id}`, { method: "DELETE" }).then(load);

  return (
    <>
      <h1>Terrains</h1>
      <div className="grid kpis">
        <div className="kpi"><span className="ico ok"><Icon name="checkCircle" size={18} /></span><div className="big">{count(["confirmee"])}</div><div className="mut">Confirmés</div></div>
        <div className="kpi"><span className="ico warn"><Icon name="clock" size={18} /></span><div className="big">{count(["a_envoyer", "en_attente"])}</div><div className="mut">En attente</div></div>
      </div>
      {count(["refusee"]) > 0 && (
        <button className="alert red" onClick={() => setFilter("todo")}>
          <span className="alert-ico"><Icon name="alert" size={20} /></span>
          <span className="alert-txt"><b>{count(["refusee"])} terrain{count(["refusee"]) > 1 ? "s" : ""} refusé{count(["refusee"]) > 1 ? "s" : ""}</b><small>Trouvez une alternative</small></span>
          <Icon name="chevR" size={20} />
        </button>
      )}

      <div className="seg" style={{ margin: "10px 0" }}>
        {[["todo", "À suivre"], ["ok", "Confirmés"], ["free", `Libres (${free.length})`], ["all", "Tous"]].map(([k, l]) => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>)}
      </div>

      {filter === "free" ? (
        <>
          <p className="mut">Terrains réservés par vos soins, pas encore attribués à une séance.</p>
          {free.length === 0 && !adding && <div className="card mut">Aucun terrain libre.</div>}
          {free.map((cb) => (
            <div className="card row" key={cb.id}>
              <div>
                <b style={{ textTransform: "capitalize" }}>{dayLabel(cb.start)} · {hhmm(cb.start)}–{endTime(cb)}</b>
                <div className="mut">{cb.club_name}{cb.court_label && ` · ${cb.court_label}`}</div>
              </div>
              <button className="small sec iconbtn" title="Supprimer" onClick={() => remove(cb)}><Icon name="trash" size={15} /></button>
            </div>
          ))}
          {adding ? <ManualForm clubs={clubs} onDone={() => { setAdding(false); load(); }} /> : <button className="small" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Saisir un terrain réservé</button>}
        </>
      ) : (
        <>
          {shown.length === 0 && <div className="card mut">Aucune demande de terrain dans cette liste.</div>}
          {shown.map((cb) => <CourtCard key={cb.id} cb={cb} reload={load} />)}
          <button className="small sec" onClick={sendDue}><Icon name="send" size={14} /> Envoyer les demandes dues</button>
          {msg && <div className="mut" style={{ marginTop: 6 }}>{msg}</div>}
        </>
      )}

      <h2>Mes clubs</h2>
      {clubs.map((c) => (
        editing?.id === c.id ? <ClubForm key={c.id} club={c} onDone={() => { setEditing(null); load(); }} /> : (
          <div className="card row" key={c.id}>
            <div><b><Icon name="pin" size={15} /> {c.name}</b><div className="mut">{c.phone || "Pas de numéro"} · {c.sms_template ? "modèle perso" : "modèle par défaut"}{!c.auto_send && " · envoi manuel"}</div></div>
            <button className="small sec" onClick={() => setEditing(c)}>Modifier</button>
          </div>
        )
      ))}
      {editing === "new" ? <ClubForm onDone={() => { setEditing(null); load(); }} /> : <button className="small" onClick={() => setEditing("new")}><Icon name="plus" size={15} /> Ajouter un club</button>}
    </>
  );
}
