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
  // le calendrier est la vue par défaut; toucher un jour l'affiche en grand
  await expect(page.getByRole("tab", { name: "Calendrier" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("grid", { name: "Calendrier de la semaine : séances et terrains" })).toBeVisible();
  await expect(page.locator(".cal-block").first()).toBeVisible();
  await page.locator(".cal-head .cal-day").first().click();
  await expect(page.getByRole("grid", { name: "Calendrier du jour" })).toBeVisible();
  await page.getByRole("button", { name: "Jour suivant" }).click();
  await page.getByRole("button", { name: "Semaine", exact: true }).click();
  await expect(page.getByRole("grid", { name: "Calendrier de la semaine : séances et terrains" })).toBeVisible();
  // on peut avancer jusqu'à 3 mois, pas plus
  const next = page.getByRole("button", { name: "Semaine suivante" });
  for (let i = 0; i < 13; i++) await next.click();
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "Aujourd'hui" }).click();
  await page.getByRole("tab", { name: "Jour par jour" }).click();
  await expect(page.locator(".weekstrip")).toBeVisible();

  await page.getByRole("button", { name: /Mes terrains/ }).click();
  await expect(page.getByRole("heading", { name: "Mes terrains" })).toBeVisible();

  await nav(page, "Joueurs").click();
  await expect(page.getByText("Sami Ben Ali")).toBeVisible();
  await nav(page, "Demandes").click();
  await expect(page.getByRole("heading", { name: "Demandes" })).toBeVisible();
  // Finance remplace Relances: impayés, gagné, argent reçu
  await nav(page, "Finance").click();
  await expect(page.getByRole("heading", { name: "Finance" })).toBeVisible();
  await expect(page.getByText("Impayés (aujourd'hui)")).toBeVisible();
  await page.getByRole("button", { name: "Argent reçu" }).click();
  await expect(page.getByRole("dialog", { name: "Argent reçu" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Fermer" }).click();
  // accueil: les 4 indicateurs s'ouvrent sur un résumé
  await nav(page, "Accueil").click();
  await page.locator(".kpi-btn", { hasText: "Impayés" }).click();
  await expect(page.getByRole("dialog", { name: "Résumé" })).toContainText("Impayés");
  await page.getByRole("dialog").getByRole("button", { name: "Fermer" }).click();
  // fiche joueur: notes générales et araignée en jauges
  await nav(page, "Joueurs").click();
  await page.getByText("Sami Ben Ali").click();
  // araignée critère par critère: « Suivant », flèche pour revenir, critères restants
  await expect(page.getByText(/^Critère 1 \/ \d+ · \d+ restants$/)).toBeVisible();
  await page.getByRole("button", { name: /Suivant/ }).click();
  await expect(page.getByText(/^Critère 2 \//)).toBeVisible();
  await page.getByRole("button", { name: "Critère précédent" }).click();
  await expect(page.getByText(/^Critère 1 \//)).toBeVisible();
  // critères propres à ce joueur
  await page.getByRole("button", { name: "Critères de Sami" }).click();
  await expect(page.getByLabel("Nouveau critère")).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.locator(".notes-area").fill(`Très motivé, travailler la bandeja (${Date.now()})`);
  await page.getByRole("button", { name: "Enregistrer les notes" }).click();
  await expect(page.getByText("Notes enregistrées")).toHaveCount(1); // un seul enregistrement
  await expect(page.getByRole("button", { name: "Enregistré" })).toBeVisible();
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
  await expect(player.getByRole("heading", { name: /^Salut / })).toBeVisible();
  await player.close();

  await page.reload();
  await expect(page.locator(".card", { hasText: "Lina Test" }).getByText("compte actif")).toBeVisible();
});

test("le joueur ne peut plus annuler hors délai mais peut se faire remplacer", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await expect(page.getByRole("heading", { name: /^Salut / })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await page.getByRole("tab", { name: /Liste/ }).click();
  await page.locator(".late-btn").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Trop tard pour annuler")).toBeVisible();
  await dialog.getByRole("button", { name: "Me faire remplacer" }).click();
  await expect(dialog.getByLabel("Lien de la séance")).toHaveValue(/\/remplacer\//);
});

test("la validation du coach arrive chez le joueur sans recharger la page", async ({ page, browser }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await page.getByRole("tab", { name: /Liste/ }).click();
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
  // rien n'est possible avant la confirmation de l'administrateur
  await expect(page.getByText("Confirmation par un administrateur")).toBeVisible();
  await expect(page.getByText("Choisissez votre coach")).toHaveCount(0);

  // l'administrateur voit l'inscription (sans coach) et le lien public à partager, puis la confirme
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "demo@padel.tn");
  await admin.getByRole("button", { name: /Administration/ }).click();
  await expect(admin.getByLabel("Lien d'inscription public")).toHaveValue(/\/inscription$/);
  const card = admin.locator(".card", { hasText: "Yasmine Public" });
  await expect(card.getByText(/Sans coach/)).toBeVisible();
  await card.getByRole("button", { name: /Confirmer/ }).click();
  await expect(admin.getByText(/Inscription de Yasmine Public confirmée/)).toBeVisible();
  await admin.close();

  await page.getByRole("button", { name: "Vérifier maintenant" }).click();
  await expect(page.getByText("Choisissez votre coach")).toBeVisible();
  await page.getByRole("button", { name: "Réserver", exact: true }).click();
  await expect(page.getByRole("group", { name: "Coachs" })).toContainText("Coach Démo"); // tous les coachs sont proposés
});

test("nouveau coach: confirmé par l'administrateur, puis le guide « Bien démarrer » mène à chaque réglage", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Vous êtes coach ? Créer un compte" }).click();
  await page.getByLabel("Votre nom de coach").fill("Coach Nouveau");
  await page.getByLabel("Téléphone").fill("55 444 333");
  await page.locator("input[type=email]").fill("nouveau.coach@demo.tn");
  await page.locator("input[type=password]").fill("secret1");
  await page.getByRole("button", { name: "Créer mon compte coach" }).click();
  // en attente: un administrateur doit confirmer le compte
  await expect(page.getByText("Un administrateur va vérifier et confirmer votre compte", { exact: false })).toBeVisible();
  await expect(page.getByText("C'est fait.")).toHaveCount(0); // e-mail pas encore vérifié: jamais affiché comme fait
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "demo@padel.tn");
  await admin.getByRole("button", { name: /Administration/ }).click();
  const card = admin.locator(".card", { hasText: "Coach Nouveau" });
  await expect(card).toContainText("+21655444333");
  await card.getByRole("button", { name: "Confirmer le coach" }).click();
  await expect(admin.getByText(/Compte de Coach Nouveau confirmé/)).toBeVisible();
  // l'administrateur peut nommer d'autres administrateurs
  await admin.getByRole("button", { name: "Coachs", exact: true }).click();
  await expect(admin.locator(".admin-toggle").first()).toBeVisible();
  await admin.close();
  await page.getByRole("button", { name: "Vérifier maintenant" }).click();
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

test("réserver: choisir une heure précise désélectionne la période (matin, soir…), qui reste affichée", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.getByRole("button", { name: "Réserver", exact: true }).click();
  await page.getByRole("button", { name: "Soir" }).click();
  await page.getByLabel("Heure idéale (facultatif)").selectOption("10");
  // les périodes restent affichées, mais plus aucune n'est sélectionnée
  await expect(page.getByRole("button", { name: "Soir" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Soir" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Toute la journée" })).toHaveAttribute("aria-pressed", "false");
  // choisir une période retire l'heure précise
  await page.getByRole("button", { name: "Matin" }).click();
  await expect(page.getByRole("button", { name: "Matin" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Heure idéale (facultatif)")).toHaveValue("");
});

test("nouvelle séance: le prix vient des réglages, seule une promotion peut le baisser", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: "Planning" }).click();
  await page.getByRole("button", { name: "Séance" }).click();
  const form = page.locator("form.card");
  await expect(form.getByText("Prix par joueur")).toBeVisible();
  await expect(form.locator("input[type=number][step='0.001']")).toHaveCount(0); // plus de prix libre
  const before = await form.locator(".pricebox b").innerText();
  await form.getByLabel("Réduction (facultatif)").selectOption("10000"); // −10 TND par joueur
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
  await page.goto("/#planning");
  if ([1, 2].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) await page.getByRole("button", { name: "Semaine suivante" }).click(); // dans 2 jours = semaine suivante
  // légende: seulement les couleurs présentes dans la semaine affichée
  const legend = page.locator(".cal-legend");
  await expect(legend).toContainText("Terrain réservé, encore aucun joueur");
  await page.locator(".cal-block.libre", { hasText: "6–8" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /Créer un entraînement précis/ }).click();
  await expect(page.getByText("La séance aura lieu sur votre terrain libre")).toBeVisible();
});

test("nouvelle séance: joueurs choisis dans une liste avec leur niveau, avertissement si les niveaux ne vont pas ensemble", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await page.goto("/#planning");
  await page.locator(".fab").click(); // bouton flottant « + Séance »
  const form = page.locator("form.card");
  await form.getByRole("button", { name: "Groupe", exact: true }).click();
  // toucher l'intitulé « Type de séance » ne remet plus Individuel (ticket n°13)
  await form.getByText("Type de séance", { exact: true }).click();
  await expect(form.getByRole("group", { name: "Type de séance" }).getByRole("button", { name: "Groupe" })).toHaveClass(/on/);
  // date libre (dans 40 jours, 7 h): le coach ne peut pas avoir deux séances en même temps
  await form.getByLabel("Date", { exact: true }).selectOption({ index: 100 });
  await form.getByLabel("Heure de début").selectOption("07:00");
  for (const who of ["Hichem", "Mehdi"]) { // P1000- et P100+: trop d'écart
    await form.getByRole("button", { name: /Ajouter un joueur/ }).click();
    await form.getByPlaceholder("Rechercher…").fill(who);
    await form.locator(".picker-row", { hasText: who }).click();
  }
  await expect(form.locator(".picked")).toHaveCount(2);
  await expect(form.locator(".picked .cat").first()).toBeVisible(); // niveau affiché
  await expect(form.getByText(/ne sont pas censés se mélanger/)).toBeVisible();
  await form.getByRole("button", { name: "Enregistrer la séance" }).click();
  const dialog = page.getByRole("dialog", { name: "Niveaux à mélanger ?" });
  await expect(dialog).toContainText("Êtes-vous sûr de vouloir créer la séance ?");
  await dialog.getByRole("button", { name: "Créer quand même" }).click();
  await expect(form).toHaveCount(0); // séance créée, formulaire fermé
});

test("terrain libre: prévenir ses joueurs en heures creuses (−20 TND); absence du coach dans le calendrier", async ({ page, request }) => {
  const { token } = await (await request.post("/api/auth/login", { data: { email: "demo@padel.tn", password: "demo1234" } })).json();
  const headers = { Authorization: `Bearer ${token}` };
  const [club] = await (await request.get("/api/clubs", { headers })).json();
  const day = new Date(Date.now() + 3 * 86400000).toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  expect((await request.post("/api/court-bookings/manual", { headers, data: { club_id: club.id, start: `${day}T07:00:00+01:00`, duration_min: 120, court_label: "Terrain promo" } })).ok()).toBeTruthy();

  await login(page, "demo@padel.tn");
  await page.goto("/#planning");
  if ([1, 2, 3].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) await page.getByRole("button", { name: "Semaine suivante" }).click();
  // vue du jour: le terrain avec son état en clair
  await page.locator(".cal-head .cal-day", { hasText: String(+day.slice(8)) }).click();
  await expect(page.getByRole("grid", { name: "Calendrier du jour" })).toBeVisible();
  await page.locator(".cal-block.libre", { hasText: "7–9" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Prévenir mes joueurs/ }).click();
  const send = page.getByRole("dialog", { name: "Annoncer ce créneau" });
  await send.getByRole("button", { name: "−20 TND" }).click();
  await expect(send.locator("textarea")).toHaveValue(/heures creuses : -20 TND/);
  await send.getByRole("button", { name: /^Prévenir \d+ joueur/ }).click();
  await expect(page.getByText(/joueurs? prévenus?/)).toBeVisible();

  // absence: aujourd'hui, avec une raison, visible dans le calendrier
  await page.getByRole("button", { name: "Semaine", exact: true }).click();
  const back = page.getByRole("button", { name: "Aujourd'hui" }); // seulement quand on n'est pas sur la semaine en cours
  if (await back.count()) await back.click();
  await page.getByRole("button", { name: "Absence" }).click();
  await page.getByLabel("Raison (facultatif)").fill("Vacances");
  await page.getByRole("button", { name: "Enregistrer l'absence" }).click();
  await expect(page.locator(".cal-off", { hasText: "Vacances" })).toBeVisible();
  await expect(page.locator(".cal-legend")).toContainText("Absence");
  await page.locator(".cal-off", { hasText: "Vacances" }).click();
  await page.getByRole("button", { name: "Supprimer cette absence" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".cal-off")).toHaveCount(0);
});

test("installation sur l'écran d'accueil: manifeste avec icônes 192 et 512 (dont maskable) et icône iPhone", async ({ page, request }) => {
  const m = await (await request.get("/manifest.webmanifest")).json();
  const sizes = m.icons.map((i) => i.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  expect(m.icons.some((i) => i.purpose === "maskable")).toBeTruthy();
  for (const i of m.icons) {
    const r = await request.get(i.src);
    expect(r.ok()).toBeTruthy();
    expect(r.headers()["content-type"]).toContain("image/png");
  }
  await page.goto("/");
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect((await request.get(apple)).ok()).toBeTruthy();
});

test("planning du joueur: il ajoute un match coaché, note son résultat, et son coach y répond", async ({ page, browser }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await expect(page.getByRole("grid", { name: "Mon agenda de la semaine" })).toBeVisible(); // agenda de la semaine par défaut
  await page.getByRole("button", { name: /Ajouter à mon planning/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Match amical/ }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Jour", { exact: true }).selectOption({ index: 88 }); // il y a deux jours: déjà joué
  await form.getByPlaceholder(/avec Karim/).fill("Match du jeudi e2e");
  await form.getByRole("combobox", { name: "Coaché par" }).selectOption({ label: "Coach Démo" });
  await form.getByRole("button", { name: "Victoire" }).click();
  await form.getByLabel("Score").fill("6-3 6-4");
  await form.getByLabel("Mon commentaire").fill("Bon jeu au filet");
  await form.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("Match amical ajouté à votre planning")).toBeVisible();
  await page.getByRole("tab", { name: /Liste/ }).click();
  await page.getByRole("button", { name: /Passé/ }).click();
  await expect(page.getByText("Match du jeudi e2e")).toBeVisible();

  const coach = await (await browser.newContext()).newPage();
  await login(coach, "demo@padel.tn");
  await nav(coach, "Joueurs").click();
  await coach.getByText("Sami Ben Ali").first().click();
  const match = coach.locator(".card", { hasText: "Match du jeudi e2e" });
  await match.getByLabel("Votre retour sur ce match").fill("Super placement, continue");
  await match.getByRole("button", { name: "Enregistrer mon retour" }).click();
  await expect(match.getByText("Retour enregistré")).toBeVisible();
  await coach.close();

  await page.reload();
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await page.getByRole("tab", { name: /Liste/ }).click();
  await page.getByRole("button", { name: /Passé/ }).click();
  await expect(page.getByText("Super placement, continue")).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "Progression" }).click();
  await expect(page.getByRole("heading", { name: "Mon niveau technique" })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "Crédits" }).click();
  await expect(page.getByRole("heading", { name: "Historique" })).toBeVisible();
});

test("réserver: seul toujours 1 h, à deux ou en groupe 1 h 30 par défaut, 1 h ou les deux", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  const duo = page.getByRole("checkbox", { name: /À deux/ });
  if ((await duo.getAttribute("aria-checked")) !== "true") await duo.click();
  const durDuo = page.getByRole("group", { name: "Durée à deux" });
  await expect(durDuo.getByRole("button", { name: "1 h 30" })).toHaveAttribute("aria-pressed", "true");
  await expect(durDuo.getByRole("button", { name: "1 h", exact: true })).toHaveAttribute("aria-pressed", "false");
  await durDuo.getByRole("button", { name: "1 h", exact: true }).click(); // les deux durées
  await expect(durDuo.getByRole("button", { name: "1 h", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(durDuo.getByRole("button", { name: "1 h 30" })).toHaveAttribute("aria-pressed", "true");
  const solo = page.getByRole("checkbox", { name: /Seul/ });
  if ((await solo.getAttribute("aria-checked")) !== "true") await solo.click();
  await expect(page.getByText("toujours 1 h")).toBeVisible();
});

test("séance effectuée: le coach rembourse un joueur absent", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await page.locator(".donechip").first().click();
  const panel = page.locator(".donepanel");
  await panel.getByRole("button", { name: "Absent ? Rembourser" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Rembourser" }).click();
  await expect(panel.getByText("Absent · remboursé")).toBeVisible();
});

test("agenda du joueur: semaine, « Autre » (kiné…) et « Entraînement » qui mène à Réserver", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await page.getByRole("button", { name: "Semaine suivante" }).click();
  await page.getByRole("button", { name: /Ajouter à mon planning/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Autre/ }).click();
  const form = page.getByRole("dialog");
  await form.getByPlaceholder(/kiné/).fill("Kiné genou");
  await form.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("Autre ajouté à votre planning")).toBeVisible();
  await page.getByRole("button", { name: "Aujourd'hui" }).click();
  await expect(page.getByRole("grid", { name: "Mon agenda de la semaine" }).getByRole("button", { name: /Kiné genou/ })).toBeVisible();
  await page.getByRole("button", { name: /Ajouter à mon planning/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Entraînement/ }).click();
  await expect(page.getByRole("heading", { name: "Réserver" })).toBeVisible();
});

test("réserver: coachs et clubs favoris choisis d'office", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  await page.getByRole("button", { name: /Choisir mes coachs et clubs favoris/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Coach Démo/ }).click();
  await dialog.getByRole("button", { name: "Enregistrer mes favoris" }).click();
  await expect(page.getByRole("group", { name: "Coachs" }).getByRole("button", { name: /Coach Démo ★/ })).toHaveAttribute("aria-pressed", "true");
  await page.locator("nav").getByRole("button", { name: "Accueil" }).click();
  await page.evaluate(() => sessionStorage.removeItem("book-filters")); // nouvelle visite: les favoris reviennent d'office
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  await expect(page.getByRole("group", { name: "Coachs" }).getByRole("button", { name: /Coach Démo ★/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Coachs" }).getByRole("button", { name: "Tous" })).toHaveAttribute("aria-pressed", "false");
});
