// Parcours réels de l'application, sur téléphone, avec les données de démo.
import { expect, test as base } from "@playwright/test";

// Chaque test échoue si une erreur JavaScript apparaît dans la page
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await use(page);
    expect(errors, "erreurs JavaScript dans la page").toEqual([]);
  },
});

async function login(page, email, password = "demo1234") {
  await page.goto("/");
  await page.locator("input[type=email]").fill(email);
  await page.locator("input[type=password]").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
}

const nav = (page, name) => page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name });

test("le coach parcourt tous ses écrans", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await expect(page.getByRole("heading", { name: "Bonjour coach" })).toBeVisible();

  await nav(page, "Planning").click();
  await expect(page.getByRole("heading", { name: "Planning" })).toBeVisible();
  await page.getByRole("tab", { name: "Semaine" }).click();
  await expect(page.getByRole("grid", { name: "Séances de la semaine" })).toBeVisible();

  await page.getByRole("button", { name: /Terrains/ }).click();
  await expect(page.getByRole("grid", { name: "Calendrier des terrains de la semaine" })).toBeVisible();
  await expect(page.locator(".cal-block").first()).toBeVisible();

  await nav(page, "Joueurs").click();
  await expect(page.getByText("Sami Ben Ali")).toBeVisible();
  await nav(page, "Demandes").click();
  await expect(page.getByRole("heading", { name: "Demandes" })).toBeVisible();
  await nav(page, "Relances").click();
  await page.getByRole("button", { name: "Réglages" }).click();
  await expect(page.getByRole("heading", { name: "Réglages" })).toBeVisible();
});

test("le coach ajoute un élève, qui s'inscrit avec le lien pré-rempli", async ({ page, browser }) => {
  await login(page, "demo@padel.tn");
  await nav(page, "Joueurs").click();
  await page.getByRole("button", { name: "Joueur", exact: true }).click(); // bouton flottant « + Joueur »
  const form = page.locator("form.card");
  await form.locator("input").first().fill("Lina Test");
  // saisies invalides: explication en clair sous le champ, pas de code d'erreur
  await form.locator("input[inputmode=tel]").fill("12 345 678 9");
  await expect(form.getByText(/il faut 8 chiffres/)).toBeVisible();
  await form.locator("input[type=email]").fill("lina.gmail.com");
  await expect(form.getByText(/forme nom@exemple.com/)).toBeVisible();
  await expect(form.getByRole("button", { name: "Ajouter le joueur" })).toBeDisabled();
  await form.locator("input[inputmode=tel]").fill("55 600 700");
  await form.locator("input[type=email]").fill("sami@demo.tn"); // déjà pris: refusé pendant la saisie
  await expect(form.getByText(/déjà celle de Sami Ben Ali/)).toBeVisible();
  await expect(form.getByRole("button", { name: "Ajouter le joueur" })).toBeDisabled();
  await form.locator("input[type=email]").fill("");
  await form.getByRole("button", { name: "Ajouter le joueur" }).click();
  const link = await page.getByLabel("Lien d'inscription").inputValue();

  const player = await (await browser.newContext()).newPage();
  await player.goto(link);
  await expect(player.getByRole("heading", { name: "Bienvenue Lina !" })).toBeVisible();
  await expect(player.getByLabel("Nom complet")).toHaveValue("Lina Test"); // fiche pré-remplie par le coach
  await player.getByLabel("Votre e-mail").fill("lina.test@demo.tn");
  await player.getByLabel(/Mot de passe/).fill("secret1");
  await player.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(player.getByText("Mes crédits, coach par coach")).toBeVisible();
  await player.close();

  await page.reload();
  await expect(page.locator(".card", { hasText: "Lina Test" }).getByText("compte actif")).toBeVisible();
});

test("le joueur ne peut plus annuler hors délai mais peut se faire remplacer", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await expect(page.getByText("Mes crédits, coach par coach")).toBeVisible();
  await page.getByRole("button", { name: "Mes séances" }).click();
  await page.locator(".late-btn").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Trop tard pour annuler")).toBeVisible();
  await dialog.getByRole("button", { name: "Me faire remplacer" }).click();
  await expect(dialog.getByLabel("Lien de la séance")).toHaveValue(/\/remplacer\//);
});

test("la validation du coach arrive chez le joueur sans recharger la page", async ({ page, browser }) => {
  await login(page, "sami@demo.tn");
  await page.getByRole("button", { name: "Mes séances" }).click();
  await expect(page.getByText("En attente du coach").first()).toBeVisible();
  const waiting = await page.getByText("En attente du coach").count();

  const coach = await (await browser.newContext()).newPage();
  await login(coach, "demo@padel.tn");
  await nav(coach, "Demandes").click();
  const request = coach.locator(".card", { hasText: "Sami Ben Ali" }).filter({ has: coach.getByRole("button", { name: /Accepter/ }) }).first();
  await request.getByRole("button", { name: /Accepter/ }).first().click();
  await coach.close();

  // aucune action du joueur: la page se met à jour toute seule (rafraîchissement toutes les 15 s)
  await expect(page.getByText("En attente du coach")).toHaveCount(waiting - 1, { timeout: 25_000 });
});

test("l'administrateur ouvre l'espace d'un coach puis revient", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await page.getByRole("button", { name: /Administration/ }).click();
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await page.getByRole("button", { name: "Coachs" }).click();
  await page.getByRole("button", { name: "Ouvrir l'espace de Youssef Mansouri" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Mode administrateur" })).toContainText("Youssef Mansouri");
  await page.getByRole("button", { name: "Revenir à l'administration" }).click();
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(page.getByText("Mode administrateur")).toHaveCount(0);
});

test("rester connecté: coché, on retrouve son espace en rouvrant l'appli; décoché, il faut se reconnecter", async ({ page, context }) => {
  await login(page, "demo@padel.tn"); // case cochée par défaut
  await expect(page.getByRole("heading", { name: "Bonjour coach" })).toBeVisible();
  const again = await context.newPage(); // nouvel onglet = appli rouverte
  await again.goto("/");
  await expect(again.getByRole("heading", { name: "Bonjour coach" })).toBeVisible();
  await again.close();

  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.locator("input[type=email]").fill("demo@padel.tn");
  await page.locator("input[type=password]").fill("demo1234");
  await page.getByLabel("Rester connecté sur cet appareil").uncheck();
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByRole("heading", { name: "Bonjour coach" })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("button", { name: "Se connecter" })).toBeVisible();
  await other.close();
});
