import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { refreshSession } from "./api.js";
import "./style.css";

// Installation sur l'écran d'accueil: on garde l'événement pour proposer le bouton au bon moment
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__installEvt = e;
  window.dispatchEvent(new Event("installable"));
});

// Mode hors-ligne (production seulement): voir public/sw.js
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// Nouvelle version déployée: l'appli restée ouverte (téléphone en veille, onglet en arrière-plan) se met à jour
// toute seule. On compare le script chargé avec celui de la page servie; la mise à jour se fait au retour dans
// l'appli, ou toutes les 5 minutes si personne n'est en train de saisir quelque chose.
if (import.meta.env.PROD) {
  const current = () => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute("src");
  const check = async (onlyIfIdle) => {
    if (document.visibilityState !== "visible") return;
    if (onlyIfIdle && document.activeElement?.matches("input, textarea, select")) return;
    try {
      const html = await (await fetch("/", { cache: "no-store" })).text();
      const latest = html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/)?.[1];
      if (latest && current() && latest !== current()) location.reload();
    } catch { /* hors ligne: on réessaiera */ }
  };
  document.addEventListener("visibilitychange", () => check(false));
  window.addEventListener("focus", () => check(false));
  setInterval(() => check(true), 5 * 60000);
}

createRoot(document.getElementById("root")).render(<App />);
refreshSession(); // « Rester connecté »: la connexion est prolongée à chaque ouverture
