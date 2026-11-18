import { useEffect, useRef, useState } from "react";
import { api, peek, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import CriteriaEditor from "./CriteriaEditor.jsx";
import { toastError } from "./feedback.jsx";
import { ClockPicker, KIND, Loading, MoneyInput, PushToggle } from "./ui.jsx";
import { RatingLine, ReviewList } from "./Public.jsx";

// Les avis des joueurs sur le coach, et le lien de sa page publique
function MyReviews({ coachId }) {
  const [r, setR] = useState(null);
  useEffect(() => { api("/coach/reviews").then(setR).catch(() => {}); }, []);
  const link = `${location.origin}/coachs/${coachId}`;
  return (
    <div className="card">
      <div className="row"><b>Vos avis</b>{r && <RatingLine rating={r.rating} count={r.reviews_count} />}</div>
      <div className="mut small-p" style={{ margin: "6px 0" }}>Votre page publique, à partager (Instagram, WhatsApp) : <a href={link} target="_blank" rel="noreferrer">{link.replace(/^https?:\/\//, "")}</a></div>
      {r && <ReviewList reviews={r.reviews.slice(0, 5)} />}
    </div>
  );
}

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const HORIZONS = [[7, "1 semaine"], [14, "2 semaines"], [21, "3 semaines"], [30, "1 mois"], [60, "2 mois"], [90, "3 mois"]];
const FULL_DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

// Réglages incomplets: on attend que le coach corrige avant d'enregistrer (message dans la pastille)
function problem(x) {
  if (x.availability.some((w) => w.start_time >= w.end_time)) return "dans Disponibilités, la fin doit être après le début.";
  if (x.happy_hours.some((h) => h.start_time >= h.end_time)) return "dans Heures creuses, la fin doit être après le début.";
  if (x.happy_hours.some((h) => !(h.discount_millimes > 0))) return "indiquez la réduction des heures creuses, en dinars.";
  if (!Object.values(x.price_grid ?? {}).some((g) => Object.keys(g).length)) return "proposez au moins une formule et une durée à vos joueurs.";
  if (Object.values(x.price_grid ?? {}).some((g) => Object.values(g).some((v) => v < 20000))) return "le prix d'une séance ne peut pas être inférieur à 20 TND (décochez la durée pour ne pas la proposer).";
  for (const [k, g] of Object.entries(x.vip_price_grid ?? {})) {
    for (const [m, v] of Object.entries(g ?? {})) {
      if (!v) continue; // vide: prix standard
      if (v < 20000) return "un prix VIP ne peut pas être inférieur à 20 TND (laissez vide pour le prix standard).";
      const std = x.price_grid?.[k]?.[m];
      if (std !== undefined && v > std) return `un prix VIP ne peut pas être plus cher que le prix standard (${std / 1000} TND).`;
    }
  }
  return null;
}

export default function Settings({ onBack, sub }) {
  const [s, setS] = useState(() => peek("/booking/settings") ?? null);
  const touched = useRef(false); // le coach a commencé à modifier: les réglages qui arrivent du serveur ne l'écrasent pas
  // Enregistrement automatique (pas de bouton en bas de page): chaque modification part ~0,8 s après la dernière
  // frappe; une pastille en bas de l'écran dit où on en est, et la section modifiée affiche « Enregistré ».
  const [status, setStatus] = useState({ state: "idle" }); // idle | saving | saved | invalid | error
  const [flash, setFlash] = useState(null); // section qui vient d'être enregistrée
  const section = useRef(null); // section en cours de modification
  const dirty = useRef({ settings: false, clubs: false });
  const timer = useRef(null);
  const latest = useRef({});
  const [themes, setThemes] = useState(() => peek("/exercise-themes")?.work ?? []);
  const [cat, setCat] = useState(() => peek("/clubs/catalog") ?? null); // clubs connus + les miens
  const [sel, setSel] = useState(() => peek("/clubs/catalog")?.mine ?? []);
  const [newClubs, setNewClubs] = useState([]);
  const [nc, setNc] = useState({ name: "", phone: "" });
  // Liste VIP: joueurs du coach marqués VIP (prix VIP), modifiée tout de suite
  const [players, setPlayers] = useState(() => peek("/players") ?? []);
  useEffect(() => { api("/players").then(setPlayers).catch(() => {}); }, []);
  const vips = players.filter((p) => p.vip);
  const others = players.filter((p) => !p.vip).sort((a, b) => a.name.localeCompare(b.name));
  const setVip = (p, on) => api(`/players/${p.id}/vip`, { method: "PUT", body: { vip: on } })
    .then((x) => { setPlayers((ps) => ps.map((y) => (y.id === x.id ? { ...y, vip: x.vip } : y))); setStatus({ state: "saved" }); setFlash("vip");
      setTimeout(() => { setFlash((f) => (f === "vip" ? null : f)); setStatus((st) => (st.state === "saved" ? { state: "idle" } : st)); }, 2200); })
    .catch((e) => setStatus({ state: "error", msg: e.message }));
  const loadClubs = () => api("/clubs/catalog").then((c) => { setCat(c); setSel(c.mine); setNewClubs([]); });
  useEffect(() => { loadClubs(); }, []);
  const toggleClub = (n) => { setSel(sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]); changed("clubs"); };
  const addClub = () => {
    if (!nc.name.trim()) return;
    setNewClubs([...newClubs, { ...nc, name: nc.name.trim() }]);
    setNc({ name: "", phone: "" });
    changed("clubs");
  };
  latest.current = { s, sel, newClubs, cat };
  function changed(what = "settings") {
    touched.current = true;
    dirty.current[what] = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 800);
  }
  function edit(next) {
    setS(next);
    changed("settings");
  }
  async function flush() {
    clearTimeout(timer.current);
    const d = { ...dirty.current };
    if (!d.settings && !d.clubs) return;
    const { s: cur, sel: names, newClubs: added, cat: catalog } = latest.current;
    const bad = d.settings && problem(cur);
    if (bad) return setStatus({ state: "invalid", msg: bad }); // rien d'envoyé tant que ce n'est pas corrigé
    dirty.current = { settings: false, clubs: false };
    const where = section.current;
    setStatus({ state: "saving" });
    try {
      if (d.settings) await api("/booking/settings", { method: "PUT", body: cur });
      if (d.clubs && catalog) await api("/clubs/selection", { method: "PUT", body: { names, new: added } }).then(loadClubs);
    } catch (x) {
      dirty.current = { settings: dirty.current.settings || d.settings, clubs: dirty.current.clubs || d.clubs };
      return setStatus({ state: "error", msg: x.message });
    }
    setStatus({ state: "saved" });
    setFlash(where);
    setTimeout(() => { setFlash((f) => (f === where ? null : f)); setStatus((st) => (st.state === "saved" ? { state: "idle" } : st)); }, 2200);
  }
  // en quittant la page: ce qui n'est pas encore parti est enregistré
  useEffect(() => () => { if (dirty.current.settings || dirty.current.clubs) flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api("/booking/settings").then((x) => setS((cur) => (cur && touched.current ? cur : x))); api("/exercise-themes").then((t) => setThemes(t.work)); }, []);
  // Ouvert depuis le guide « Bien démarrer » (#settings/formules…): on va directement à la bonne section, mise en valeur
  useEffect(() => {
    const el = s && sub && document.getElementById(sub);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); el.classList.add("focus-step"); }
  }, [Boolean(s), sub]);
  if (!s) return <><h1>Réglages</h1><Loading rows={3} /></>;

  const setHappy = (i, patch) => edit({ ...s, happy_hours: s.happy_hours.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  const dayWindows = (d) => s.availability.filter((w) => w.weekday === d);
  const setDay = (d, windows) => edit({ ...s, availability: [...s.availability.filter((w) => w.weekday !== d), ...windows.map((w) => ({ ...w, weekday: d }))] });
  const Saved = ({ id }) => (flash === id ? <span className="saved-tag" role="status"><Icon name="check" size={13} /> Enregistré</span> : null);
  const card = (id) => "card" + (flash === id ? " just-saved" : "");

  return (
    <div onInput={() => { touched.current = true; }} onClick={(e) => { if (e.target.closest("button, input, select")) touched.current = true; }}
      onPointerDownCapture={(e) => { section.current = e.target.closest("[data-sec]")?.dataset.sec ?? section.current; }}
      onFocusCapture={(e) => { section.current = e.target.closest("[data-sec]")?.dataset.sec ?? section.current; }}>
      <button className="small sec" onClick={onBack}><Icon name="chevL" size={15} /> Retour</button>
      <h1 style={{ marginTop: 10 }}>Réglages de réservation</h1>
      <p className="mut" style={{ marginTop: -6 }}>Ce que vos joueurs voient dans leur application : créneaux, prix, politique d'annulation. <b>Chaque modification est enregistrée automatiquement.</b></p>

      <h2 id="profil">Ma page publique <Saved id="profil" /></h2>
      <div className={card("profil")} data-sec="profil">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Ce que les joueurs voient quand ils cherchent un coach.</div>
        <label className="field"><span className="mut">Mon nom (affiché aux joueurs)</span><input value={s.name ?? ""} onChange={(e) => edit({ ...s, name: e.target.value })} /></label>
        <label className="field"><span className="mut">Présentation</span>
          <textarea className="msg" rows={4} value={s.bio} onChange={(e) => edit({ ...s, bio: e.target.value })} placeholder="Votre parcours, votre façon d'entraîner, les niveaux que vous accompagnez…" />
        </label>
        <div className="field"><span className="mut">Spécialités</span>
          <div className="chips">
            {themes.map((t) => {
              const on = s.specialties.includes(t);
              return <button type="button" key={t} className={"chip small" + (on ? " on" : "")} aria-pressed={on} onClick={() => edit({ ...s, specialties: on ? s.specialties.filter((x) => x !== t) : [...s.specialties, t] })}>{t}</button>;
            })}
          </div>
        </div>
      </div>

      <MyReviews coachId={s.coach_id} />

      <h2 id="notifications">Notifications</h2>
      <div className="card"><PushToggle /></div>

      <h2 id="clubs">Mes clubs <Saved id="clubs" /></h2>
      <div className={card("clubs")} data-sec="clubs">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Les clubs où vous entraînez : les joueurs vous trouvent en filtrant par club, et vos terrains y sont réservés.</div>
        {cat === null ? <div className="skel" style={{ height: 40 }} /> : (
          <div className="chips">
            {[...cat.mine, ...cat.known.map((k) => k.name)].map((n) => {
              const on = sel.includes(n);
              return <button type="button" key={n} className={"chip small" + (on ? " on" : "")} aria-pressed={on} onClick={() => toggleClub(n)}>{on && <Icon name="check" size={13} />} {n}</button>;
            })}
            {newClubs.map((c, i) => (
              <button type="button" key={"new" + i} className="chip small on" aria-label={`Retirer ${c.name}`} onClick={() => { setNewClubs(newClubs.filter((_, j) => j !== i)); changed("clubs"); }}><Icon name="plus" size={13} /> {c.name}</button>
            ))}
          </div>
        )}
        <div className="newclub">
          <input placeholder="Autre club…" aria-label="Nom du club" value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addClub(); } }} />
          <input placeholder="Téléphone (facultatif)" aria-label="Téléphone du club" inputMode="tel" value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} />
          <button type="button" className="small sec" onClick={addClub}><Icon name="plus" size={15} /> Ajouter</button>
        </div>
      </div>

      <h2 id="formules">Formules : durées et prix par joueur <Saved id="formules" /></h2>
      <div className={card("formules")} data-sec="formules">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Pour chaque formule, cochez les durées que vos joueurs peuvent réserver et fixez le prix par joueur de chacune (pas forcément proportionnel : 1 h à 100 TND, 1 h 30 à 120 TND…). Une formule sans durée n'est pas proposée. Vos propres séances, vous les créez de la durée que vous voulez.</div>
        {Object.entries(KIND).map(([k, v]) => {
          const g = s.price_grid?.[k] ?? {};
          const setG = (next) => edit({ ...s, price_grid: { ...s.price_grid, [k]: next } });
          const toggle = (m) => {
            const { [m]: had, ...rest } = g;
            if (had !== undefined) return setG(rest);
            const ref = Object.entries(g)[0]; // prix de départ: au prorata d'une durée déjà fixée
            setG({ ...g, [m]: ref ? Math.round((ref[1] * +m) / +ref[0]) : 0 });
          };
          return (
            <div className="formula grid" key={k}>
              <span className="formula-name"><Icon name={v.icon} size={16} /> <b>{v.label}</b> <span className="mut">· {v.short}</span></span>
              <span className="chips" role="group" aria-label={`Durées ${v.label}`}>
                {["60", "90"].map((m) => <button key={m} type="button" className={"chip small" + (g[m] !== undefined ? " on" : "")} aria-pressed={g[m] !== undefined} onClick={() => toggle(m)}>{m === "60" ? "1 h" : "1 h 30"}</button>)}
              </span>
              {["60", "90"].filter((m) => g[m] !== undefined).map((m) => (
                <span key={m} className="inputunit"><em>{m === "60" ? "1 h" : "1 h 30"}</em><MoneyInput label={`Prix ${v.label} ${m === "60" ? "1 h" : "1 h 30"}`} value={g[m]} onChange={(x) => setG({ ...g, [m]: x })} /><em>TND</em></span>
              ))}
              {!Object.keys(g).length && <small className="mut">Pas proposé aux joueurs</small>}
            </div>
          );
        })}
      </div>

      <h2 id="vip">Prix VIP <Saved id="vip" /></h2>
      <div className={card("vip")} data-sec="vip">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Un prix à part pour les joueurs de votre liste VIP, pour chaque formule et durée que vous proposez. Laissez vide : ils paient le prix standard.</div>
        {Object.entries(KIND).map(([k, v]) => {
          const std = s.price_grid?.[k] ?? {};
          const g = s.vip_price_grid?.[k] ?? {};
          if (!Object.keys(std).length) return null;
          return (
            <div className="formula grid" key={k}>
              <span className="formula-name"><Icon name={v.icon} size={16} /> <b>{v.label}</b></span>
              {["60", "90"].filter((m) => std[m] !== undefined).map((m) => (
                <span key={m} className="inputunit"><em>{m === "60" ? "1 h" : "1 h 30"}</em>
                  <MoneyInput label={`Prix VIP ${v.label} ${m === "60" ? "1 h" : "1 h 30"}`} value={g[m] ?? 0} placeholder={String(std[m] / 1000)}
                    onChange={(x) => edit({ ...s, vip_price_grid: { ...s.vip_price_grid, [k]: { ...g, [m]: x } } })} /><em>TND</em></span>
              ))}
            </div>
          );
        })}
        <div className="field" style={{ marginTop: 10 }}>
          <span className="mut">Liste VIP ({vips.length})</span>
          <div className="chips">
            {vips.map((p) => (
              <button type="button" key={p.id} className="chip small on" aria-label={`Retirer ${p.name} de la liste VIP`} onClick={() => setVip(p, false)}>
                <Icon name="star" size={13} /> {p.name} <Icon name="x" size={12} />
              </button>
            ))}
            {!vips.length && <span className="mut small-p">Aucun joueur VIP pour l'instant.</span>}
          </div>
          {others.length > 0 && (
            <select aria-label="Ajouter un joueur VIP" value="" style={{ marginTop: 8 }} onChange={(e) => { const p = others.find((x) => x.id === +e.target.value); if (p) setVip(p, true); }}>
              <option value="">+ Ajouter un joueur VIP…</option>
              {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      </div>

      <h2>Heures creuses <Saved id="heures" /></h2>
      <div className={card("heures")} data-sec="heures">
        <div className="mut small-p" style={{ marginBottom: 8 }}>Réduction automatique, en dinars par joueur, sur les nouvelles séances qui commencent dans ces plages (toutes formules).</div>
        {s.happy_hours.map((h, i) => (
          <div className="happy" key={i}>
            <select aria-label="Jour" value={h.weekday} onChange={(e) => setHappy(i, { weekday: +e.target.value })}>{DAYS.map((d, j) => <option key={j} value={j}>{d}</option>)}</select>
            <ClockPicker label="Heures creuses · début" value={h.start_time} onChange={(v) => setHappy(i, { start_time: v })} />
            <ClockPicker label="Heures creuses · fin" value={h.end_time} onChange={(v) => setHappy(i, { end_time: v })} />
            <span className="inputunit"><em>−</em><MoneyInput label="Réduction par joueur" value={h.discount_millimes || 0} onChange={(m) => setHappy(i, { discount_millimes: m, discount_pct: 0 })} /><em>TND</em></span>
            <button className="small sec iconbtn" aria-label="Supprimer ces heures creuses" onClick={() => edit({ ...s, happy_hours: s.happy_hours.filter((_, j) => j !== i) })}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {!s.happy_hours.length && <div className="mut">Aucune heure creuse.</div>}
        <button className="small sec" style={{ marginTop: 8 }} onClick={() => edit({ ...s, happy_hours: [...s.happy_hours, { weekday: 0, start_time: "10:00", end_time: "12:00", discount_millimes: 10000 }] })}><Icon name="plus" size={15} /> Ajouter des heures creuses</button>
      </div>

      <h2 id="reservation">Créneaux proposés aux joueurs <Saved id="reservation" /></h2>
      <div className={card("reservation")} data-sec="reservation">
        <div className="field"><span className="mut">Les joueurs réservent au plus</span>
          <div className="chips" role="group" aria-label="Limite de réservation à l'avance">
            {HORIZONS.map(([d, l]) => <button key={d} type="button" className={"chip small" + ((s.booking_horizon_days ?? 14) === d ? " on" : "")} aria-pressed={(s.booking_horizon_days ?? 14) === d} onClick={() => edit({ ...s, booking_horizon_days: d })}>{l}</button>)}
          </div>
          <small className="mut">à l'avance (jamais plus de 3 mois).</small>
        </div>
        <label className="check mode">
          <input type="checkbox" checked={s.avoid_gaps !== false} onChange={(e) => edit({ ...s, avoid_gaps: e.target.checked })} aria-label="Éviter les trous de moins d'1 h" />
          <span><b>Éviter les trous de moins d'1 h</b><span className="mut small-p" style={{ display: "block" }}>
            {s.avoid_gaps !== false
              ? "Les joueurs ne voient que les horaires qui ne laissent pas de bout de terrain inutilisable (terrain 10 h-12 h : 1 h à 10 h ou 11 h, pas d'1 h 30)."
              : "Tous les horaires sont proposés (terrain 10 h-12 h : 1 h 30 à 10 h possible). Chaque demande qui laisse un bout de terrain trop court vous l'indique (« 30 min de terrain resteront inutilisables »)."}
          </span></span>
        </label>
        {[["terrains", "Seulement sur mes terrains réservés", "Les joueurs ne voient que les heures où vous avez un terrain libre (Planning › Terrains). Recommandé : tout ce qui est réservé a un terrain."],
          ["disponibilites", "Sur toutes mes disponibilités", "Les joueurs voient toutes vos plages ci-dessous ; vous réservez le terrain après leur demande."]].map(([k, l, d]) => (
          <label key={k} className="check mode">
            <input type="radio" name="booking_mode" checked={(s.booking_mode ?? "terrains") === k} onChange={() => edit({ ...s, booking_mode: k })} />
            <span><b>{l}</b><span className="mut small-p" style={{ display: "block" }}>{d}</span></span>
          </label>
        ))}
      </div>

      <h2>Validation et annulation <Saved id="validation" /></h2>
      <div className={card("validation")} data-sec="validation">
        <div className={"autoconfirm" + (s.auto_confirm ? " on" : "")}>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={s.auto_confirm} onChange={(e) => edit({ ...s, auto_confirm: e.target.checked })} />
            <b>Validation automatique des réservations</b>
          </label>
          {s.auto_confirm ? (
            <p className="small-p warn-txt" style={{ margin: "8px 0 0" }}>
              <Icon name="alert" size={14} /> Attention : un joueur pourra réserver directement, sans votre confirmation, dès qu'un de vos terrains réservés couvre le créneau. La séance s'ajoute alors à votre planning et le joueur reçoit sa confirmation.
            </p>
          ) : (
            <p className="mut small-p" style={{ margin: "8px 0 0" }}>Désactivée : chaque demande de réservation attend votre accord dans l'onglet Demandes (le joueur est prévenu dès que vous acceptez).</p>
          )}
        </div>
        <div style={{ height: 10 }} />
        <div className="mut">Annulation par le joueur : jusqu'à 24 h avant pour une séance seul, 48 h avant à deux ou en groupe (crédits rendus). Après ce délai, il ne peut plus annuler mais peut envoyer un lien pour se faire remplacer.</div>
      </div>

      <h2 id="disponibilites">Disponibilités <Saved id="disponibilites" /></h2>
      <div className={card("disponibilites")} data-sec="disponibilites">
        <div className="mut small-p" style={{ marginBottom: 4 }}>Vos heures de travail, jour par jour (format 24 h). Touchez une heure pour la changer.</div>
        {DAYS.map((name, d) => {
          const ws = dayWindows(d);
          const pos = (t) => ((+t.slice(0, 2) + +t.slice(3, 5) / 60) / 24) * 100;
          return (
            <div key={d} className="dayrow">
              <div className="row">
                <label className="check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ws.length > 0} onChange={(e) => setDay(d, e.target.checked ? [{ start_time: "09:00", end_time: "13:00" }, { start_time: "15:00", end_time: "21:00" }] : [])} />
                  <b>{FULL_DAYS[d]}</b>
                </label>
                {ws.length === 0 ? <span className="mut small-p">Fermé</span>
                  : <button type="button" className="link small-p" onClick={() => edit({ ...s, availability: [0, 1, 2, 3, 4, 5, 6].flatMap((x) => ws.map((w) => ({ ...w, weekday: x }))) })}>Copier sur tous les jours</button>}
              </div>
              {ws.length > 0 && (
                <>
                  <div className="dayline" aria-hidden="true">{ws.map((w, i) => <i key={i} style={{ left: `${pos(w.start_time)}%`, width: `${Math.max(pos(w.end_time) - pos(w.start_time), 1)}%` }} />)}</div>
                  <div className="dayticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
                  {ws.map((w, i) => (
                    <div className="window" key={i}>
                      <ClockPicker label={`${FULL_DAYS[d]} · début`} value={w.start_time} onChange={(v) => setDay(d, ws.map((x, j) => (j === i ? { ...x, start_time: v } : x)))} />
                      <Icon name="arrowR" size={16} />
                      <ClockPicker label={`${FULL_DAYS[d]} · fin`} value={w.end_time} onChange={(v) => setDay(d, ws.map((x, j) => (j === i ? { ...x, end_time: v } : x)))} />
                      {w.start_time >= w.end_time && <span className="err small-p" style={{ margin: 0 }}>La fin doit être après le début</span>}
                      <button type="button" className="small sec iconbtn" aria-label="Retirer cette plage" onClick={() => setDay(d, ws.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
                    </div>
                  ))}
                  <button type="button" className="link small-p" style={{ marginTop: 6 }} onClick={() => setDay(d, [...ws, { start_time: "17:00", end_time: "21:00" }])}><Icon name="plus" size={13} /> Ajouter une plage</button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {/* État de l'enregistrement automatique, toujours visible en bas de l'écran */}
      {status.state !== "idle" && (
        <div className={"autosave " + status.state} role={status.state === "invalid" || status.state === "error" ? "alert" : "status"}>
          {status.state === "saving" && <><span className="spin" aria-hidden="true" /> Enregistrement…</>}
          {status.state === "saved" && <><Icon name="checkCircle" size={16} /> Modifications enregistrées</>}
          {status.state === "invalid" && <><Icon name="alert" size={16} /> Pas encore enregistré : {status.msg}</>}
          {status.state === "error" && <><Icon name="alert" size={16} /> {status.msg} <button className="link" onClick={() => { dirty.current.settings = true; flush(); }}>Réessayer</button></>}
        </div>
      )}

      <h2 id="araignee">Araignée : critères d'évaluation</h2>
      <CriteriaEditor url="/criteria" intro="Ce que vous notez de 0 à 10 pour vos joueurs (3 à 12 critères). Chaque joueur peut aussi avoir les siens, depuis sa fiche." reset="Revenir aux standards" />
    </div>
  );
}
