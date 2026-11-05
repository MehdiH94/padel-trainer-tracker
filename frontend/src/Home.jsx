import { useEffect, useState } from "react";
import { api, dayKey, dayLabel, hhmm, peek, shortDate, tnd, toDate, useLive } from "./api.js";
import { Modal } from "./feedback.jsx";
import FeedbackEditor from "./FeedbackEditor.jsx";
import { monthRange } from "./Finance.jsx";
import SessionPayments from "./SessionPayments.jsx";
import Icon from "./Icon.jsx";
import { guideHidden, guideSteps, hideGuide } from "./guide.js";
import { sessionStatus } from "./sessionActions.js";
import { Avatar, AvatarStack, BarChart, byWeek, ContactLinks, COURT_STATUS, InstallCard, KIND, Loading, PlayerTag, PlayerTags, Where } from "./ui.jsx";

const TZ = "Africa/Tunis";
const ymd = (d) => d.toLocaleDateString("fr-CA", { timeZone: TZ });
const weekStart = (iso) => {
  const d = new Date(dayKey(iso) + "T12:00:00Z");
  return ymd(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000));
};
const endOf = (s) => new Date(toDate(s.start).getTime() + s.duration_min * 60000);
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}` : `${min} min`);

// Libellé d'état d'une séance d'aujourd'hui, selon l'heure actuelle
function phase(s, now) {
  const st = toDate(s.start), en = endOf(s);
  if (now >= en) return { key: "validate", label: "À valider" };
  if (now >= st) return { key: "live", label: "En cours" };
  const m = Math.round((st - now) / 60000);
  return { key: "soon", label: m < 60 ? `Dans ${m} min` : `Dans ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` };
}

// Panneau d'une séance terminée: un retour par joueur
function DonePanel({ s, name, byId, strokes, onSaved, onClose }) {
  const [list, setList] = useState(null);
  const [who, setWho] = useState(null);
  const load = () => api(`/sessions/${s.id}/feedback`).then((l) => { setList(l); setWho((w) => w ?? l[0]?.player_id); });
  useEffect(() => { setList(null); setWho(null); load(); }, [s.id]);
  if (!list) return null;
  const cur = list.find((x) => x.player_id === who) ?? list[0];
  return (
    <div className="card donepanel">
      <div className="row">
        <b className="cap1">{shortDate(s.start)} · {hhmm(s.start)} · {KIND[s.kind].label}</b>
        <button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button>
      </div>
      {s.payments?.length > 0 && (
        <>
          <div className="mut" style={{ marginTop: 8 }}>Règlements</div>
          <SessionPayments s={s} name={name} byId={byId} onPaid={onSaved} />
        </>
      )}
      {list.length > 1 && (
        <div className="chips" style={{ margin: "8px 0" }}>
          {list.map((x) => {
            const filled = x.worked_on.length || x.note || x.to_improve;
            return <button key={x.player_id} className={"chip small" + (cur.player_id === x.player_id ? " on" : "")} onClick={() => setWho(x.player_id)}><PlayerTag p={byId?.(x.player_id) ?? x} first />{filled ? "" : " •"}</button>;
          })}
        </div>
      )}
      {list.length === 1 && <div className="mut" style={{ margin: "4px 0" }}><PlayerTag p={byId?.(cur.player_id) ?? cur} /></div>}
      {cur && <FeedbackEditor key={cur.player_id} h={cur} playerId={cur.player_id} name={byId?.(cur.player_id)?.name} strokes={strokes} rate onSaved={() => { load(); onSaved(); }} />}
    </div>
  );
}

// Premiers pas d'un nouveau coach: prix, disponibilités, premier joueur
// Guide « Bien démarrer » d'un nouveau coach: une liste qui se coche toute seule au fil de la configuration.
// Chaque étape mène directement au bon écran (section des réglages, terrains, joueurs, planning).
function Onboarding({ settings, players, sessions, go }) {
  const [hidden, setHidden] = useState(guideHidden);
  const steps = guideSteps(settings, players, sessions);
  const done = steps.filter((s) => s.ok).length;
  const next = steps.findIndex((s) => !s.ok);
  if (done === steps.length || hidden) return null;
  return (
    <div className="card onboard">
      <div className="row"><b>{done === 0 ? `Bienvenue${settings.name ? " " + settings.name.split(" ")[0] : ""} ! Configurons votre espace` : "Bien démarrer"}</b><span className="mut">{done}/{steps.length}</span></div>
      {done === 0 && <p className="mut small-p" style={{ margin: "4px 0 6px" }}>Six étapes rapides, dans l'ordre : vos joueurs pourront ensuite trouver vos créneaux et réserver en ligne.</p>}
      <div className="bar"><div style={{ width: `${(done / steps.length) * 100}%`, background: "var(--green)" }} /></div>
      {steps.map((st, i) => (
        <button key={st.key} className={"step" + (st.ok ? " ok" : "") + (i === next ? " next" : "")} onClick={() => go(st.to)}>
          <span className="stepnum">{st.ok ? <Icon name="check" size={14} /> : i + 1}</span>
          <span className="steptxt">{st.label}{i === next && <small>{st.hint}</small>}</span>
          {!st.ok && <Icon name="chevR" size={16} />}
        </button>
      ))}
      <button className="link" style={{ marginTop: 6 }} onClick={() => { hideGuide(); setHidden(true); }}>Masquer ce guide</button>
    </div>
  );
}

// Indicateur de l'accueil: un chiffre, un libellé; un clic ouvre son résumé
function Kpi({ icon, value, label, warn, small, onClick }) {
  return (
    <button className="kpi kpi-btn" onClick={onClick}>
      <span className={"ico" + (warn ? " warn" : "")}><Icon name={icon} size={18} /></span>
      <div className={"big" + (small ? " sm" : "") + (warn ? " red" : "")}>{value}</div>
      <div className="mut">{label}</div>
      <Icon name="chevR" size={15} />
    </button>
  );
}

// Séance du jour encore à venir: une ligne courte; un clic montre avec qui, où, et les actions
function TodayRow({ s, now, byId, go, openPlayer, onCancel }) {
  const [open, setOpen] = useState(false);
  const ph = phase(s, now);
  const ps = s.player_ids.map(byId).filter(Boolean);
  return (
    <div className={"card today-row " + ph.key}>
      <button className="row plain today-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="row g10">
          <i className="kind-dot" style={{ background: KIND[s.kind]?.color }} />
          <b>{hhmm(s.start)}</b>
          <span className="mut">{KIND[s.kind]?.label} · {ps.length ? ps.map((p) => p.name.split(" ")[0]).join(", ") : "sans joueur"}</span>
        </span>
        <span className={"chip-state " + ph.key}>{ph.label}</span>
      </button>
      {open && (
        <div className="today-body">
          <div className="mut">{hhmm(s.start)} → {hhmm(endOf(s).toISOString())} · {dur(s.duration_min)}</div>
          <Where s={s} />
          {s.court_status && <span className={"court-badge " + COURT_STATUS[s.court_status].cls}><Icon name="pin" size={12} /> {COURT_STATUS[s.court_status].label}</span>}
          <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {ps.map((p) => <button key={p.id} className="who-btn dark" onClick={() => openPlayer(p.id)}><Avatar name={p.name} size={26} /><PlayerTag p={p} /></button>)}
          </div>
          <div className="actions">
            <button className="small sec" onClick={() => go(`session/${s.id}`)}><Icon name={s.has_plan ? "checkCircle" : "sparkles"} size={15} /> {s.has_plan ? "Plan prêt" : "Préparer"}</button>
            {ps[0] && <a className="btnlink" href={`tel:${ps[0].phone}`}><Icon name="phone" size={15} /> Appeler</a>}
            <button className="small sec" onClick={() => onCancel(s.id)}>Annuler</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Home({ go, openPlayer, summary }) {
  // données du dernier passage affichées tout de suite (peek), mises à jour ensuite
  const [month] = useState(() => monthRange(ymd(new Date()))); // mois en cours en entier: S1 à S5 sur les graphes
  const finUrl = `/finance?start=${month[0]}&end=${month[1]}`;
  const [fin, setFin] = useState(() => peek(finUrl) ?? null); // mois en cours: heures, gagné, impayés
  const [sessions, setSessions] = useState(() => peek("/sessions") ?? null); // null = pas encore chargées
  const [players, setPlayers] = useState(() => peek("/players") ?? []);
  const [strokes, setStrokes] = useState(() => peek("/criteria")?.names ?? []);
  const [now, setNow] = useState(new Date());
  const [openDone, setOpenDone] = useState(null);
  const [detail, setDetail] = useState(null); // résumé d'un indicateur: hours / earned / today / unpaid
  const [settings, setSettings] = useState(() => peek("/booking/settings") ?? null);
  const [playersLoaded, setPlayersLoaded] = useState(() => !!peek("/players"));
  const load = () => {
    api("/booking/settings").then(setSettings).catch(() => {});
    api(finUrl).then(setFin);
    api("/sessions").then(setSessions);
    api("/players").then((p) => { setPlayers(p); setPlayersLoaded(true); });
  };
  useEffect(() => { load(); api("/criteria").then((c) => setStrokes(c.names)).catch(() => {}); }, []);
  useLive(load);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  if (!fin) return <Loading hero rows={3} />;
  const all = sessions ?? [];

  const byId = (id) => players.find((p) => p.id === id);
  const name = (id) => byId(id)?.name ?? "?";
  const todayAll = all.filter((s) => dayKey(s.start) === ymd(now) && s.status !== "annulee");
  const left = todayAll.filter((s) => s.status === "prevue" && endOf(s) > now); // séances du jour encore à venir (ou en cours)
  // Séances effectuées à noter (retour du coach): celles des 7 derniers jours
  const weekAgo = Date.now() - 7 * 86400000;
  const toRate = all.filter((s) => s.status === "effectuee" && s.feedback_missing && toDate(s.start).getTime() > weekAgo).sort((a, b) => toDate(b.start) - toDate(a.start));
  const setStatus = sessionStatus(all, load);
  // prochaine séance: en cours ou à venir (aujourd'hui ou plus tard); les autres du jour sont listées en bas
  const focus = all.filter((s) => s.status === "prevue" && endOf(s) > now).sort((a, b) => toDate(a.start) - toDate(b.start))[0];
  const rest = left.filter((s) => s.id !== focus?.id);
  const alerts = (summary?.pending ?? 0) + (summary?.to_notify ?? 0);
  const monthName = now.toLocaleDateString("fr-FR", { month: "long", timeZone: TZ });

  return (
    <>
      <div className="hero">
        <div className="hero-top">{dayLabel(now.toISOString())}</div>
        <h1>Bonjour coach</h1>
        <div className="next">
          {left.length === 0
            ? (todayAll.length ? "Toutes vos séances du jour sont terminées." : "Aucune séance aujourd'hui. Profitez-en.")
            : <>Encore <b>{left.length} séance{left.length > 1 ? "s" : ""}</b> aujourd'hui, prochaine à <b>{hhmm(left[0].start)}</b>.</>}
        </div>
      </div>

      {alerts > 0 && (
        <button className="alert red" onClick={() => go("requests")}>
          <span className="alert-ico"><Icon name="bell" size={20} /></span>
          <span className="alert-txt">
            <b>{alerts} élément{alerts > 1 ? "s" : ""} à traiter</b>
            <small>
              {summary.pending > 0 && `${summary.pending} demande${summary.pending > 1 ? "s" : ""} de réservation`}
              {summary.pending > 0 && summary.to_notify > 0 && " · "}
              {summary.to_notify > 0 && `${summary.to_notify} confirmation${summary.to_notify > 1 ? "s" : ""} à envoyer`}
            </small>
          </span>
          <Icon name="chevR" size={20} />
        </button>
      )}

      {/* guide affiché seulement quand tout est chargé: sinon il apparaît puis disparaît */}
      {settings && playersLoaded && sessions && <Onboarding settings={settings} players={players} sessions={sessions} go={go} />}
      <InstallCard />

      {/* La prochaine séance d'abord (en vert quand elle est en cours), avec ses actions */}
      {focus && (() => {
        const ph = phase(focus, now);
        const ps = focus.player_ids.map(byId).filter(Boolean);
        const today = dayKey(focus.start) === ymd(now);
        return (
          <div className={"focus " + ph.key}>
            <div className="row">
              <span className="pill">{ph.key === "live" ? "● En cours" : "Prochaine séance"}</span>
              <span className="cap1">{today ? ph.label : dayLabel(focus.start)}</span>
            </div>
            <div className="time" style={{ fontSize: "1.7rem", margin: "6px 0 2px" }}>{hhmm(focus.start)} <span style={{ opacity: 0.7, fontSize: "1rem" }}>→ {hhmm(endOf(focus).toISOString())}</span></div>
            <div style={{ opacity: 0.9 }}>{KIND[focus.kind]?.label}</div>
            <Where s={focus} light />
            <div className="row" style={{ marginTop: 10, justifyContent: "flex-start", flexWrap: "wrap" }}>
              {ps.map((p) => (
                <button key={p.id} className="who-btn" onClick={() => openPlayer(p.id)}><Avatar name={p.name} size={28} /><PlayerTag p={p} first /></button>
              ))}
            </div>
            <div className="actions">
              <button className="small light" onClick={() => go(`session/${focus.id}`)}><Icon name={focus.has_plan ? "checkCircle" : "sparkles"} size={15} /> {focus.has_plan ? "Plan prêt" : "Préparer la séance"}</button>
              {ps[0] && <a className="btnlink light" href={`tel:${ps[0].phone}`}><Icon name="phone" size={16} /> Appeler</a>}
              <button className="small light" onClick={() => setStatus(focus.id, "annulee")}>Annuler</button>
            </div>
          </div>
        );
      })()}

      <h2>Vue d'ensemble</h2>
      <div className="grid kpis">
        <Kpi icon="clock" value={`${fin.hours} h`} label={`Heures en ${monthName}`} onClick={() => setDetail("hours")} />
        <Kpi icon="wallet" value={tnd(fin.earned_millimes)} small label={`Gagné en ${monthName}`} onClick={() => setDetail("earned")} />
        <Kpi icon="calendar" value={left.length} label="Séances restantes aujourd'hui" onClick={() => setDetail("today")} />
        <Kpi icon="alert" value={tnd(fin.unpaid_total_millimes)} small warn={fin.unpaid_total_millimes > 0} label="Impayés" onClick={() => setDetail("unpaid")} />
      </div>

      {/* Séances effectuées (automatiquement, à la fin de l'heure) qui attendent le retour du coach */}
      {toRate.length > 0 && (
        <div className="card torate">
          <div className="row"><b><Icon name="edit" size={16} /> {toRate.length} séance{toRate.length > 1 ? "s" : ""} à noter</b><span className="mut small-p">retour et araignée</span></div>
          <div className="donestrip" style={{ marginTop: 8 }}>
            {toRate.map((s) => (
              <button key={s.id} className={"donechip" + (openDone === s.id ? " on" : "")} onClick={() => setOpenDone(openDone === s.id ? null : s.id)}>
                <i className="todo" />
                <AvatarStack names={s.player_ids.map(name)} size={24} />
                <b>{hhmm(s.start)}</b>
                <small>{dayKey(s.start) === ymd(now) ? "aujourd'hui" : shortDate(s.start)}</small>
              </button>
            ))}
          </div>
        </div>
      )}
      {openDone && toRate.find((s) => s.id === openDone) && (
        <DonePanel s={toRate.find((s) => s.id === openDone)} name={name} byId={byId} strokes={strokes} onSaved={load} onClose={() => setOpenDone(null)} />
      )}

      {rest.length > 0 && <h2>À venir aujourd'hui</h2>}
      {sessions === null && <Loading rows={1} />}
      {rest.map((s) => <TodayRow key={s.id} s={s} now={now} byId={byId} go={go} openPlayer={openPlayer} onCancel={(id) => setStatus(id, "annulee")} />)}

      {detail && (
        <Modal onClose={() => setDetail(null)} label="Résumé">
          <div className="row"><b className="sheet-title">{{ hours: `Heures en ${monthName}`, earned: `Gagné en ${monthName}`, today: "Séances restantes aujourd'hui", unpaid: "Impayés" }[detail]}</b>
            <button className="small sec iconbtn" aria-label="Fermer" onClick={() => setDetail(null)}><Icon name="x" size={15} /></button></div>
          {detail === "hours" && (
            <>
              <p className="mut small-p">{fin.hours} h sur {fin.sessions} séance{fin.sessions > 1 ? "s" : ""} effectuée{fin.sessions > 1 ? "s" : ""}. Une colonne par semaine du mois (S1 = du 1er au 7).</p>
              <BarChart data={byWeek(fin.series, (x) => x.hours)} format={(v) => `${String(v).replace(".", ",")} h`} />
            </>
          )}
          {detail === "earned" && (
            <>
              <p className="mut small-p">Ce que vous ont rapporté vos séances effectuées ce mois-ci (payées en crédits ou à régler). Argent réellement reçu ce mois : <b>{tnd(fin.cashed_millimes)}</b>.</p>
              <BarChart data={byWeek(fin.series, (x) => x.earned_millimes / 1000)} format={(v) => `${Math.round(v)} DT`} color="var(--green)" />
              <div className="mut small-p center">Une colonne par semaine du mois (S1 = du 1er au 7), en dinars.</div>
              {fin.top_players.length > 0 && <div className="mut small-p" style={{ marginTop: 6 }}>Meilleurs clients : {fin.top_players.slice(0, 3).map((t) => `${t.name.split(" ")[0]} (${tnd(t.earned_millimes)})`).join(", ")}</div>}
              <button className="sec" style={{ width: "100%", marginTop: 10 }} onClick={() => go("finance")}><Icon name="wallet" size={15} /> Ouvrir Finance</button>
            </>
          )}
          {detail === "today" && (left.length ? left.map((s) => (
            <div key={s.id} className="sumrow">
              <b>{hhmm(s.start)} → {hhmm(endOf(s).toISOString())}</b>
              <div className="mut small-p">{KIND[s.kind]?.label}{s.club && ` · ${s.club}`}{s.court && ` · ${s.court}`}</div>
              <div className="small-p"><PlayerTags ids={s.player_ids} byId={byId} empty="Sans joueur" /></div>
            </div>
          )) : <p className="mut">Plus aucune séance aujourd'hui.</p>)}
          {detail === "unpaid" && (fin.unpaid.length ? (
            <>
              {fin.unpaid.slice(0, 6).map((u) => (
                <div key={u.player_id} className="sumrow">
                  <div className="row"><button className="plain" onClick={() => { setDetail(null); openPlayer(u.player_id); }}><b>{u.name}</b></button><b className="red">{tnd(-u.balance_millimes)}</b></div>
                  <ContactLinks phone={u.phone} email={u.email} subject="Rappel de paiement"
                    message={`Bonjour ${u.name.split(" ")[0]}, petit rappel : il reste ${tnd(-u.balance_millimes)} à régler pour vos séances de padel. Merci !`} />
                </div>
              ))}
              <button className="sec" style={{ width: "100%", marginTop: 10 }} onClick={() => go("finance")}><Icon name="wallet" size={15} /> Tous les impayés dans Finance</button>
            </>
          ) : <p className="mut">Aucun impayé : tout le monde est à jour.</p>)}
        </Modal>
      )}
    </>
  );
}
