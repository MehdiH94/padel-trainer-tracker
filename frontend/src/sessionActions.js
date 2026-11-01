import { api, dayLabel, hhmm } from "./api.js";
import { confirmDialog, toast, toastError } from "./feedback.jsx";

const patch = (s, status) => api(`/sessions/${s.id}`, { method: "PATCH", body: { status } });

// « Effectuée », avec la possibilité d'annuler l'action pendant quelques secondes
export async function markDone(s, reload) {
  try {
    await patch(s, "effectuee");
    reload();
    toast("Séance marquée effectuée", {
      action: ["Annuler", () => patch(s, "prevue").then(() => { reload(); toast("Séance remise en « prévue »"); }).catch(toastError)],
    });
  } catch (x) {
    toastError(x);
  }
}

// Annulation: toujours confirmée (remboursement des crédits, SMS au club)
export async function cancelSession(s, reload) {
  const ok = await confirmDialog({
    title: `Annuler la séance de ${hhmm(s.start)} ?`,
    message: "Les joueurs qui ont payé avec leurs crédits seront remboursés" + (s.club_id ? " et le club sera prévenu par SMS" : "") + ". Cette action est définitive.",
    confirm: "Annuler la séance", cancel: "Garder la séance", danger: true,
  });
  if (!ok) return;
  try {
    await patch(s, "annulee");
    reload();
    toast("Séance annulée");
  } catch (x) {
    toastError(x);
  }
}

// Même séance (joueurs, club, prix) une semaine plus tard
export async function duplicateNextWeek(s, reload) {
  const start = new Date(new Date(s.start.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s.start) ? s.start : s.start + "Z").getTime() + 7 * 86400000).toISOString();
  const keep = ["duration_min", "kind", "level", "club", "club_id", "court", "price_millimes", "price_mode", "player_ids", "open"];
  try {
    await api("/sessions", { method: "POST", body: { ...Object.fromEntries(keep.map((k) => [k, s[k]])), start } });
    reload?.();
    toast(`Séance copiée au ${dayLabel(start)} à ${hhmm(start)}`);
  } catch (x) {
    toastError(x);
  }
}

// Bouton d'action d'une séance: choisit la bonne action selon le statut demandé
export const sessionStatus = (sessions, reload) => (id, status) => {
  const s = sessions.find((x) => x.id === id);
  return status === "effectuee" ? markDone(s, reload) : cancelSession(s, reload);
};
