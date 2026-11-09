import { useEffect, useState } from "react";
import { api, dayLabel, hhmm, peek, tnd, toDate, useLive } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog } from "./feedback.jsx";
import InvitePlayers from "./InvitePlayers.jsx";
import { Avatar, CategoryBadge, ContactLinks, DateSelect, KIND, Loading, PlayerTag, TimeSelect } from "./ui.jsx";

const dur = (m) => (m % 60 ? `${Math.floor(m / 60) ? Math.floor(m / 60) + " h " : ""}${m % 60}` : `${m / 60} h`);
const wishText = (w) => (w ?? []).map((x) => `${KIND[x.kind].label} ${x.minutes.map(dur).join(" ou ")}`).join(" · ");
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
        <Icon name="calendar" size={16} /> <b className="cap1">{dayLabel(r.start)}</b>
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
            const mins = r.wish?.find((x) => x.kind === k)?.minutes; // durées acceptées (1 h, 1 h 30 ou les deux)
            return <span key={k} className={"kind-pill" + (ok ? "" : " refused")} style={ok ? { background: KIND[k].color + "1a", color: KIND[k].color } : undefined}><Icon name={ok ? "check" : "x"} size={13} /> {KIND[k].label}{ok && mins ? ` · ${mins.map(dur).join(" ou ")}` : ""}</span>;
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

// Comme une invitation de réunion: d'accord pour l'entraîner, mais pas à cette heure-là → autre horaire proposé.
// Le joueur est notifié (appli + e-mail) et accepte (séance acceptée d'office) ou refuse.
function ProposeTime({ r, onDone, onCancel }) {
  const day = toDate(r.start).toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const [f, setF] = useState({ day, time: hhmm(r.start), minutes: r.duration_min });
  const [err, setErr] = useState("");
  const send = () => api(`/booking/requests/${r.id}/propose`, { method: "POST", body: { start: `${f.day}T${f.time}:00+01:00`, duration_min: +f.minutes } })
    .then(onDone).catch((x) => setErr(x.message));
  return (
    <div className="propose-box">
      <b>Proposer un autre horaire à {r.name.split(" ")[0]}</b>
      <div className="grid">
        <label className="field"><span className="mut">Jour</span><DateSelect label="Jour proposé" value={f.day} onChange={(v) => setF({ ...f, day: v })} /></label>
        <label className="field"><span className="mut">Heure</span><TimeSelect label="Heure proposée" value={f.time} onChange={(v) => setF({ ...f, time: v })} /></label>
      </div>
      <label className="field"><span className="mut">Durée</span>
        <select aria-label="Durée proposée" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })}>{[60, 90, 120].map((m) => <option key={m} value={m}>{m % 60 ? `${Math.floor(m / 60)} h 30` : `${m / 60} h`}</option>)}</select>
      </label>
      {err && <div className="err">{err}</div>}
      <div className="actions">
        <button onClick={send}><Icon name="send" size={15} /> Envoyer la proposition</button>
        <button className="sec" onClick={onCancel}>Annuler</button>
      </div>
      <div className="mut small-p">{r.name.split(" ")[0]} est prévenu dans l'appli et par e-mail : s'il accepte, la séance est acceptée à ce nouvel horaire.</div>
    </div>
  );
}

function Pending({ r, clubs, reload }) {
  const [proposing, setProposing] = useState(false);
  const [clubId, setClubId] = useState(clubs.find((c) => c.phone)?.id ?? "");
  const [courtId, setCourtId] = useState(r.courts_available?.[0]?.id ?? "");
  const [err, setErr] = useState("");
  const act = (path, body) => api(`/booking/requests/${r.id}/${path}`, { method: "POST", body }).then(reload).catch((x) => setErr(x.message));
  const hasCourt = (r.courts_available ?? []).length > 0;
  return (
    <div className="card req" data-id={r.id}>
      <Head r={r} />
      {r.group && <div className="mut small-p"><Icon name="users" size={13} /> {r.group.private ? `Réservation en groupe organisée par ${r.group.host}` : `Demande groupée avec ${r.group.host}`}</div>}
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
      {r.session_here && (r.session_here.join
        ? <div className="banner ok"><Icon name="users" size={18} /><span>Une séance est déjà acceptée à cette heure avec {r.session_here.players.join(", ")} : accepter = il la rejoint.</span></div>
        : <div className="banner bad"><Icon name="alert" size={18} /><span>{r.session_here.why}</span></div>)}
      {err && <div className="err">{err}</div>}
      <div className="actions">
        {r.session_here && !r.session_here.join ? null : r.join ? <button onClick={() => act("accept", {})}><Icon name="check" size={16} /> Accepter</button>
          : hasCourt ? <button onClick={() => act("accept", { court_booking_id: +courtId })}><Icon name="check" size={16} /> Accepter avec ce terrain</button>
          : <button className="amber" onClick={() => act("accept", { club_id: clubId ? +clubId : null })}><Icon name="clock" size={16} /> Accepter · terrain à confirmer</button>}
        {!r.join && <button className="sec" onClick={() => setProposing(!proposing)}><Icon name="clock" size={16} /> Autre horaire</button>}
        <button className="sec danger" onClick={async () => (await confirmDialog({ title: `Refuser la demande de ${r.name} ?`, message: r.charged_millimes ? `${tnd(r.charged_millimes)} de crédits lui seront rendus.` : "Rien n'a été débité de ses crédits.", confirm: "Refuser", cancel: "Retour", danger: true })) && act("refuse")}><Icon name="x" size={16} /> Refuser</button>
      </div>
      {proposing && <ProposeTime r={r} onDone={() => { setProposing(false); reload(); }} onCancel={() => setProposing(false)} />}
      <div className="mut small-p">Accepter débite {tnd(r.price_millimes)} des crédits du joueur (le solde peut devenir négatif). Refuser ne débite rien.</div>
    </div>
  );
}

// Plusieurs demandes pour le même créneau (elles se chevauchent): on propose les choix possibles — qui peut jouer
// ensemble (même heure, une taille et une durée qui conviennent à tous, niveaux compatibles) — et un seul geste
// accepte ce choix et refuse les autres (rien n'a été débité). On peut aussi les traiter une par une.
function teams(list) {
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  const out = [];
  const used = new Set();
  for (const r of list) {
    if (used.has(r.id)) continue;
    const team = [r];
    for (const id of r.fits_with ?? []) {
      const o = byId[id];
      if (o && !used.has(id) && team.every((t) => (t.fits_with ?? []).includes(id))) team.push(o);
    }
    if (team.length > 1) team.forEach((t) => used.add(t.id));
    out.push(team);
  }
  // une équipe à plusieurs d'abord, puis les demandes seules qui n'en font pas partie
  const seen = new Set();
  return out.filter((t) => t.length > 1 || !used.has(t[0].id)).filter((t) => { const k = t.map((x) => x.id).sort().join(); return !seen.has(k) && seen.add(k); })
    .sort((a, b) => b.length - a.length);
}

function common(team) {
  // formules et durées acceptées par tous les membres du choix
  const sets = team.map((r) => new Set((r.wish ?? []).flatMap((w) => w.minutes.map((m) => `${w.kind}:${m}`))));
  const all = [...sets[0]].filter((x) => sets.every((s) => s.has(x)));
  const kinds = [...new Set(all.map((x) => x.split(":")[0]))].filter((k) => team.length === 1 || k !== "individuel");
  return kinds.map((k) => `${KIND[k].label} · ${all.filter((x) => x.startsWith(k + ":")).map((x) => dur(+x.split(":")[1])).join(" ou ")}`).join(" / ");
}

function SlotConflict({ list, clubs, reload }) {
  const [oneByOne, setOneByOne] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const options = teams(list);
  const start = list.reduce((a, r) => (r.start < a ? r.start : a), list[0].start);
  const end = list.reduce((a, r) => Math.max(a, toDate(r.start).getTime() + r.duration_min * 60000), 0);
  const choose = async (team) => {
    const others = list.filter((r) => !team.includes(r));
    const ok = await confirmDialog({
      title: `Accepter ${team.map((r) => r.name.split(" ")[0]).join(" et ")} ?`,
      message: others.length ? `${others.map((r) => r.name.split(" ")[0]).join(" et ")} ${others.length > 1 ? "seront refusés" : "sera refusé"} (rien n'a été débité de ses crédits).` : "",
      confirm: "Accepter ce choix", cancel: "Retour",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const first = team[0];
      const court = first.courts_available?.[0];
      const club = clubs.find((c) => c.phone);
      // le premier ouvre la séance (avec le terrain libre s'il y en a un), les autres la rejoignent
      await api(`/booking/requests/${first.id}/accept`, { method: "POST", body: court ? { court_booking_id: court.id } : { club_id: club ? club.id : null } });
      for (const r of team.slice(1)) await api(`/booking/requests/${r.id}/accept`, { method: "POST", body: {} });
      for (const r of others) await api(`/booking/requests/${r.id}/refuse`, { method: "POST" });
      reload();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
      reload();
    }
  };
  return (
    <div className="card req conflict">
      <div className="row">
        <b className="cap1">{dayLabel(start)} · {hm(start, Math.round((end - toDate(start).getTime()) / 60000))}</b>
        <span className="conflict-tag">{list.length} demandes · même créneau</span>
      </div>
      {list.some((r) => r.group) && <div className="banner ok"><Icon name="users" size={18} /><span>{list.find((r) => r.group).group.private ? <><b>Réservation en groupe</b> organisée par {list.find((r) => r.group).group.host}</> : <><b>Demande groupée</b> : des joueurs ont rejoint la demande de {list.find((r) => r.group).group.host}</>} : ils veulent s'entraîner ensemble.</span></div>}
      <div className="mut small-p">{options.length > 1 ? "Elles ne sont pas toutes compatibles : choisissez qui joue." : "Elles sont compatibles : ces joueurs peuvent jouer ensemble."}</div>
      {options.map((team, i) => {
        const others = list.filter((r) => !team.includes(r));
        return (
          <div key={team.map((r) => r.id).join()} className={"choice-opt" + (i === 0 ? " best" : "")}>
            <div className="row"><b>{common(team) || wishText(team[0].wish)}</b><span className="mut small-p">{team.length > 1 ? `${team.length} joueurs` : tnd(team[0].price_millimes)}</span></div>
            <div className="partners">{team.map((r) => <span key={r.id} className="partner"><Avatar name={r.name} size={22} /> <PlayerTag p={r} /></span>)}</div>
            {others.length > 0 && <div className="mut small-p">{others.map((r) => r.name.split(" ")[0]).join(" et ")} {others.length > 1 ? "seront refusés" : "sera refusé"}</div>}
            <button className={i === 0 ? "" : "sec"} style={{ width: "100%", marginTop: 6 }} disabled={busy} onClick={() => choose(team)}>
              <Icon name="check" size={15} /> Accepter {team.map((r) => r.name.split(" ")[0]).join(" et ")}
            </button>
          </div>
        );
      })}
      {err && <div className="err">{err}</div>}
      <button className="link" onClick={() => setOneByOne(!oneByOne)}>{oneByOne ? "Masquer le détail" : "Ou les traiter une par une"} <Icon name={oneByOne ? "chevD" : "chevR"} size={14} /></button>
      {oneByOne && list.map((r) => <Pending key={r.id} r={r} clubs={clubs} reload={reload} />)}
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
        <div className="row g10"><Avatar name={r.name} size={38} /><div><b><PlayerTag p={r} /></b><div className="mut cap1">{dayLabel(r.start)} · {hhmm(r.start)}</div></div></div>
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
                <b className="cap1">{dayLabel(g.start)} · {hhmm(g.start)}</b>
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

// Demandes regroupées par créneau: celles qui se chevauchent (same_slot) forment un seul bloc
function slots(pending) {
  const groups = [];
  const where = {};
  for (const r of pending) {
    const g = [r.id, ...(r.same_slot ?? [])].map((id) => where[id]).find((x) => x);
    if (g) { g.push(r); where[r.id] = g; } else { const n = [r]; groups.push(n); where[r.id] = n; }
  }
  return groups;
}

export default function Requests({ go, refreshSummary }) {
  const [items, setItems] = useState(() => peek("/booking/requests") ?? null);
  const [clubs, setClubs] = useState([]);
  const [sub, setSub] = useState("requests");
  const [cancels, setCancels] = useState(() => peek("/booking/cancellations") ?? []); // annulations des joueurs (7 jours)
  const load = () => { api("/booking/requests").then(setItems); api("/booking/cancellations").then(setCancels).catch(() => {}); api("/clubs").then(setClubs); refreshSummary?.(); };
  useEffect(() => { load(); }, []);
  useLive(load);
  if (!items) return <><h1>Demandes</h1><Loading rows={3} /></>;

  const pending = items.filter((i) => i.status === "en_attente");
  const proposed = items.filter((i) => i.status === "contre_proposition"); // autre horaire proposé: réponse du joueur attendue
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
          {cancels.length > 0 && <h2 className="red-h"><span className="dot" /> Annulations des joueurs ({cancels.length})</h2>}
          {cancels.map((c) => (
            <div className="card req cancel-row" key={c.id}>
              <div className="row"><b>{c.name}</b><span className="court-badge wait"><Icon name="x" size={12} /> {c.was_request ? "Demande annulée" : "A annulé"}</span></div>
              <div className="small-p cap1">{dayLabel(c.start)} · {hm(c.start, c.duration_min)}</div>
              <div className="mut small-p">Annulé le {dayLabel(c.cancelled_at)} à {hhmm(c.cancelled_at)}</div>
            </div>
          ))}
          {items.length === 0 && <div className="card empty"><Icon name="checkCircle" size={34} /><b>Tout est à jour</b><div className="mut">Aucune demande en attente.</div></div>}
          {pending.length > 0 && <h2 className="red-h"><span className="dot" /> À traiter ({pending.length})</h2>}
          {slots(pending).map((list) => list.length > 1
            ? <SlotConflict key={list.map((r) => r.id).join()} list={list} clubs={clubs} reload={load} />
            : <Pending key={list[0].id} r={list[0]} clubs={clubs} reload={load} />)}
          {proposed.length > 0 && <h2>Autre horaire proposé · réponse du joueur ({proposed.length})</h2>}
          {proposed.map((r) => (
            <div className="card req" key={r.id}>
              <div className="row"><div className="row g10"><Avatar name={r.name} size={36} /><b><PlayerTag p={r} /></b></div><span className="court-badge wait"><Icon name="clock" size={12} /> En attente</span></div>
              <div className="small-p" style={{ marginTop: 6 }}>Demandé : <s className="cap1">{dayLabel(r.start)} · {hhmm(r.start)}</s></div>
              <div className="small-p">Proposé : <b className="cap1">{dayLabel(r.proposed_start)} · {hm(r.proposed_start, r.proposed_minutes)}</b></div>
            </div>
          ))}
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
