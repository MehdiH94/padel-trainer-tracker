import { useEffect, useState } from "react";
import { api, dayLabel, hhmm } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { COURT_STATUS, Loading } from "./ui.jsx";

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

const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const weekdayOf = (ymd) => (new Date(ymd + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 = lundi
const plusDays = (ymd, n) => new Date(new Date(ymd + "T12:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

// Nombre de terrains que la répétition va créer (aperçu avant d'enregistrer)
function countOccurrences(f) {
  if (f.repeat === "none") return 1;
  let n = 0;
  for (let d = f.date; d <= f.until && n < 400; d = plusDays(d, 1)) if (f.repeat === "daily" || f.weekdays.includes(weekdayOf(d))) n++;
  return n;
}

function ManualForm({ clubs, onDone, onCancel }) {
  const today = new Date().toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const [f, setF] = useState({ club_id: clubs[0]?.id ?? "", date: today, time: "18:00", duration_min: 60, court_label: "", repeat: "none", weekdays: [weekdayOf(today)], until: plusDays(today, 55) });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setDate = (e) => setF({ ...f, date: e.target.value, weekdays: f.repeat === "weekly" && f.weekdays.length > 1 ? f.weekdays : [weekdayOf(e.target.value)], until: f.until < e.target.value ? plusDays(e.target.value, 55) : f.until });
  const toggleDay = (d) => setF({ ...f, weekdays: f.weekdays.includes(d) ? (f.weekdays.length > 1 ? f.weekdays.filter((x) => x !== d) : f.weekdays) : [...f.weekdays, d] });
  const count = countOccurrences(f);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api("/court-bookings/manual", { method: "POST", body: {
        club_id: +f.club_id, start: `${f.date}T${f.time}:00+01:00`, duration_min: +f.duration_min, court_label: f.court_label,
        repeat: f.repeat, weekdays: f.weekdays, until: f.until,
      } });
      toast(r.created ? `${r.created} terrain${r.created > 1 ? "s" : ""} ajouté${r.created > 1 ? "s" : ""}${r.skipped ? ` (${r.skipped} déjà saisi${r.skipped > 1 ? "s" : ""} ou passé${r.skipped > 1 ? "s" : ""})` : ""}` : "Terrain ajouté");
      onDone();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  }
  if (!clubs.length) return <div className="card mut">Ajoutez d'abord un club (Réglages › Mes clubs, ou en bas de cette page).</div>;
  return (
    <form className="card edit-card" onSubmit={save}>
      <div className="row"><b>Ajouter un terrain déjà réservé</b>{onCancel && <button type="button" className="small sec iconbtn" aria-label="Fermer" onClick={onCancel}><Icon name="x" size={15} /></button>}</div>
      <div className="mut small-p" style={{ marginBottom: 8 }}>Il sera proposé aux joueurs et utilisé automatiquement quand une demande tombe sur ce créneau.</div>
      <label className="field"><span className="mut">Club</span><select value={f.club_id} onChange={set("club_id")}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <div className="grid">
        <label className="field"><span className="mut">{f.repeat === "none" ? "Date" : "À partir du"}</span><input type="date" value={f.date} min={today} onChange={setDate} required /></label>
        <label className="field"><span className="mut">Début</span><input type="time" value={f.time} onChange={set("time")} required /></label>
        <label className="field"><span className="mut">Durée</span>
          <select value={f.duration_min} onChange={set("duration_min")}>{[60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`}</option>)}</select>
        </label>
        <label className="field"><span className="mut">Terrain</span><input placeholder="ex. Terrain 2" value={f.court_label} onChange={set("court_label")} /></label>
      </div>
      <div className="field"><span className="mut">Répétition</span>
        <div className="seg">
          {[["none", "Une fois"], ["daily", "Tous les jours"], ["weekly", "Chaque semaine"]].map(([k, l]) => (
            <button type="button" key={k} className={f.repeat === k ? "on" : ""} aria-pressed={f.repeat === k} onClick={() => setF({ ...f, repeat: k, weekdays: k === "weekly" ? [weekdayOf(f.date)] : f.weekdays })}>{l}</button>
          ))}
        </div>
      </div>
      {f.repeat === "weekly" && (
        <div className="field"><span className="mut">Jours</span>
          <div className="chips">{WEEKDAYS.map((d, i) => <button type="button" key={d} className={"chip small" + (f.weekdays.includes(i) ? " on" : "")} aria-pressed={f.weekdays.includes(i)} onClick={() => toggleDay(i)}>{d}</button>)}</div>
        </div>
      )}
      {f.repeat !== "none" && (
        <label className="field"><span className="mut">Jusqu'au (inclus, 6 mois au plus)</span><input type="date" value={f.until} min={f.date} max={plusDays(f.date, 183)} onChange={set("until")} required /></label>
      )}
      {f.repeat !== "none" && <div className="multi-hint"><Icon name="repeat" size={16} /> <span><b>{count} terrain{count > 1 ? "s" : ""}</b> seront ajoutés, de {f.time} pour {f.duration_min} min. Les créneaux déjà saisis sont ignorés.</span></div>}
      {err && <div className="err" role="alert">{err}</div>}
      <button style={{ width: "100%" }} disabled={busy}>{busy ? "Enregistrement…" : f.repeat === "none" ? "Enregistrer le terrain" : `Enregistrer les ${count} terrains`}</button>
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

// Promotion sur un terrain libre: remise, message, envoi à tous les joueurs du coach
function PromoForm({ cb, onClose, onDone }) {
  const [pct, setPct] = useState(20);
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/promotions/preview?court_booking_id=${cb.id}&discount_pct=${pct}`).then((p) => { setPreview(p); setMessage(p.message); }).catch(toastError);
  }, [pct]);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api("/promotions", { method: "POST", body: { court_booking_id: cb.id, discount_pct: pct, message } });
      toast(`Promotion envoyée à ${r.notified_count} joueur${r.notified_count > 1 ? "s" : ""}`);
      onDone();
    } catch (x) {
      toastError(x);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Proposer une promotion">
      <b className="sheet-title">Proposer une promotion</b>
      <p className="mut" style={{ textTransform: "capitalize" }}>{dayLabel(cb.start)} · {hhmm(cb.start)}–{endTime(cb)} · {cb.club_name}</p>
      <div className="field"><span className="mut">Remise sur le prix par joueur</span>
        <div className="chips">{[10, 15, 20, 30, 40, 50].map((v) => <button key={v} type="button" className={"chip" + (pct === v ? " on" : "")} aria-pressed={pct === v} onClick={() => setPct(v)}>−{v} %</button>)}</div>
      </div>
      <label className="field"><span className="mut">Message envoyé aux joueurs</span><textarea className="msg" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
      <div className="mut small-p"><Icon name="send" size={13} /> {preview ? `${preview.recipients} joueur${preview.recipients > 1 ? "s" : ""} prévenu${preview.recipients > 1 ? "s" : ""} par WhatsApp, SMS ou e-mail selon leur choix. La promotion apparaît aussi dans leur appli.` : "…"}</div>
      <div className="actions"><button className="sec" onClick={onClose}>Annuler</button><button disabled={busy || !preview} onClick={send}>{busy ? "Envoi…" : "Envoyer la promotion"}</button></div>
    </Modal>
  );
}

export default function Courts({ onBack }) {
  const [list, setList] = useState(null);
  const [clubs, setClubs] = useState([]);
  const [editing, setEditing] = useState(null); // club, "new" ou null
  const [filter, setFilter] = useState("todo");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null); // terrain d'une série: celui-ci ou toute la suite
  const [msg, setMsg] = useState("");
  const [promos, setPromos] = useState([]);
  const [promoFor, setPromoFor] = useState(null);
  const load = () => {
    api("/court-bookings").then(setList);
    api("/clubs").then(setClubs);
    api("/promotions").then((r) => setPromos(r.items)).catch(() => {});
  };
  const stopPromo = (p) => api(`/promotions/${p.id}`, { method: "DELETE" }).then(() => { toast("Promotion arrêtée"); load(); }).catch(toastError);
  useEffect(load, []);
  if (!list) return <><h1>Terrains</h1><Loading rows={3} /></>;

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
  const doRemove = (cb, series) => api(`/court-bookings/${cb.id}${series ? "?series=true" : ""}`, { method: "DELETE" })
    .then((r) => { setRemoving(null); load(); toast(r.deleted > 1 ? `${r.deleted} terrains supprimés` : "Terrain supprimé"); }).catch(toastError);
  const remove = async (cb) => {
    if (cb.series_id) return setRemoving(cb);
    if (!(await confirmDialog({ title: "Supprimer ce terrain ?", message: "Il ne sera plus proposé pour les réservations.", confirm: "Supprimer", danger: true }))) return;
    doRemove(cb, false);
  };

  return (
    <>
      <button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Planning</button>
      <div className="row" style={{ marginTop: 10 }}>
        <h1 style={{ margin: 0 }}>Terrains</h1>
        <button className="small" onClick={() => { setFilter("free"); setAdding(true); }}><Icon name="plus" size={15} /> Ajouter un terrain</button>
      </div>
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
          {adding && <ManualForm clubs={clubs} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
          {free.length === 0 && !adding && <div className="card mut">Aucun terrain libre.</div>}
          {free.map((cb) => {
            const promo = promos.find((p) => p.court_booking_id === cb.id && p.active);
            return (
              <div className="card" key={cb.id}>
                <div className="row">
                  <div>
                    <b style={{ textTransform: "capitalize" }}>{dayLabel(cb.start)} · {hhmm(cb.start)}–{endTime(cb)}</b>
                    <div className="mut">{cb.club_name}{cb.court_label && ` · ${cb.court_label}`}{cb.series_id && <> · <Icon name="repeat" size={12} /> régulier</>}</div>
                  </div>
                  <button className="small sec iconbtn" title="Supprimer" aria-label="Supprimer" onClick={() => remove(cb)}><Icon name="trash" size={15} /></button>
                </div>
                {promo ? (
                  <div className="promo-on">
                    <span className="promo-tag">−{promo.discount_pct} %</span>
                    <span>Promotion en cours · {promo.notified_count} joueur{promo.notified_count > 1 ? "s" : ""} prévenu{promo.notified_count > 1 ? "s" : ""}</span>
                    <button className="small sec" onClick={() => stopPromo(promo)}>Arrêter</button>
                  </div>
                ) : (
                  <button className="small sec" style={{ marginTop: 10 }} onClick={() => setPromoFor(cb)}><Icon name="sparkles" size={15} /> Proposer une promotion</button>
                )}
              </div>
            );
          })}
          {promoFor && <PromoForm cb={promoFor} onClose={() => setPromoFor(null)} onDone={() => { setPromoFor(null); load(); }} />}
          {!adding && <button className="small" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Ajouter un terrain déjà réservé (une fois ou régulièrement)</button>}
          {removing && (
            <Modal onClose={() => setRemoving(null)} label="Supprimer un terrain d'une série">
              <b className="sheet-title">Supprimer ce terrain ?</b>
              <p className="mut">Il fait partie d'une série (terrain réservé régulièrement). Les terrains déjà utilisés par une séance ne sont jamais supprimés.</p>
              <div className="actions" style={{ flexDirection: "column" }}>
                <button className="sec" onClick={() => doRemove(removing, false)}>Seulement celui-ci</button>
                <button className="danger-solid" onClick={() => doRemove(removing, true)}>Celui-ci et tous les suivants</button>
                <button className="link center" onClick={() => setRemoving(null)}>Annuler</button>
              </div>
            </Modal>
          )}
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
