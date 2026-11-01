import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
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

createRoot(document.getElementById("root")).render(<App />);
