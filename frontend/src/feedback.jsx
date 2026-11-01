import { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";

// Retours à l'utilisateur sans les fenêtres grises du navigateur:
//   toast("Paiement enregistré")                       message court en bas de l'écran
//   toast("Séance effectuée", { action: ["Annuler", fn] })   avec un bouton (ex. annuler l'action)
//   if (await confirmDialog({ title, message, confirm: "Oui", danger: true })) …
let listeners = [];
let state = { toasts: [], dialog: null };
const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l(state)); };
let nextId = 1;

export function toast(message, { kind = "ok", action = null, ms = 4000 } = {}) {
  const id = nextId++;
  emit({ toasts: [...state.toasts, { id, message, kind, action }].slice(-3) });
  setTimeout(() => dismiss(id), action ? Math.max(ms, 6000) : ms);
}
const dismiss = (id) => emit({ toasts: state.toasts.filter((t) => t.id !== id) });
export const toastError = (x) => toast(x?.message ?? String(x), { kind: "ko", ms: 5000 });

export function confirmDialog({ title, message = "", confirm = "Confirmer", cancel = "Retour", danger = false }) {
  return new Promise((resolve) => emit({ dialog: { title, message, confirm, cancel, danger, resolve } }));
}

// Fenêtre modale réutilisable: fermeture avec Échap ou en touchant à côté, focus placé dedans.
export function Modal({ onClose, label, children }) {
  const box = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    box.current?.querySelector("input, button, select, textarea")?.focus();
    const key = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); prev?.focus?.(); };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="card sheet" role="dialog" aria-modal="true" aria-label={label} ref={box}>{children}</div>
    </div>
  );
}

export function FeedbackHost() {
  const [s, setS] = useState(state);
  useEffect(() => { listeners.push(setS); return () => { listeners = listeners.filter((l) => l !== setS); }; }, []);
  const d = s.dialog;
  const close = (v) => { d.resolve(v); emit({ dialog: null }); };
  return (
    <>
      <div className="toasts" role="status" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind}>
            <Icon name={t.kind === "ko" ? "alert" : "checkCircle"} size={18} />
            <span>{t.message}</span>
            {t.action && <button className="small" onClick={() => { dismiss(t.id); t.action[1](); }}>{t.action[0]}</button>}
          </div>
        ))}
      </div>
      {d && (
        <Modal onClose={() => close(false)} label={d.title}>
          <b className="sheet-title">{d.title}</b>
          {d.message && <p className="mut">{d.message}</p>}
          <div className="actions">
            <button className="sec" onClick={() => close(false)}>{d.cancel}</button>
            <button className={d.danger ? "danger-solid" : ""} onClick={() => close(true)}>{d.confirm}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
