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
  await expect(page.getByRole("grid", { name: "Calendrier de la semaine : séances et terrains" })).toBeVisible();
  await expect(page.locator(".cal-block").first()).toBeVisible();

  await page.getByRole("button", { name: /Mes terrains/ }).click();
  await expect(page.getByRole("heading", { name: "Mes terrains" })).toBeVisible();

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

test("inscription par le lien public: compte sans coach, qui choisit ensuite son coach", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Joueur ? Créer mon compte" }).click();
  await expect(page.getByRole("heading", { name: "Créer mon compte" })).toBeVisible();
  await page.getByLabel("Nom complet").fill("Yasmine Public");
  await page.getByLabel("Téléphone").fill("55 900 100");
  await page.getByLabel("Votre e-mail").fill("yasmine.public");
  await expect(page.getByText(/forme nom@exemple.com/)).toBeVisible(); // e-mail mal formé, signalé pendant la saisie
  await page.getByLabel("Votre e-mail").fill("yasmine.public@demo.tn");
  await page.getByLabel(/Mot de passe/).fill("secret1");
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(page.getByText("Choisissez votre coach")).toBeVisible();
  await page.getByRole("button", { name: "Réserver", exact: true }).click();
  const coachs = page.locator("select", { has: page.locator("option", { hasText: "Tous les coachs" }) });
  await expect(coachs).toContainText("Coach Démo"); // tous les coachs sont proposés

  // l'administrateur voit l'inscription (sans coach) et le lien public à partager
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "demo@padel.tn");
  await admin.getByRole("button", { name: /Administration/ }).click();
  await expect(admin.getByLabel("Lien d'inscription public")).toHaveValue(/\/inscription$/);
  await expect(admin.locator(".card", { hasText: "Yasmine Public" }).getByText(/Sans coach/)).toBeVisible();
  await admin.close();
});

test("nouveau coach: le guide « Bien démarrer » mène à chaque réglage et se coche tout seul", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Vous êtes coach ? Créer un compte" }).click();
  await page.getByLabel("Votre nom de coach").fill("Coach Nouveau");
  await page.locator("input[type=email]").fill("nouveau.coach@demo.tn");
  await page.locator("input[type=password]").fill("secret1");
  await page.getByRole("button", { name: "Créer mon compte coach" }).click();
  const guide = page.locator(".onboard");
  await expect(guide).toContainText("Bienvenue Coach ! Configurons votre espace");
  await expect(guide).toContainText("0/6");
  await guide.getByRole("button", { name: /Mon profil/ }).click();
  await expect(page.locator("#profil")).toBeInViewport();
  await page.getByLabel("Présentation").fill("Coach diplômé, tous niveaux.");
  await page.getByLabel("Prix Individuel").fill("60");
  await page.getByLabel("Prix Individuel").fill("060"); // le 0 de départ ne reste pas collé: « 60 »
  await expect(page.getByLabel("Prix Individuel")).toHaveValue("060");
  await page.getByRole("button", { name: /Enregistrer/ }).click();
  // étape terminée: message de félicitations, puis retour au guide
  const bravo = page.getByRole("dialog", { name: "Étape terminée" });
  await expect(bravo).toContainText("Bravo, une étape de plus !");
  await expect(bravo).toContainText("2 étapes sur 6");
  await bravo.getByRole("button", { name: "Continuer le guide" }).click();
  await expect(page.locator(".onboard")).toContainText("2/6"); // profil et formules cochés
  await expect(page.locator(".onboard .step.next")).toContainText("Mes clubs");
  // « Joueurs » n'est mis en évidence que lorsque c'est l'étape en cours (ici, ce sont les clubs)
  await expect(page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: "Joueurs" })).not.toHaveClass(/hint-pulse/);
  // premier élève: un seul bouton pour l'ajouter, puis le lien à envoyer avant de reprendre le guide (pas de fenêtre « Bravo » qui le cache)
  await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: "Joueurs" }).click();
  await expect(page.getByText("Ajoutez votre premier élève")).toBeVisible();
  await expect(page.getByRole("button", { name: /Ajouter un élève/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Joueur", exact: true }).click();
  const form = page.locator("form.card");
  await form.locator("input").first().fill("Premier Élève");
  await form.locator("input[inputmode=tel]").fill("55 321 654");
  await form.getByRole("button", { name: "Ajouter le joueur" }).click();
  await expect(page.getByLabel("Lien d'inscription")).toHaveValue(/\/invite\//);
  await expect(page.getByRole("dialog", { name: "Étape terminée" })).toHaveCount(0);
  await page.getByRole("button", { name: "Copier" }).click();
  await expect(page.getByText("Lien copié dans votre presse-papiers !")).toBeVisible();
  await page.getByRole("button", { name: /continuer le guide/ }).click();
  await expect(page.locator(".onboard")).toContainText("3/6");
});

test("réserver: choisir une heure précise remplace la période (matin, soir…)", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.getByRole("button", { name: "Réserver", exact: true }).click();
  await page.getByRole("button", { name: "Soir" }).click();
  await page.getByLabel("Heure idéale (facultatif)").selectOption("10");
  await expect(page.getByRole("button", { name: "Soir" })).toHaveCount(0); // la période n'est plus proposée
  await page.getByLabel("Heure idéale (facultatif)").selectOption("");
  await expect(page.getByRole("button", { name: "Toute la journée" })).toBeVisible();
});

test("nouvelle séance: le prix vient des réglages, seule une promotion peut le baisser", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: "Planning" }).click();
  await page.getByRole("button", { name: "Séance" }).click();
  const form = page.locator("form.card");
  await expect(form.getByText("Prix par joueur")).toBeVisible();
  await expect(form.locator("input[type=number][step='0.001']")).toHaveCount(0); // plus de prix libre
  const before = await form.locator(".pricebox b").innerText();
  await form.getByLabel("Promotion (facultatif)").selectOption("20");
  await expect(form.locator(".pricebox s")).toHaveText(before.trim()); // ancien prix barré
});

test("disponibilités: heures au format 24 h choisies dans une grille", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await page.goto("/#settings/disponibilites");
  const start = page.getByRole("button", { name: /^Lundi · début/ }).first();
  await expect(start).toBeVisible();
  await start.click();
  const clock = page.getByRole("dialog", { name: "Lundi · début" });
  await clock.getByRole("button", { name: "08", exact: true }).click();
  await clock.getByRole("button", { name: "08 h 30" }).click();
  await expect(page.getByRole("button", { name: /^Lundi · début : 08 h 30/ }).first()).toBeVisible();
});

test("un seul calendrier: créer une séance sur un terrain libre, le formulaire confirme que le terrain est réservé", async ({ page, request }) => {
  // terrain libre créé pour le test (les données de démo peuvent déjà être prises par les autres parcours)
  const { token } = await (await request.post("/api/auth/login", { data: { email: "demo@padel.tn", password: "demo1234" } })).json();
  const headers = { Authorization: `Bearer ${token}` };
  const [club] = await (await request.get("/api/clubs", { headers })).json();
  const day = new Date(Date.now() + 2 * 86400000).toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const r = await request.post("/api/court-bookings/manual", { headers, data: { club_id: club.id, start: `${day}T06:00:00+01:00`, duration_min: 120, court_label: "Terrain test" } });
  expect(r.ok()).toBeTruthy();

  await login(page, "demo@padel.tn");
  await page.goto("/#planning/semaine");
  const legend = page.locator(".cal-legend");
  await expect(legend).toContainText("Terrain + joueurs au complet");
  await expect(legend).toContainText("Joueurs sans terrain réservé");
  if ([1, 2].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) await page.getByRole("button", { name: "Semaine suivante" }).click(); // dans 2 jours = semaine suivante
  await page.locator(".cal-block.libre", { hasText: "6–8" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Créer une séance sur ce terrain" }).click();
  await expect(page.getByText("C'est bon : un terrain est déjà réservé pour ce créneau")).toBeVisible();
});
