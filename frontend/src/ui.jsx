import { useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { Modal, toastError } from "./feedback.jsx";
import { api, disablePush, enablePush, pushState } from "./api.js";

const COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#db2777", "#ea580c", "#0d9488", "#4f46e5", "#be123c"];

export function Avatar({ name = "?", size = 36 }) {
  const initials = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const color = COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}>{initials}</span>
  );
}

export function AvatarStack({ names, size = 30 }) {
  return (
    <span className="stack">
      {names.slice(0, 4).map((n, i) => <Avatar key={i} name={n} size={size} />)}
      {names.length > 4 && <span className="avatar more" style={{ width: size, height: size }}>+{names.length - 4}</span>}
    </span>
  );
}

export const KIND = {
  individuel: { label: "Individuel", short: "1 joueur", color: "#2563eb", icon: "user", cap: 1 },
  duo: { label: "Duo", short: "2 joueurs", color: "#0891b2", icon: "users", cap: 2 },
  groupe: { label: "Groupe", short: "3 à 4 joueurs", color: "#7c3aed", icon: "users", cap: 4 },
};

export const STATUS = { prevue: "Prévue", effectuee: "Effectuée", annulee: "Annulée" };
export const METHOD = { especes: "Espèces", virement: "Virement", carte: "Carte", cheque: "Chèque", credits: "Crédits" }; // moyens de paiement

// Classement: tranches de l'entrée de gamme (P25) au plus fort (P1000), chacune en bas « - » / haut « + »
export const TIERS = ["P25", "P50", "P100", "P250", "P500", "P1000"];
export const CATEGORIES = TIERS.flatMap((t) => [t + "-", t + "+"]);
export const tierOf = (c) => (c || "").replace(/[+-]$/, "");
// Affichage: vrai signe moins (P500−) pour ne pas le confondre avec un tiret; libellé long pour les listes
export const catLabel = (c) => (c || "").replace(/-$/, "−");
export const catOption = (c) => `${catLabel(c)} · ${c.endsWith("+") ? "haut" : "bas"} de ${tierOf(c)}`;
export const GENDERS = { M: "Hommes", F: "Dames" };
const CAT_COLOR = { P25: "#0d9488", P50: "#64748b", P100: "#0284c7", P250: "#2563eb", P500: "#7c3aed", P1000: "#db2777" };

export function CategoryBadge({ category, gender }) {
  return (
    <span className="cat" style={{ background: (CAT_COLOR[tierOf(category)] ?? "#64748b") + "1f", color: CAT_COLOR[tierOf(category)] ?? "#64748b" }}>
      {catLabel(category)}{gender && <small> {gender === "F" ? "Dames" : "Hommes"}</small>}
    </span>
  );
}

export const COURT_STATUS = {
  a_envoyer: { label: "SMS à envoyer", cls: "idle" },
  en_attente: { label: "Club prévenu · en attente", cls: "wait" },
  confirmee: { label: "Terrain confirmé", cls: "ok" },
  refusee: { label: "Terrain refusé", cls: "ko" },
};

// Histogramme SVG simple: data = [{label, value}]
// data = [{label, sub?, value}]: label sous la colonne (« S1 », « nov »), sub en plus petit (« 1–7 »)
export function BarChart({ data, format = (v) => v, color = "var(--brand)" }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const W = 320, H = 130, bw = W / data.length;
  const subs = data.some((d) => d.sub);
  return (
    <svg viewBox={`0 0 ${W} ${H + 34 + (subs ? 14 : 0)}`} width="100%" role="img">
      {data.map((d, i) => {
        const h = Math.max((d.value / max) * H, d.value ? 3 : 0);
        // colonne de la période en cours (current) en plein, les autres un peu plus claires; sans repère: toutes pleines
        const last = data.some((x) => x.current) ? d.current : true;
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={H - h + 16} width={bw * 0.64} height={h} rx="5" fill={color} opacity={last ? 1 : 0.55} />
            {d.value > 0 && <text x={i * bw + bw / 2} y={H - h + 10} textAnchor="middle" fontSize="11" style={{ fill: "var(--txt)" }}>{format(d.value)}</text>}
            <text x={i * bw + bw / 2} y={H + 30} textAnchor="middle" fontSize="11" fontWeight="600" style={{ fill: "var(--mut)" }}>{d.label}</text>
            {d.sub && <text x={i * bw + bw / 2} y={H + 44} textAnchor="middle" fontSize="9.5" style={{ fill: "var(--mut)" }}>{d.sub}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// Graphique en araignée: skills = [{stroke, score, previous}], notes de 0 à 10 (critères du coach, en nombre libre).
export function RadarChart({ skills, size = 320 }) {
  const short = { "Défense fond de court": "Défense", "Retour de service": "Retour", "Sortie de vitre": "Vitre" };
  const items = skills.map((s) => ({ ...s, label: short[s.stroke] ?? s.stroke }));
  const n = items.length, c = size / 2, R = size / 2 - 58;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [c + Math.cos(a) * R * (v / 10), c + Math.sin(a) * R * (v / 10)];
  };
  const poly = (vals) => vals.map((v, i) => pt(i, v ?? 0).join(",")).join(" ");
  const hasPrev = items.some((s) => s.previous != null);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label="Évaluation technique" className="radar">
      {[2, 4, 6, 8, 10].map((lv) => (
        <polygon key={lv} points={items.map((_, i) => pt(i, lv).join(",")).join(" ")} style={{ fill: lv % 4 === 2 ? "var(--soft)" : "none", stroke: "var(--line)" }} strokeWidth="1" />
      ))}
      {items.map((_, i) => <line key={i} x1={c} y1={c} x2={pt(i, 10)[0]} y2={pt(i, 10)[1]} style={{ stroke: "var(--line)" }} />)}
      {hasPrev && <polygon points={poly(items.map((s) => s.previous ?? s.score))} fill="#94a3b822" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 3" />}
      <polygon points={poly(items.map((s) => s.score))} fill="#f9731633" stroke="#f97316" strokeWidth="2.5" strokeLinejoin="round" />
      {items.map((s, i) => {
        if (s.score == null) return null;
        const [x, y] = pt(i, s.score);
        return <circle key={i} cx={x} cy={y} r="4" fill="#f97316" style={{ stroke: "var(--card)" }} strokeWidth="1.5" />;
      })}
      {items.map((s, i) => {
        const [x, y] = pt(i, 11.9);
        const anchor = x < c - 8 ? "end" : x > c + 8 ? "start" : "middle";
        return <text key={s.stroke} x={x} y={y + 3} textAnchor={anchor} fontSize="11" fontWeight="600" style={{ fill: "var(--txt)" }}>{s.label}</text>;
      })}
    </svg>
  );
}

// Plusieurs araignées superposées (une par coach, couleurs --s1…--s4) et, au besoin, leur moyenne
export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];
export function averageSkills(list) {
  const names = [...new Set(list.flatMap((x) => x.skills.map((s) => s.stroke)))];
  return names.map((stroke) => {
    const v = list.map((x) => x.skills.find((s) => s.stroke === stroke)?.score).filter((v) => v != null);
    return { stroke, score: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null };
  });
}
export function MultiRadar({ series, size = 320 }) {
  const short = { "Défense fond de court": "Défense", "Retour de service": "Retour", "Sortie de vitre": "Vitre" };
  const names = [...new Set(series.flatMap((x) => x.skills.map((s) => s.stroke)))];
  const n = Math.max(names.length, 3), c = size / 2, R = size / 2 - 58;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [c + Math.cos(a) * R * (v / 10), c + Math.sin(a) * R * (v / 10)];
  };
  const score = (x, st) => x.skills.find((s) => s.stroke === st)?.score;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label={"Évaluation technique : " + series.map((x) => x.label).join(", ")} className="radar">
      {[2, 4, 6, 8, 10].map((lv) => (
        <polygon key={lv} points={names.map((_, i) => pt(i, lv).join(",")).join(" ")} style={{ fill: lv % 4 === 2 ? "var(--soft)" : "none", stroke: "var(--line)" }} strokeWidth="1" />
      ))}
      {names.map((_, i) => <line key={i} x1={c} y1={c} x2={pt(i, 10)[0]} y2={pt(i, 10)[1]} style={{ stroke: "var(--line)" }} />)}
      {series.map((x) => (
        <g key={x.label}>
          <polygon points={names.map((st, i) => pt(i, score(x, st) ?? 0).join(",")).join(" ")} style={{ fill: x.color, stroke: x.color }} fillOpacity={series.length > 1 ? 0.1 : 0.2} strokeWidth={x.dashed ? 2 : 2.5} strokeDasharray={x.dashed ? "5 4" : undefined} strokeLinejoin="round" />
          {names.map((st, i) => {
            const v = score(x, st);
            if (v == null) return null;
            const [px, py] = pt(i, v);
            return <circle key={st} cx={px} cy={py} r="3.5" style={{ fill: x.color, stroke: "var(--card)" }} strokeWidth="1.5" />;
          })}
        </g>
      ))}
      {names.map((st, i) => {
        const [x, y] = pt(i, 11.9);
        const anchor = x < c - 8 ? "end" : x > c + 8 ? "start" : "middle";
        return <text key={st} x={x} y={y + 3} textAnchor={anchor} fontSize="11" fontWeight="600" style={{ fill: "var(--txt)" }}>{short[st] ?? st}</text>;
      })}
    </svg>
  );
}

export function Progress({ value, max, danger }) {
  return (
    <div className="bar"><div style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: danger ? "var(--red)" : "var(--brand)" }} /></div>
  );
}

// Boutons d'envoi pré-remplis: ouvrent l'app SMS / WhatsApp / e-mail du téléphone avec le message prêt.
export function ContactLinks({ phone, email, message, subject = "", onSent }) {
  const digits = (phone || "").replace(/\D/g, "");
  const enc = encodeURIComponent;
  return (
    <div className="actions">
      {phone ? <>
        <a className="btnlink" href={`sms:${phone}?body=${enc(message)}`} onClick={() => onSent?.("sms")}><Icon name="message" size={16} /> SMS</a>
        <a className="btnlink wa" href={`https://wa.me/${digits}?text=${enc(message)}`} target="_blank" rel="noreferrer" onClick={() => onSent?.("whatsapp")}><Icon name="whatsapp" size={16} /> WhatsApp</a>
      </> : <span className="btnlink off"><Icon name="phone" size={16} /> Pas de téléphone</span>}
      {email ? (
        <a className="btnlink" href={`mailto:${email}?subject=${enc(subject)}&body=${enc(message)}`} onClick={() => onSent?.("email")}><Icon name="mail" size={16} /> E-mail</a>
      ) : (
        <span className="btnlink off"><Icon name="mail" size={16} /> Pas d'e-mail</span>
      )}
    </div>
  );
}

export function ago(iso) {
  const d = new Date(iso.endsWith("Z") || /[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return "aujourd'hui";
  return days === 1 ? "hier" : `il y a ${days} j`;
}

// Moyens de contact pour les rappels automatiques de séance (24 h et 2 h avant)
export const CHANNELS = { whatsapp: ["WhatsApp", "whatsapp"], sms: ["SMS", "message"], email: ["E-mail", "mail"] };

export function ChannelPicker({ value, onChange }) {
  return (
    <div className="channels">
      {Object.entries(CHANNELS).map(([k, [label, icon]]) => (
        <button type="button" key={k} className={value === k ? "on" : ""} onClick={() => onChange(k)}><Icon name={icon} size={17} /> {label}</button>
      ))}
    </div>
  );
}

// Blocs gris pendant le chargement (au lieu d'un écran blanc)
export function Loading({ rows = 3, hero = false }) {
  return (
    <div aria-busy="true" aria-label="Chargement">
      {hero && <div className="skel skel-hero" />}
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skel" style={{ height: i ? 76 : 110 }} />)}
    </div>
  );
}

// Proposition d'installer l'application sur l'écran d'accueil (Android: bouton; iPhone: explication)
export function InstallCard() {
  const [evt, setEvt] = useState(window.__installEvt ?? null);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem("install-dismissed") === "1"; } catch { return false; } });
  useEffect(() => {
    const f = () => setEvt(window.__installEvt);
    window.addEventListener("installable", f);
    return () => window.removeEventListener("installable", f);
  }, []);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (hidden || standalone || (!evt && !ios)) return null;
  const close = () => { try { localStorage.setItem("install-dismissed", "1"); } catch { /* stockage indisponible */ } setHidden(true); };
  const install = async () => { evt.prompt(); await evt.userChoice; window.__installEvt = null; close(); };
  return (
    <div className="card install">
      <span className="kpi-ico"><Icon name="download" size={20} /></span>
      <div style={{ flex: 1 }}>
        <b>Installer l'application</b>
        <div className="mut">{evt ? "Accès direct depuis l'écran d'accueil, même avec peu de réseau." : "Dans Safari : bouton Partager, puis « Sur l'écran d'accueil »."}</div>
        {evt && <button className="small" style={{ marginTop: 8 }} onClick={install}>Installer</button>}
      </div>
      <button className="small sec iconbtn" aria-label="Ne plus proposer" onClick={close}><Icon name="x" size={15} /></button>
    </div>
  );
}

// Bandeau hors connexion: les écrans déjà ouverts restent consultables
export function OfflineBar() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  if (online) return null;
  return <div className="offline" role="status"><Icon name="wifiOff" size={16} /> Hors connexion · données du dernier chargement</div>;
}

// Choix d'une heure au format 24 h (pas de AM/PM), par pas de 30 min, aux heures où l'on joue au padel
export const HOURS = Array.from({ length: 36 }, (_, i) => { const m = 6 * 60 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 ? "30" : "00"}`; }); // 06:00 → 23:30
export function TimeSelect({ value, onChange, label, min, max, ...rest }) {
  const list = HOURS.filter((h) => (!min || h >= min) && (!max || h <= max));
  const opts = list.includes(value) || !value ? list : [...list, value].sort();
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {opts.map((h) => <option key={h} value={h}>{h.replace(":", " h ").replace(" h 00", " h")}</option>)}
    </select>
  );
}

// Choix d'une date en toutes lettres (« mar. 3 nov. 2026 »): le champ date natif s'affiche au format du téléphone (ex. 11/02/2026)
const ymdTunis = (d) => d.toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
export function DateSelect({ value, onChange, label, from = 0, to = 180, ...rest }) {
  const days = Array.from({ length: to - from + 1 }, (_, i) => ymdTunis(new Date(Date.now() + (from + i) * 86400000)));
  const opts = days.includes(value) || !value ? days : [value, ...days];
  const fmt = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {opts.map((d) => <option key={d} value={d}>{d === days[-from] && from <= 0 ? "Aujourd'hui · " : ""}{fmt(d)}</option>)}
    </select>
  );
}

// Nom d'un joueur toujours suivi de son niveau (first = prénom seulement)
export function PlayerTag({ p, first }) {
  if (!p) return null;
  return <span className="ptag">{first ? p.name.split(" ")[0] : p.name} {p.category && <CategoryBadge category={p.category} />}</span>;
}

export function PlayerTags({ ids, byId, first, empty = "Aucun joueur" }) {
  const ps = ids.map(byId).filter(Boolean);
  if (!ps.length) return <span className="mut">{empty}</span>;
  return <span className="ptags">{ps.map((p) => <PlayerTag key={p.id} p={p} first={first} />)}</span>;
}

// Lieu de la séance: club et terrain
export function Where({ s, light }) {
  if (!s.club && !s.court) return null;
  return (
    <span className={"where" + (light ? " light" : "")}>
      <Icon name="pin" size={12} /> {s.club || "Club à préciser"} · {s.court || "terrain à préciser"}
    </span>
  );
}

// Code court et lisible pour chaque club (calendriers): « Padel Club La Marsa » → MARSA, « Gammarth Padel » → GAMMA…
// Mots génériques ignorés; en cas de doublon, on allonge le code.
const CLUB_STOP = new Set(["padel", "club", "center", "centre", "arena", "sport", "sports", "de", "du", "des", "la", "le", "les", "l", "d", "el", "et", "the"]);
export function clubCodes(names) {
  const uniq = [...new Set(names.filter(Boolean))];
  const words = (n) => {
    const w = n.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const kept = w.filter((x) => !CLUB_STOP.has(x.toLowerCase()));
    return kept.length ? kept : w;
  };
  const code = (n, len) => {
    const w = words(n);
    return w.length === 1 ? w[0].slice(0, len) : w.map((x) => x.slice(0, Math.max(1, len - 3))).join("").slice(0, len + 1);
  };
  const out = {};
  for (let len = 5; len <= 12; len++) {
    uniq.forEach((n) => { out[n] = code(n, len); });
    if (new Set(Object.values(out)).size === uniq.length) break;
  }
  return out;
}

// Montant en TND (valeur en millimes): champ vide au lieu de « 0 » (le 0 ne reste plus collé devant le chiffre tapé),
// virgule ou point acceptés, 3 décimales au plus.
export function MoneyInput({ value, onChange, label, ...rest }) {
  const fmt = (m) => (m ? String(m / 1000) : "");
  const [txt, setTxt] = useState(fmt(value));
  useEffect(() => {
    if (Math.round((parseFloat(txt.replace(",", ".")) || 0) * 1000) !== (value || 0)) setTxt(fmt(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input inputMode="decimal" placeholder="0" aria-label={label} value={txt} {...rest}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const t = e.target.value.replace(/\s/g, "");
        if (!/^\d*[.,]?\d{0,3}$/.test(t)) return;
        setTxt(t);
        onChange(Math.round((parseFloat(t.replace(",", ".")) || 0) * 1000));
      }} />
  );
}

// Heure au format 24 h (« 08 h 30 »): un bouton qui ouvre une grille d'heures (00 à 23) puis de minutes, plus simple
// qu'une longue liste déroulante.
const pad = (n) => String(n).padStart(2, "0");
export const hLabel = (v) => (v ? `${v.slice(0, 2)} h ${v.slice(3, 5)}` : "--");
export function ClockPicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(value?.slice(0, 2) ?? "09");
  const pick = (m) => { onChange(`${h}:${m}`); setOpen(false); };
  return (
    <>
      <button type="button" className="clockbtn" aria-label={`${label} : ${hLabel(value)}`} onClick={() => { setH(value?.slice(0, 2) ?? "09"); setOpen(true); }}>
        <Icon name="clock" size={15} /> {hLabel(value)}
      </button>
      {open && (
        <ClockModal label={label} h={h} setH={setH} pick={pick} current={value} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ClockModal({ label, h, setH, pick, current, onClose }) {
  return (
    <Modal onClose={onClose} label={label}>
      <div className="row"><b className="sheet-title">{label}</b><button type="button" className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <div className="mut small-p">1. L'heure</div>
      <div className="clockgrid">
        {Array.from({ length: 24 }, (_, i) => pad(i)).map((x) => (
          <button type="button" key={x} className={"clockcell" + (x === h ? " on" : "")} onClick={() => setH(x)}>{x}</button>
        ))}
      </div>
      <div className="mut small-p" style={{ marginTop: 8 }}>2. Les minutes</div>
      <div className="clockgrid mins">
        {["00", "15", "30", "45"].map((m) => (
          <button type="button" key={m} className={"clockcell" + (current === `${h}:${m}` ? " on" : "")} onClick={() => pick(m)}>{h} h {m}</button>
        ))}
      </div>
    </Modal>
  );
}

// Même règle que le serveur (constants.compatible), en crans de demi-tranche (P250- → P250+ = 1 cran):
// même sexe = un cran d'écart au plus; une joueuse et un homme = l'homme a 1 à 3 crans de moins qu'elle.
const stepOf = (c) => { const i = CATEGORIES.indexOf(TIERS.includes(c) ? c + "-" : c); return i < 0 ? CATEGORIES.indexOf("P100-") : i; };
export function compatible(a, b) {
  const x = stepOf(a.category), y = stepOf(b.category);
  if ((a.gender || "M") === (b.gender || "M")) return Math.abs(x - y) <= 1;
  const [woman, man] = a.gender === "F" ? [x, y] : [y, x];
  return woman - 3 <= man && man <= woman - 1;
}
// Paires de joueurs dont les niveaux ne sont pas censés se mélanger
export const levelClashes = (ps) => ps.flatMap((a, i) => ps.slice(i + 1).filter((b) => !compatible(a, b)).map((b) => [a, b]));

// Montant en dinars, court (« 20 TND », « 12,500 TND »): réductions, heures creuses
export const dinars = (m) => (m % 1000 === 0 ? `${m / 1000} TND` : `${(m / 1000).toFixed(3).replace(".", ",")} TND`);
// Réduction affichée: en dinars (heures creuses, promotions), ou en % pour les anciennes données
export const reduction = (x) => (x.discount_millimes ? `−${dinars(x.discount_millimes)}` : x.discount_pct ? `−${x.discount_pct} %` : "");
export const OFFS = [5000, 10000, 15000, 20000, 30000]; // réductions proposées (millimes)

// Note sur 10 au demi-point (« 7,5 »)
export const note10 = (v) => (v == null ? "–" : String(Math.round(v * 10) / 10).replace(".", ","));

// Araignée notée critère par critère: une jauge à la fois (0 à 10, pas de 0,5), flèche pour revenir au précédent,
// nombre de critères restants. La note est enregistrée en passant au critère suivant (ou en touchant « Terminer »).
// skills = [{stroke, score, previous}] (critères du joueur), onSaved: après chaque enregistrement.
export function SkillSliders({ playerId, skills, onSaved }) {
  const [vals, setVals] = useState(() => Object.fromEntries(skills.map((s) => [s.stroke, s.score])));
  const [i, setI] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => { setVals(Object.fromEntries(skills.map((s) => [s.stroke, s.score]))); }, [skills.map((s) => s.stroke + s.score).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!skills.length) return null;
  const cur = skills[Math.min(i, skills.length - 1)];
  const v = vals[cur.stroke];
  const left = skills.length - i - 1;
  const commit = () => {
    if (v == null || v === cur.score) return Promise.resolve();
    return api(`/players/${playerId}/skills`, { method: "POST", body: { stroke: cur.stroke, value: Math.round(v * 10) } })
      .then(() => onSaved?.()).catch(toastError);
  };
  const go = (n) => commit().then(() => { if (i + n >= skills.length) setDone(true); else setI(Math.max(0, i + n)); });
  if (done) return (
    <div className="stepper done">
      <Icon name="checkCircle" size={22} /> <b>Araignée à jour</b>
      <button type="button" className="link" onClick={() => { setDone(false); setI(0); }}>Revoir les critères</button>
    </div>
  );
  return (
    <div className="stepper">
      <div className="stepper-top">
        <button type="button" className="small sec iconbtn" aria-label="Critère précédent" disabled={i === 0} onClick={() => go(-1)}><Icon name="chevL" size={16} /></button>
        <span className="mut small-p">Critère {i + 1} / {skills.length} · {left ? `${left} restant${left > 1 ? "s" : ""}` : "dernier"}</span>
        <span className="stepper-dots" aria-hidden="true">{skills.map((s, k) => <i key={s.stroke} className={k === i ? "on" : vals[s.stroke] != null ? "set" : ""} />)}</span>
      </div>
      <label className="slider-row">
        <span className="slider-head"><b className="stepper-name">{cur.stroke}</b><span className={"slider-val" + (v == null ? " none" : "")}>{note10(v)}<small>/10</small></span></span>
        <input type="range" min="0" max="10" step="0.5" value={v ?? 0} aria-label={`${cur.stroke} : note sur 10`}
          className={v == null ? "unset" : ""} style={{ "--p": `${(v ?? 0) * 10}%` }}
          onChange={(e) => setVals({ ...vals, [cur.stroke]: +e.target.value })} />
      </label>
      {cur.previous != null && <div className="mut small-p">Avant : {note10(cur.previous)}/10</div>}
      <button type="button" style={{ width: "100%", marginTop: 8 }} onClick={() => go(1)}>{left ? <>Suivant <Icon name="chevR" size={16} /></> : <><Icon name="check" size={16} /> Terminer</>}</button>
    </div>
  );
}

// Glisser le doigt horizontalement (téléphone): vers la gauche = suivant, vers la droite = précédent.
// Retourne les gestionnaires à poser sur la zone; un défilement vertical ne déclenche rien.
export function swipe(onNext, onPrev) {
  let x0 = null, y0 = null;
  return {
    onTouchStart: (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; },
    onTouchEnd: (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? onNext : onPrev)?.();
    },
  };
}

// Regroupe une série jour par jour en semaines de 7 jours (à partir du 1er jour): S1 = du 1 au 7, etc.
// days = [{key: "AAAA-MM-JJ", …}], pick(x) = valeur du jour. Retour: [{label: "S1", sub: "1–7", value}]
export function byWeek(days, pick) {
  const out = [];
  const today = new Date().toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  days.forEach((x, i) => {
    const w = Math.floor(i / 7);
    const d = +x.key.slice(8, 10);
    if (!out[w]) out[w] = { label: `S${w + 1}`, from: d, to: d, value: 0, current: false };
    out[w].to = d;
    out[w].value += pick(x);
    out[w].current ||= x.key === today; // semaine en cours mise en avant
  });
  return out.map((w) => ({ label: w.label, sub: w.from === w.to ? `${w.from}` : `${w.from}–${w.to}`, value: Math.round(w.value * 10) / 10, current: w.current }));
}

// Téléphone à l'inscription: numéros tunisiens seulement (8 chiffres, +216 affiché devant)
export const tnDigits = (v) => (v || "").replace(/[\s.\-()]/g, "").replace(/^(\+216|00216)/, "");
export const tnPhoneProblem = (v) => (!tnDigits(v) ? "Indiquez votre numéro de téléphone tunisien."
  : /^\d{8}$/.test(tnDigits(v)) ? null : "Numéro tunisien uniquement : 8 chiffres (ex. 22 123 456).");
export function PhoneTN({ value, onChange, label = "Téléphone (numéro tunisien)" }) {
  const [seen, setSeen] = useState(false); // erreur affichée après la saisie, pas pendant
  const problem = tnPhoneProblem(value);
  const show = problem && (seen || tnDigits(value).replace(/\D/g, "").length > 8 || /[^\d\s.\-()+]/.test(value));
  return (
    <label className="field">
      <span className="mut">{label}</span>
      <span className="inputunit phone-tn"><em>+216</em>
        <input inputMode="tel" autoComplete="tel-national" placeholder="22 123 456" value={value}
          onChange={(e) => onChange(e.target.value)} onBlur={() => setSeen(true)} required aria-invalid={!!show} aria-label={label} />
      </span>
      {show ? <small className="err" role="alert">{problem}</small> : <small className="mut">Seuls les numéros tunisiens sont acceptés.</small>}
    </label>
  );
}

// Bouton « Notifications sur ce téléphone » (joueur et coach)
export function PushToggle() {
  const [state, setState] = useState("…");
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setState).catch(() => setState("unsupported")); }, []);
  const flip = async () => {
    setBusy(true);
    try { if (state === "on") await disablePush(); else await enablePush(); setState(await pushState()); }
    catch (x) { toastError(x); }
    setBusy(false);
  };
  if (state === "ios-install") return <p className="mut small-p"><Icon name="bell" size={13} /> Sur iPhone, ajoutez d'abord l'application à l'écran d'accueil (Safari › Partager › Sur l'écran d'accueil), puis ouvrez-la depuis l'icône pour activer les notifications.</p>;
  if (state === "unsupported") return <p className="mut small-p"><Icon name="bell" size={13} /> Ce navigateur ne reçoit pas les notifications : vous recevez tout par e-mail.</p>;
  if (state === "denied") return <p className="mut small-p"><Icon name="bell" size={13} /> Notifications bloquées : autorisez-les pour Padel Boost dans les réglages du téléphone.</p>;
  return (
    <label className="check" style={{ margin: 0 }}>
      <input type="checkbox" checked={state === "on"} disabled={busy || state === "…"} onChange={flip} />
      <span><b>Notifications sur ce téléphone</b><span className="mut small-p" style={{ display: "block" }}>Confirmations, places libérées, rappels : en plus de l'e-mail.</span></span>
    </label>
  );
}
