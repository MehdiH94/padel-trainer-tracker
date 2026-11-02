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

// Message d'erreur compréhensible, jamais un simple code (« Erreur 422 »)
const BY_STATUS = {
  400: "Demande incorrecte. Vérifiez les informations saisies.",
  401: "Identifiants incorrects ou session expirée. Reconnectez-vous.",
  403: "Vous n'avez pas le droit de faire cette action.",
  404: "Élément introuvable : il a peut-être été supprimé. Rechargez la page.",
  409: "Cette action n'est plus possible : les informations ont changé entre-temps. Rechargez la page.",
  413: "Fichier ou texte trop volumineux.",
  422: "Certaines informations sont invalides. Vérifiez le formulaire.",
  429: "Trop de tentatives. Patientez une minute puis réessayez.",
};
function explain(status, detail) {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length) return detail.map((d) => d.msg?.replace(/^Value error, /, "") ?? String(d)).join(" ");
  if (status >= 500) return "Le serveur a rencontré un problème. Réessayez dans un instant ; si cela continue, prévenez l'administrateur.";
  return BY_STATUS[status] ?? "Action impossible pour le moment. Réessayez.";
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
    throw new Error(explain(res.status, e.detail));
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

// Format d'e-mail (vérifié pendant la saisie, avant l'envoi): message en clair, ou null si correct
export const emailProblem = (v) => (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? "Adresse e-mail invalide : elle doit être de la forme nom@exemple.com." : null);
