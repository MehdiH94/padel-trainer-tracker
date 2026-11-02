import { useEffect, useState } from "react";
import { api, dayLabel, hhmm, tnd, toDate, useLive } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog } from "./feedback.jsx";
import InvitePlayers from "./InvitePlayers.jsx";
import { Avatar, CategoryBadge, ContactLinks, KIND, Loading, PlayerTag } from "./ui.jsx";

const hm = (iso, min) => `${hhmm(iso)} – ${hhmm(new Date(toDate(iso).getTime() + min * 60000).toISOString())}`;

function Head({ r }) {
  const k = KIND[r.kind];
  return (
    <>
      <div className="row">
        <div className="row g10">
          <Avatar name={r.name} size={42} />
          <div>
            <b>{r.name}</b>
            <div className="mut"><CategoryBadge category={r.category} gender={r.gender} /></div>
          </div>
        </div>
        <span className="kind-pill" style={{ background: k.color + "1a", color: k.color }}><Icon name={k.icon} size={14} /> {k.label}</span>
      </div>
      <div className="when">
        <Icon name="calendar" size={16} /> <b style={{ textTransform: "capitalize" }}>{dayLabel(r.start)}</b>
        <span className="sep" /> <Icon name="clock" size={16} /> {hm(r.start, r.duration_min)}
        <span className="sep" /> <Icon name="wallet" size={16} /> {tnd(r.price_millimes ?? r.charged_millimes)}
        {r.price_millimes < r.base_millimes && <span className="promo-tag">−{Math.round(100 - (r.price_millimes * 100) / r.base_millimes)} %</span>}
        <span className="mut small-p">{r.charged_millimes ? "débité des crédits" : "débité des crédits à la validation"}</span>
      </div>
      {!r.join && (
        <div className="accepts" aria-label="Formules acceptées par le joueur">
          <span className="mut small-p">Formules acceptées :</span>
          {Object.keys(KIND).map((k) => {
            const ok = r.accepted_kinds?.includes(k);
            return <span key={k} className={"kind-pill" + (ok ? "" : " refused")} style={ok ? { background: KIND[k].color + "1a", color: KIND[k].color } : undefined}><Icon name={ok ? "check" : "x"} size={13} /> {KIND[k].label}</span>;
          })}
        </div>
      )}
      {!r.join && (
        <div className="limit-note">
          <Icon name="users" size={15} />
          <span>
            {r.max_players === 1 ? <><b>Seul uniquement</b> : personne d'autre ne pourra rejoindre.</>
              : r.min_players === r.max_players ? <><b>Exactement {r.max_players} joueurs</b>{r.min_players > 1 && " : la séance attendra un partenaire avant d'être confirmée"}.</>
              : <><b>De {r.min_players} à {r.max_players} joueurs</b>{r.min_players > 1 ? ` : confirmée dès ${r.min_players} joueurs, ouverte aux autres jusqu'à ${r.max_players}` : ` : les places libres seront proposées jusqu'à ${r.max_players}`}.</>}
          </span>
        </div>
      )}
      {r.join && <div className="mut">Rejoint une séance existante{r.partners.length ? ` avec ${r.partners.join(", ")}` : ""}</div>}
    </>
  );
}

function Pending({ r, clubs, reload }) {
  const [clubId, setClubId] = useState(clubs.find((c) => c.phone)?.id ?? "");
  const [courtId, setCourtId] = useState(r.courts_available?.[0]?.id ?? "");
  const [err, setErr] = useState("");
  const act = (path, body) => api(`/booking/requests/${r.id}/${path}`, { method: "POST", body }).then(reload).catch((x) => setErr(x.message));
  const hasCourt = (r.courts_available ?? []).length > 0;
  return (
    <div className="card req">
      <Head r={r} />
      {r.join ? (
        <div className={"banner " + (r.court_state === "confirmee" || r.court_state === null ? "ok" : "warn")}>
          <Icon name={r.court_state === "confirmee" || r.court_state === null ? "checkCircle" : "clock"} size={18} />
          <span>{r.court_state === "confirmee" ? `Terrain déjà confirmé (${r.club})` : r.court_state === null ? "Séance déjà organisée" : "Terrain de cette séance en attente de confirmation"}</span>
        </div>
      ) : hasCourt ? (
        <div className="banner ok">
          <Icon name="checkCircle" size={18} />
          <div style={{ flex: 1 }}>
            <b>Terrain disponible</b>
            {r.courts_available.length > 1 ? (
              <select value={courtId} onChange={(e) => setCourtId(+e.target.value)}>
                {r.courts_available.map((c) => <option key={c.id} value={c.id}>{c.club_name} {c.court_label && `· ${c.court_label}`} · {hm(c.start, c.duration_min)}</option>)}
              </select>
            ) : <div>{r.courts_available[0].club_name}{r.courts_available[0].court_label && ` · ${r.courts_available[0].court_label}`} · {hm(r.courts_available[0].start, r.courts_available[0].duration_min)}</div>}
          </div>
        </div>
      ) : (
        <div className="banner warn">
          <Icon name="alert" size={18} />
          <div style={{ flex: 1 }}>
            <b>Aucun terrain réservé pour ce créneau</b>
            <select value={clubId} onChange={(e) => setClubId(e.target.value)}>
              {clubs.filter((c) => c.phone).map((c) => <option key={c.id} value={c.id}>Demander au club : {c.name}</option>)}
              <option value="">Je m'en occupe moi-même</option>
            </select>
          </div>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="actions">
        {r.join ? <button onClick={() => act("accept", {})}><Icon name="check" size={16} /> Accepter</button>
          : hasCourt ? <button onClick={() => act("accept", { court_booking_id: +courtId })}><Icon name="check" size={16} /> Accepter avec ce terrain</button>
          : <button className="amber" onClick={() => act("accept", { club_id: clubId ? +clubId : null })}><Icon name="clock" size={16} /> Accepter · terrain à confirmer</button>}
        <button className="sec danger" onClick={async () => (await confirmDialog({ title: `Refuser la demande de ${r.name} ?`, message: r.charged_millimes ? `${tnd(r.charged_millimes)} de crédits lui seront rendus.` : "Rien n'a été débité de ses crédits.", confirm: "Refuser", cancel: "Retour", danger: true })) && act("refuse")}><Icon name="x" size={16} /> Refuser</button>
      </div>
      <div className="mut small-p">Accepter débite {tnd(r.price_millimes)} des crédits du joueur (le solde peut devenir négatif). Refuser ne débite rien.</div>
    </div>
  );
}

// Demande acceptée mais la séance n'a pas encore le nombre minimum de joueurs voulu
function WaitingPlayers({ r, reload }) {
  const [inviting, setInviting] = useState(false);
  return (
    <div className="card req">
      <Head r={r} />
      <div className="banner warn">
        <Icon name="users" size={18} />
        <span><b>{r.players_count}/{r.min_needed} joueur{r.min_needed > 1 ? "s" : ""}</b> : la séance sera confirmée automatiquement (et le joueur prévenu) dès qu'assez de joueurs l'auront rejointe. 6 h avant, sinon, il pourra changer de formule ou annuler.</span>
      </div>
      <div className="actions"><button onClick={() => setInviting(true)}><Icon name="users" size={16} /> Compléter la séance</button></div>
      {inviting && <InvitePlayers sessionId={r.session_id} onClose={() => setInviting(false)} onDone={() => { setInviting(false); reload(); }} />}
    </div>
  );
}

function Waiting({ r, reload, go }) {
  return (
    <div className="card req">
      <Head r={r} />
      <div className="banner warn">
        <Icon name="clock" size={18} />
        <span>{r.court_state === "refusee" ? "Le club a refusé : trouvez un autre terrain" : r.court_state ? "SMS envoyé au club, en attente de sa réponse" : "À vous de réserver le terrain"}</span>
      </div>
      <div className="actions">
        {r.court_state && <button className="sec" onClick={() => go("courts")}><Icon name="pin" size={16} /> Voir dans Terrains</button>}
        <button onClick={() => api(`/booking/requests/${r.id}/court-ok`, { method: "POST" }).then(reload)}><Icon name="check" size={16} /> Terrain confirmé</button>
      </div>
    </div>
  );
}

function ToNotify({ r, reload }) {
  const [text, setText] = useState(r.message);
  return (
    <div className="card req done">
      <div className="row">
        <div className="row g10"><Avatar name={r.name} size={38} /><div><b><PlayerTag p={r} /></b><div className="mut" style={{ textTransform: "capitalize" }}>{dayLabel(r.start)} · {hhmm(r.start)}</div></div></div>
        <span className="court-badge ok"><Icon name="checkCircle" size={13} /> Confirmée</span>
      </div>
      <textarea className="msg" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <ContactLinks phone={r.phone} email={r.email} message={text} subject="Séance de padel confirmée"
        onSent={() => api(`/booking/requests/${r.id}/notified`, { method: "POST" }).then(reload)} />
      <button className="link" onClick={() => api(`/booking/requests/${r.id}/notified`, { method: "POST" }).then(reload)}>Déjà prévenu</button>
    </div>
  );
}

function Groups({ reload: refresh }) {
  const [groups, setGroups] = useState(null);
  const load = () => api("/groups").then(setGroups);
  useEffect(() => { load(); }, []);
  useLive(load);
  if (!groups) return <Loading rows={1} />;
  const propose = (g, c) => api("/proposals", { method: "POST", body: { session_id: g.session_id, player_id: c.player_id } }).then(() => { load(); refresh?.(); });
  const withdraw = (p) => api(`/proposals/${p.id}`, { method: "DELETE" }).then(load);
  return (
    <>
      <p className="mut">Séances ouvertes avec des places libres. Les joueurs sont classés selon leur niveau et le type de séance qu'ils souhaitent : une proposition apparaît sur leur application, ils acceptent ou refusent.</p>
      {groups.length === 0 && <div className="card empty"><Icon name="users" size={30} /><b>Aucune séance à compléter</b><div className="mut">Créez une séance duo ou groupe ouverte dans le planning.</div></div>}
      {groups.map((g) => {
        const k = KIND[g.kind];
        return (
          <div className="card req" key={g.session_id} style={{ borderLeft: `5px solid ${k.color}` }}>
            <div className="row">
              <div>
                <b style={{ textTransform: "capitalize" }}>{dayLabel(g.start)} · {hhmm(g.start)}</b>
                <div className="mut">{k.label}{g.club && ` · ${g.club}`}</div>
              </div>
              <span className="spots">{g.capacity - g.spots_left}/{g.capacity}</span>
            </div>
            <div className="chips" style={{ margin: "8px 0" }}>
              {g.players.map((p) => <span key={p.name} className="chip small static"><Avatar name={p.name} size={20} /> {p.name.split(" ")[0]} <CategoryBadge category={p.category} /></span>)}
              {Array.from({ length: g.spots_left }).map((_, i) => <span key={i} className="chip small static empty-slot">place libre</span>)}
            </div>
            {g.proposed.map((p) => (
              <div className="row mut" key={p.id}><span><Icon name="send" size={14} /> Proposé à {p.name}</span><button className="link" onClick={() => withdraw(p)}>Retirer</button></div>
            ))}
            <div className="mut" style={{ margin: "8px 0 4px" }}>Joueurs compatibles</div>
            {g.candidates.length === 0 && <div className="mut">Personne de compatible pour l'instant.</div>}
            {g.candidates.map((c) => (
              <div className="row cand" key={c.player_id}>
                <div className="row g10"><Avatar name={c.name} size={32} /><div><b>{c.name}</b><div className="mut"><CategoryBadge category={c.category} gender={c.gender} /> {c.gap === 0 ? "même niveau" : `écart ${c.gap}`}{!c.has_account && " · sans compte"}</div></div></div>
                <button className="small" onClick={() => propose(g, c)}>Proposer</button>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

export default function Requests({ go, refreshSummary }) {
  const [items, setItems] = useState(null);
  const [clubs, setClubs] = useState([]);
  const [sub, setSub] = useState("requests");
  const load = () => { api("/booking/requests").then(setItems); api("/clubs").then(setClubs); refreshSummary?.(); };
  useEffect(() => { load(); }, []);
  useLive(load);
  if (!items) return <><h1>Demandes</h1><Loading rows={3} /></>;

  const pending = items.filter((i) => i.status === "en_attente");
  const waiting = items.filter((i) => i.status === "acceptee");
  const waitingPlayers = items.filter((i) => i.status === "attente_joueurs");
  const toNotify = items.filter((i) => i.status === "confirmee");
  const total = pending.length + toNotify.length;

  return (
    <>
      <h1>Demandes</h1>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={sub === "requests" ? "on" : ""} onClick={() => setSub("requests")}>
          Réservations {total > 0 && <b className="pillcount">{total}</b>}
        </button>
        <button className={sub === "groups" ? "on" : ""} onClick={() => setSub("groups")}>Groupes à compléter</button>
      </div>

      {sub === "groups" ? <Groups reload={load} /> : (
        <>
          {items.length === 0 && <div className="card empty"><Icon name="checkCircle" size={34} /><b>Tout est à jour</b><div className="mut">Aucune demande en attente.</div></div>}
          {pending.length > 0 && <h2 className="red-h"><span className="dot" /> À traiter ({pending.length})</h2>}
          {pending.map((r) => <Pending key={r.id} r={r} clubs={clubs} reload={load} />)}
          {waitingPlayers.length > 0 && <h2>En attente d'autres joueurs ({waitingPlayers.length})</h2>}
          {waitingPlayers.map((r) => <WaitingPlayers key={r.id} r={r} reload={load} />)}
          {waiting.length > 0 && <h2>En attente du terrain ({waiting.length})</h2>}
          {waiting.map((r) => <Waiting key={r.id} r={r} reload={load} go={go} />)}
          {toNotify.length > 0 && <h2 className="red-h"><span className="dot" /> Confirmations à envoyer ({toNotify.length})</h2>}
          {toNotify.length > 0 && <p className="mut" style={{ marginTop: -4 }}>Le terrain est confirmé : prévenez le joueur en un clic.</p>}
          {toNotify.map((r) => <ToNotify key={r.id} r={r} reload={load} />)}
        </>
      )}
    </>
  );
}
