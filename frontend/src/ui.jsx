import Icon from "./Icon.jsx";

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

// Classement: de l'entrée de gamme (P50) au plus fort (P1000)
export const CATEGORIES = ["P50", "P100", "P250", "P500", "P1000"];
export const GENDERS = { M: "Hommes", F: "Dames" };
const CAT_COLOR = { P50: "#64748b", P100: "#0284c7", P250: "#2563eb", P500: "#7c3aed", P1000: "#db2777" };

export function CategoryBadge({ category, gender }) {
  return (
    <span className="cat" style={{ background: CAT_COLOR[category] + "1f", color: CAT_COLOR[category] }}>
      {category}{gender && <small> {gender === "F" ? "Dames" : "Hommes"}</small>}
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
export function BarChart({ data, format = (v) => v, color = "#2563eb" }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const W = 320, H = 130, bw = W / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 34}`} width="100%" role="img">
      {data.map((d, i) => {
        const h = Math.max((d.value / max) * H, d.value ? 3 : 0);
        const last = i === data.length - 1;
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={H - h + 16} width={bw * 0.64} height={h} rx="5" fill={color} opacity={last ? 1 : 0.35} />
            {d.value > 0 && <text x={i * bw + bw / 2} y={H - h + 10} textAnchor="middle" fontSize="10" fill="#0f172a">{format(d.value)}</text>}
            <text x={i * bw + bw / 2} y={H + 30} textAnchor="middle" fontSize="10" fill="#64748b">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// Graphique en araignée: skills = [{stroke, score, previous}], notes de 1 à 5.
export function RadarChart({ skills, size = 320 }) {
  const short = { "Défense fond de court": "Défense", "Retour de service": "Retour", "Sortie de vitre": "Vitre" };
  const items = skills.map((s) => ({ ...s, label: short[s.stroke] ?? s.stroke }));
  const n = items.length, c = size / 2, R = size / 2 - 58;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [c + Math.cos(a) * R * (v / 5), c + Math.sin(a) * R * (v / 5)];
  };
  const poly = (vals) => vals.map((v, i) => pt(i, v ?? 0).join(",")).join(" ");
  const hasPrev = items.some((s) => s.previous != null);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label="Évaluation technique" className="radar">
      {[1, 2, 3, 4, 5].map((lv) => (
        <polygon key={lv} points={items.map((_, i) => pt(i, lv).join(",")).join(" ")} fill={lv % 2 ? "#f1f5f9" : "none"} stroke="#e2e8f0" strokeWidth="1" />
      ))}
      {items.map((_, i) => <line key={i} x1={c} y1={c} x2={pt(i, 5)[0]} y2={pt(i, 5)[1]} stroke="#e2e8f0" />)}
      {hasPrev && <polygon points={poly(items.map((s) => s.previous ?? s.score))} fill="#94a3b822" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 3" />}
      <polygon points={poly(items.map((s) => s.score))} fill="#2563eb33" stroke="#2563eb" strokeWidth="2.5" strokeLinejoin="round" />
      {items.map((s, i) => {
        if (s.score == null) return null;
        const [x, y] = pt(i, s.score);
        return <circle key={i} cx={x} cy={y} r="4" fill="#2563eb" stroke="#fff" strokeWidth="1.5" />;
      })}
      {items.map((s, i) => {
        const [x, y] = pt(i, 5.95);
        const anchor = x < c - 8 ? "end" : x > c + 8 ? "start" : "middle";
        return <text key={s.stroke} x={x} y={y + 3} textAnchor={anchor} fontSize="11" fontWeight="600" fill="#334155">{s.label}</text>;
      })}
    </svg>
  );
}

export function Progress({ value, max, danger }) {
  return (
    <div className="bar"><div style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: danger ? "#dc2626" : "#2563eb" }} /></div>
  );
}

// Boutons d'envoi pré-remplis: ouvrent l'app SMS / WhatsApp / e-mail du téléphone avec le message prêt.
export function ContactLinks({ phone, email, message, subject = "", onSent }) {
  const digits = (phone || "").replace(/\D/g, "");
  const enc = encodeURIComponent;
  return (
    <div className="actions">
      <a className="btnlink" href={`sms:${phone}?body=${enc(message)}`} onClick={() => onSent?.("sms")}><Icon name="message" size={16} /> SMS</a>
      <a className="btnlink wa" href={`https://wa.me/${digits}?text=${enc(message)}`} target="_blank" rel="noreferrer" onClick={() => onSent?.("whatsapp")}><Icon name="whatsapp" size={16} /> WhatsApp</a>
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
