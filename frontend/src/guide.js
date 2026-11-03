// Guide « Bien démarrer » du coach: étapes calculées d'après ses données (elles se cochent toutes seules).
import { accountKey, api } from "./api.js";

const key = (name) => `${name}-${accountKey()}`; // un guide par compte coach (plusieurs coachs sur un même appareil)

export function guideSteps(settings, players, sessions) {
  const courtsMode = (settings.booking_mode ?? "terrains") === "terrains";
  return [
    { key: "profil", label: "Mon profil : nom et présentation", ok: Boolean(settings.name?.trim() && settings.bio?.trim()), to: "settings/profil",
      hint: "Ce que les joueurs voient quand ils choisissent un coach : présentez-vous et vos spécialités.",
      bravo: "Votre profil est prêt : les joueurs savent maintenant qui vous êtes." },
    { key: "clubs", label: "Mes clubs", ok: settings.clubs_count > 0, to: "settings/clubs",
      hint: "Les clubs où vous entraînez : les joueurs vous trouvent en filtrant par club.",
      bravo: "Vos clubs sont enregistrés : les joueurs vous trouveront en cherchant leur club." },
    { key: "formules", label: "Mes formules : durée et prix", ok: Boolean(settings.price_individuel || settings.price_duo || settings.price_groupe), to: "settings/formules",
      hint: "Seul, à deux, en groupe : la durée d'une séance et le prix par joueur pour chaque formule.",
      bravo: "Vos formules et vos prix sont en place : ils s'appliquent à toutes vos séances." },
    courtsMode
      ? { key: "creneaux", label: "Ouvrir des créneaux : ajouter mes terrains", ok: settings.free_courts > 0, to: "courts",
        hint: "Ajoutez les terrains que vous avez réservés (une fois ou chaque semaine) : les joueurs réservent dans ces créneaux.",
        bravo: "Vos premiers créneaux sont ouverts : les joueurs peuvent déjà réserver." }
      : { key: "creneaux", label: "Ouvrir des créneaux : mes disponibilités", ok: settings.availability.length > 0, to: "settings/disponibilites",
        hint: "Vos jours et heures de travail : les joueurs réservent dans ces plages, vous réservez le terrain ensuite.",
        bravo: "Vos disponibilités sont en ligne : les joueurs peuvent déjà réserver." },
    { key: "eleve", label: "Ajouter mon premier élève", ok: players.length > 0, to: "players",
      hint: "Touchez « + Joueur » : il reçoit un lien pour créer son compte, sa fiche déjà remplie.",
      bravo: "Votre premier élève est ajouté ! Envoyez-lui son lien pour qu'il crée son compte." },
    { key: "seance", label: "Planifier ma première séance", ok: sessions.length > 0, to: "planning",
      hint: "Créez une séance depuis le planning (bouton « + Séance »), ou attendez la première réservation d'un joueur.",
      bravo: "Votre première séance est au planning." },
  ];
}

export const guideHidden = () => { try { return localStorage.getItem(key("guide-masque")) === "1"; } catch { return false; } };
export const hideGuide = () => { try { localStorage.setItem(key("guide-masque"), "1"); } catch { /* stockage indisponible */ } };

export async function loadGuide() {
  const [settings, players, sessions] = await Promise.all([api("/booking/settings"), api("/players"), api("/sessions")]);
  return guideSteps(settings, players, sessions);
}

// Étapes terminées depuis la dernière vérification (mémorisées sur l'appareil); null au premier passage
export function newlyDone(steps) {
  const done = steps.filter((s) => s.ok).map((s) => s.key);
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(key("guide-done")) || "null"); localStorage.setItem(key("guide-done"), JSON.stringify(done)); } catch { /* stockage indisponible */ }
  return prev ? steps.filter((s) => s.ok && !prev.includes(s.key)) : [];
}
