import { useEffect, useRef, useState } from "react";
const TZ = "Africa/Tunis";

export const getToken = () => localStorage.getItem("token");
export const setToken = (t) => {
  if (t) return localStorage.setItem("token", t);
  const admin = localStorage.getItem("admin_token");
  if (admin) { // l'administrateur quitte l'espace qu'il avait ouvert: il retrouve son compte
    localStorage.setItem("token", admin);
    localStorage.setItem("role", "coach");
    localStorage.removeItem("admin_token");
    localStorage.removeItem("admin_label");
    location.hash = "admin";
    return;
  }
  localStorage.removeItem("token");
  localStorage.removeItem("role");
  window.caches?.delete("api"); // données hors-ligne du compte précédent
};
export const getRole = () => localStorage.getItem("role") || "coach";
export const setSession = (r) => { setToken(r.token); localStorage.setItem("role", r.role); };

// Administrateur: ouvrir l'espace d'un coach ou d'un joueur (tous ses droits), puis revenir
export const actingAs = () => localStorage.getItem("admin_label");
export function actAs(r) {
  if (!localStorage.getItem("admin_token")) localStorage.setItem("admin_token", getToken());
  localStorage.setItem("admin_label", r.label);
  setSession(r);
  location.hash = "";
  location.reload();
}
export function stopActing() {
  setToken(null); // rend la main au compte administrateur
  location.reload();
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: { "Content-Type": "application/json", ...(getToken() && { Authorization: `Bearer ${getToken()}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Pas de connexion internet. Réessayez une fois connecté.");
  }
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


// Données toujours à jour sans bouton « recharger »: toutes les 15 s tant que l'appli est affichée,
// et tout de suite quand on y revient (téléphone rallumé, retour sur l'onglet, connexion retrouvée).
export function useLive(load, ms = 15000) {
  const ref = useRef(load);
  ref.current = load;
  useEffect(() => {
    const run = () => {
      if (document.visibilityState !== "visible") return;
      try { Promise.resolve(ref.current()).catch(() => {}); } catch { /* hors ligne: on réessaiera */ }
    };
    const t = setInterval(run, ms);
    document.addEventListener("visibilitychange", run);
    window.addEventListener("focus", run);
    window.addEventListener("online", run);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("focus", run);
      window.removeEventListener("online", run);
    };
  }, [ms]);
}


// Pendant la saisie d'un joueur: e-mail ou téléphone déjà utilisés ? (vérifié un instant après la frappe)
export function useContactCheck(email, phone, exclude) {
  const [errs, setErrs] = useState({ email: null, phone: null });
  useEffect(() => {
    const digits = (phone || "").replace(/\D/g, "");
    const mail = (email || "").includes("@") ? email.trim() : "";
    const tel = digits.length >= 8 ? phone : ""; // numéro complet seulement
    if (!mail && !tel) { setErrs({ email: null, phone: null }); return undefined; }
    const t = setTimeout(() => {
      const q = new URLSearchParams({ email: mail, phone: tel, ...(exclude ? { exclude } : {}) });
      api(`/players/check?${q}`).then(setErrs).catch(() => {});
    }, 450);
    return () => clearTimeout(t);
  }, [email, phone, exclude]);
  return errs;
}
