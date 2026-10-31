const TZ = "Africa/Tunis";

export const getToken = () => localStorage.getItem("token");
export const setToken = (t) => (t ? localStorage.setItem("token", t) : (localStorage.removeItem("token"), localStorage.removeItem("role")));
export const getRole = () => localStorage.getItem("role") || "coach";
export const setSession = (r) => { setToken(r.token); localStorage.setItem("role", r.role); };

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(getToken() && { Authorization: `Bearer ${getToken()}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/")) {
    setToken(null);
    location.reload();
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(typeof e.detail === "string" ? e.detail : "Erreur " + res.status);
  }
  return res.json();
}

// Les montants sont en millimes (entiers); le TND s'affiche avec 3 décimales.
export const tnd = (m) => (m / 1000).toFixed(3).replace(".", ",") + " TND";

const asUtc = (iso) => (/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
export const toDate = (iso) => new Date(asUtc(iso));
export const shortDate = (iso) =>
  toDate(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: TZ });
export const hhmm = (iso) =>
  new Date(asUtc(iso)).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
export const dayLabel = (iso) =>
  new Date(asUtc(iso)).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
export const dayKey = (iso) => new Date(asUtc(iso)).toLocaleDateString("fr-CA", { timeZone: TZ });
