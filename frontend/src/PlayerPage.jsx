import { useEffect, useState } from "react";
import { api, dayLabel, hhmm, shortDate, tnd } from "./api.js";
import FeedbackEditor from "./FeedbackEditor.jsx";
import Icon from "./Icon.jsx";
import { Avatar, CATEGORIES, CategoryBadge, CHANNELS, ContactLinks, KIND, Progress, RadarChart } from "./ui.jsx";

function Dots({ score, onPick }) {
  return (
    <span className="dots5">
      {[1, 2, 3, 4, 5].map((n) => <i key={n} className={n <= (score ?? 0) ? "on lvl" + score : ""} onClick={() => onPick(n)} />)}
    </span>
  );
}

function Trend({ score, previous }) {
  if (score == null || previous == null || score === previous) return null;
  return <span className={score > previous ? "up" : "down"}>{score > previous ? "▲" : "▼"}</span>;
}

function InviteCard({ player }) {
  const [url, setUrl] = useState(null);
  const gen = async () => setUrl(location.origin + (await api(`/players/${player.id}/invite`, { method: "POST" })).path);
  const msg = url && `Bonjour ${player.name.split(" ")[0]}, créez votre compte pour réserver vos séances et suivre votre progression : ${url}`;
  return (
    <div className="card">
      <b><Icon name="link" size={16} /> Compte joueur</b>
      <div className="mut">Pas encore de compte. Envoyez-lui le lien pour qu'il réserve avec ses crédits.</div>
      {!url ? <button className="small" style={{ marginTop: 8 }} onClick={gen}>Générer le lien d'invitation</button>
        : <ContactLinks phone={player.phone} email={player.email} message={msg} subject="Votre compte Padel Coach" onSent={(ch) => api("/reminders/log", { method: "POST", body: { player_id: player.id, kind: "invitation", channel: ch } })} />}
    </div>
  );
}

function EditForm({ player, onSave, onCancel }) {
  const [f, setF] = useState({
    name: player.name, phone: player.phone, email: player.email ?? "", gender: player.gender, category: player.category,
    dominant_hand: player.dominant_hand, side: player.side, goals: player.goals, notes: player.notes,
    contact_channel: player.contact_channel ?? "",
  });
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    try {
      await onSave({ ...f, email: player.has_account ? player.email : f.email || null, contact_channel: f.contact_channel || null });
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <form className="card edit-card" onSubmit={submit}>
      <b>Modifier la fiche</b>
      <label className="field"><span className="mut">Nom complet</span><input value={f.name} onChange={set("name")} required /></label>
      <div className="grid">
        <label className="field"><span className="mut">Téléphone</span><input inputMode="tel" value={f.phone} onChange={set("phone")} required /></label>
        <label className="field"><span className="mut">E-mail{player.has_account && " (compte actif)"}</span><input type="email" value={f.email} onChange={set("email")} disabled={player.has_account} /></label>
        <label className="field"><span className="mut">Genre</span><select value={f.gender} onChange={set("gender")}><option value="M">Homme</option><option value="F">Dame</option></select></label>
        <label className="field"><span className="mut">Classement</span><select value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label className="field"><span className="mut">Main forte</span><select value={f.dominant_hand} onChange={set("dominant_hand")}><option value="droitier">Droitier</option><option value="gaucher">Gaucher</option></select></label>
        <label className="field"><span className="mut">Rappels de séance</span><select value={f.contact_channel} onChange={set("contact_channel")}><option value="">Non choisi (SMS)</option>{Object.entries(CHANNELS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field"><span className="mut">Côté de jeu</span><select value={f.side} onChange={set("side")}><option value="drive">Drive</option><option value="revers">Revers</option></select></label>
      </div>
      <label className="field"><span className="mut">Objectifs</span><input value={f.goals} onChange={set("goals")} placeholder="ex. préparer un tournoi de club" /></label>
      <label className="field"><span className="mut">Notes du coach (privées)</span><textarea className="msg" rows={3} value={f.notes} onChange={set("notes")} placeholder="blessures, disponibilités, caractère…" /></label>
      {err && <div className="err">{err}</div>}
      <div className="actions"><button>Enregistrer</button><button type="button" className="sec" onClick={onCancel}>Annuler</button></div>
    </form>
  );
}

export default function PlayerPage({ id, onBack }) {
  const [p, setP] = useState(null);
  const [strokes, setStrokes] = useState([]);
  const [tab, setTab] = useState("padel");
  const [edit, setEdit] = useState(null);
  const [editing, setEditing] = useState(false);
  const [pay, setPay] = useState({ amount: "", method: "especes" });
  const [cr, setCr] = useState({ amount: "", method: "especes" });
  const load = () => api(`/players/${id}/profile`).then(setP);
  useEffect(() => { load(); api("/strokes").then(setStrokes); }, [id]);
  if (!p) return null;
  const { player, finance: fin, stats, skills, strengths, weaknesses, last_session: last } = p;
  const rate = (stroke, score) => api(`/players/${id}/skills`, { method: "POST", body: { stroke, score } }).then(load);
  const encaisser = async (e) => {
    e.preventDefault();
    await api("/payments", { method: "POST", body: { player_id: id, amount_millimes: Math.round(pay.amount * 1000), method: pay.method } });
    setPay({ ...pay, amount: "" });
    load();
  };
  const recharger = async (e) => {
    e.preventDefault();
    await api(`/players/${id}/credits`, { method: "POST", body: { amount_millimes: Math.round(cr.amount * 1000), method: cr.method } });
    setCr({ ...cr, amount: "" });
    load();
  };
  const ratedCount = skills.filter((s) => s.score != null).length;
  const avg = ratedCount ? (skills.reduce((a, s) => a + (s.score ?? 0), 0) / ratedCount).toFixed(1) : "–";

  return (
    <>
      <button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Joueurs</button>
      <div className="pp-head">
        <Avatar name={player.name} size={68} />
        <div>
          <h1 style={{ margin: 0 }}>{player.name}</h1>
          <CategoryBadge category={player.category} gender={player.gender} />{" "}
          <span className="mut">{player.dominant_hand} · {player.side}</span>
        </div>
      </div>
      {editing ? (
        <EditForm player={player} onCancel={() => setEditing(false)} onSave={async (body) => { await api(`/players/${id}`, { method: "PUT", body: { ...body, pref_kinds: player.pref_kinds } }); setEditing(false); load(); }} />
      ) : (
        <button className="sec" style={{ width: "100%", marginBottom: 8 }} onClick={() => setEditing(true)}><Icon name="edit" size={16} /> Modifier la fiche</button>
      )}
      <div className="actions">
        <a className="btnlink" href={`tel:${player.phone}`}><Icon name="phone" size={16} /> Appeler</a>
        <a className="btnlink" href={`sms:${player.phone}`}><Icon name="message" size={16} /> SMS</a>
        <a className="btnlink wa" href={`https://wa.me/${player.phone.replace("+", "")}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={16} /> WhatsApp</a>
      </div>

      {!player.has_account && <InviteCard player={player} />}
      <div className="grid kpis" style={{ marginTop: 12 }}>
        <div className="kpi"><div className="big">{stats.done_count}</div><div className="mut">Séances effectuées</div></div>
        <div className="kpi"><div className="big">{stats.hours} h</div><div className="mut">Heures ensemble{stats.since && ` depuis ${shortDate(stats.since)}`}</div></div>
      </div>

      <div className="seg" style={{ marginBottom: 12 }}>
        {[["padel", "Padel"], ["fin", "Finances"], ["hist", "Historique"]].map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === "padel" && (
        <>
          {player.goals && <div className="card"><div className="mut"><Icon name="target" size={14} /> Objectif</div><b>{player.goals}</b></div>}
          {player.notes && <div className="card"><div className="mut"><Icon name="edit" size={14} /> Notes du coach</div>{player.notes}</div>}

          <div className="card">
            <div className="mut">Dernière séance travaillée</div>
            {last ? (
              <>
                <b style={{ textTransform: "capitalize" }}>{dayLabel(last.start)}</b>
                <div className="chips" style={{ margin: "8px 0" }}>{last.worked_on.map((t) => <span key={t} className="chip on small static">{t}</span>)}</div>
                {last.note && <div>{last.note}</div>}
                {last.to_improve && <div className="red">À retravailler : {last.to_improve}</div>}
              </>
            ) : <div className="mut">Pas encore de retour saisi. Ajoutez-en un depuis l'onglet Historique.</div>}
          </div>

          <div className="grid">
            <div className="card good"><b><Icon name="trophy" size={15} /> Points forts</b>
              {strengths.length ? strengths.map((s) => <div key={s}>• {s}</div>) : <div className="mut">À évaluer</div>}
            </div>
            <div className="card bad"><b><Icon name="target" size={15} /> À améliorer</b>
              {weaknesses.length ? weaknesses.map((s) => <div key={s}>• {s}</div>) : <div className="mut">Rien de critique</div>}
              {last?.to_improve && <div>• {last.to_improve}</div>}
            </div>
          </div>

          <div className="card">
            <div className="row"><b>Évaluation technique</b><span className="mut">Moyenne {avg}/5</span></div>
            {ratedCount > 0 ? <RadarChart skills={skills} /> : <div className="mut">Notez les coups ci-dessous pour voir le graphique.</div>}
            <div className="legend" style={{ justifyContent: "center" }}><span><i style={{ background: "#f97316" }} />Niveau actuel</span><span><i style={{ background: "#94a3b8" }} />Évaluation précédente</span></div>
            <div className="mut" style={{ margin: "6px 0" }}>Touchez les points pour noter de 1 à 5</div>
            {skills.map((s) => (
              <div className="row skill" key={s.stroke}>
                <span>{s.stroke}</span>
                <span><Trend score={s.score} previous={s.previous} /> <Dots score={s.score} onPick={(n) => rate(s.stroke, n)} /></span>
              </div>
            ))}
          </div>
          {stats.upcoming_count > 0 && (
            <div className="card"><b>Prochaines séances</b>
              {p.upcoming.map((u) => <div key={u.session_id} className="mut" style={{ textTransform: "capitalize" }}>{dayLabel(u.start)} · {hhmm(u.start)}</div>)}
            </div>
          )}
        </>
      )}

      {tab === "fin" && (
        <>
          <div className="grid kpis">
            <div className="kpi"><div className="mut">Facturé</div><div className="big sm">{tnd(fin.billed_millimes)}</div></div>
            <div className="kpi"><div className="mut">Payé</div><div className="big sm" style={{ color: "var(--brand)" }}>{tnd(fin.paid_millimes)}</div></div>
          </div>
          <div className={"card " + (fin.due_millimes > 0 ? "bad" : "good")}>
            <div className="row">
              <div>
                <div className="mut">{fin.due_millimes > 0 ? "Reste à payer" : fin.credit_millimes > 0 ? "Crédit" : "À jour"}</div>
                <div className="big">{fin.due_millimes > 0 ? tnd(fin.due_millimes) : fin.credit_millimes > 0 ? tnd(fin.credit_millimes) : <Icon name="checkCircle" size={30} />}</div>
              </div>
            </div>
            {fin.billed_millimes > 0 && <Progress value={Math.min(fin.paid_millimes, fin.billed_millimes)} max={fin.billed_millimes} />}
            {fin.due_millimes > 0 && (
              <ContactLinks phone={player.phone} email={player.email} subject="Rappel de paiement"
                message={`Bonjour ${player.name.split(" ")[0]}, petit rappel : il reste ${tnd(fin.due_millimes)} à régler pour vos séances de padel. Merci !`}
                onSent={(ch) => api("/reminders/log", { method: "POST", body: { player_id: id, kind: "impaye", channel: ch } })} />
            )}
          </div>
          <form className="card" onSubmit={recharger}>
            <div className="row"><b><Icon name="card" size={16} /> Crédits prépayés</b><b>{tnd(fin.credits_balance_millimes)}</b></div>
            <div className="mut">{player.has_account ? "Le joueur réserve ses séances avec ce solde." : "Utilisables dès que le joueur aura créé son compte."}</div>
            <div className="grid" style={{ marginTop: 8 }}>
              <input type="number" step="0.001" placeholder="Montant TND" value={cr.amount} onChange={(e) => setCr({ ...cr, amount: e.target.value })} required />
              <select value={cr.method} onChange={(e) => setCr({ ...cr, method: e.target.value })}><option value="especes">Espèces</option><option value="virement">Virement</option></select>
            </div>
            <button className="sec" style={{ width: "100%" }}>Recharger les crédits</button>
          </form>
          <form className="card" onSubmit={encaisser}>
            <b>Encaisser un paiement de séance</b>
            <div className="grid" style={{ marginTop: 8 }}>
              <input type="number" step="0.001" placeholder="Montant TND" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} required />
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="especes">Espèces</option><option value="virement">Virement</option></select>
            </div>
            <button style={{ width: "100%" }}>Enregistrer</button>
          </form>
          <h2>Paiements reçus</h2>
          {fin.payments.length === 0 && <div className="card mut">Aucun paiement.</div>}
          {fin.payments.map((x) => (
            <div className="card row" key={x.id}><span>{shortDate(x.paid_at)} · {x.method}{x.kind === "credit" && " · recharge"}</span><b>{tnd(x.amount_millimes)}</b></div>
          ))}
        </>
      )}

      {tab === "hist" && p.history.map((h) => (
        <div className="card" key={h.session_id} style={{ borderLeft: `5px solid ${KIND[h.kind]?.color}`, cursor: h.status === "effectuee" ? "pointer" : "default" }}
          onClick={() => h.status === "effectuee" && setEdit(edit === h.session_id ? null : h.session_id)}>
          <div className="row">
            <b style={{ textTransform: "capitalize" }}>{shortDate(h.start)} · {hhmm(h.start)}</b>
            <span className={"badge " + h.status}>{h.status === "effectuee" ? (h.prepaid ? "Crédits" : tnd(h.share_millimes)) : h.status}</span>
          </div>
          <div className="mut">{KIND[h.kind]?.label}{h.club && ` · ${h.club}`}</div>
          {h.worked_on.length > 0 && <div className="chips" style={{ marginTop: 6 }}>{h.worked_on.map((t) => <span key={t} className="chip on small static">{t}</span>)}</div>}
          {h.note && <div style={{ marginTop: 4 }}>{h.note}</div>}
          {h.status === "effectuee" && !h.worked_on.length && !h.note && <div className="mut"><Icon name="edit" size={13} /> Touchez pour ajouter un retour</div>}
          {edit === h.session_id && <FeedbackEditor h={h} playerId={id} strokes={strokes} onSaved={() => { setEdit(null); load(); }} />}
        </div>
      ))}
    </>
  );
}
