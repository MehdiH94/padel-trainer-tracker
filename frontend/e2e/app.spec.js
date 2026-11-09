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
  await page.getByRole("button", { name: "Aujourd'hui", exact: true }).click();
  await page.getByRole("tab", { name: "Jour par jour" }).click();
  await expect(page.locator(".weekstrip")).toBeVisible();

  await page.getByRole("button", { name: /Mes terrains/ }).click();
  await expect(page.getByRole("heading", { name: "Mes terrains" })).toBeVisible();

  await nav(page, "Joueurs").click();
  await expect(page.getByText("Sami Ben Ali").first()).toBeVisible();
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
  await page.getByLabel("Prix Individuel 1 h", { exact: true }).fill("60");
  await page.getByLabel("Prix Individuel 1 h", { exact: true }).fill("060"); // le 0 de départ ne reste pas collé: « 60 »
  await expect(page.getByLabel("Prix Individuel 1 h", { exact: true })).toHaveValue("060");
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
  await page.getByRole("button", { name: "Séance", exact: true }).click();
  const form = page.locator("form.card");
  await expect(form.getByText("Prix par joueur")).toBeVisible();
  await expect(form.locator("input[type=number][step='0.001']")).toHaveCount(0); // plus de prix libre
  await expect(form.locator(".pricebox b")).toHaveText(/TND/); // prix chargé
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
  const back = page.getByRole("button", { name: "Aujourd'hui", exact: true }); // seulement quand on n'est pas sur la semaine en cours
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

test("réserver: seul et à deux 1 h par défaut, en groupe 1 h 30 par défaut, 1 h ou les deux", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  for (const k of [/À deux/, /En groupe/]) {
    const c = page.getByRole("checkbox", { name: k });
    if ((await c.getAttribute("aria-checked")) !== "true") await c.click();
  }
  const durDuo = page.getByRole("group", { name: "Durée à deux" });
  await expect(durDuo.getByRole("button", { name: "1 h", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(durDuo.getByRole("button", { name: "1 h 30" })).toHaveAttribute("aria-pressed", "false");
  const durGroup = page.getByRole("group", { name: "Durée en groupe" });
  await expect(durGroup.getByRole("button", { name: "1 h 30" })).toHaveAttribute("aria-pressed", "true");
  await expect(durGroup.getByRole("button", { name: "1 h", exact: true })).toHaveAttribute("aria-pressed", "false");
  await durDuo.getByRole("button", { name: "1 h 30" }).click(); // les deux durées
  await expect(durDuo.getByRole("button", { name: "1 h", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(durDuo.getByRole("button", { name: "1 h 30" })).toHaveAttribute("aria-pressed", "true");
  const solo = page.getByRole("checkbox", { name: /Seul/ });
  if ((await solo.getAttribute("aria-checked")) !== "true") await solo.click();
  await expect(page.getByRole("group", { name: "Durée seul" }).getByRole("button", { name: "1 h", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("réglages: durées et prix par formule (pas forcément proportionnels) et limite de réservation à l'avance", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await page.goto("/#settings/formules");
  const solo = page.getByRole("group", { name: "Durées Individuel" });
  await solo.getByRole("button", { name: "1 h 30" }).click();
  await page.getByLabel("Prix Individuel 1 h 30").fill("70");
  await page.getByRole("group", { name: "Limite de réservation à l'avance" }).getByRole("button", { name: "1 mois" }).click();
  await page.getByRole("button", { name: /Enregistrer/ }).last().click();
  await expect(page.getByText("Réglages enregistrés")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Prix Individuel 1 h 30")).toHaveValue("70");
  await expect(page.getByRole("group", { name: "Limite de réservation à l'avance" }).getByRole("button", { name: "1 mois" })).toHaveAttribute("aria-pressed", "true");
  // on remet comme avant (les autres parcours utilisent les mêmes données)
  await page.getByRole("group", { name: "Durées Individuel" }).getByRole("button", { name: "1 h 30" }).click();
  await page.getByRole("group", { name: "Limite de réservation à l'avance" }).getByRole("button", { name: "2 semaines" }).click();
  await page.getByRole("button", { name: /Enregistrer/ }).last().click();
  await expect(page.getByText("Réglages enregistrés")).toBeVisible();
});

test("séance effectuée: le coach rembourse un joueur absent (en entier), depuis le planning", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await nav(page, "Planning").click();
  await expect(page.getByText(/séances? à noter/).first()).toBeVisible(); // toutes les séances à noter, point rouge
  await page.locator(".donechip").first().click();
  const panel = page.locator(".donepanel");
  await expect(panel.locator(".paycard")).toHaveCount(1); // un joueur à la fois
  await panel.getByRole("button", { name: /Absent \? Rembourser/ }).first().click(); // tout ce qu'il a payé, jamais une partie
  await expect(page.getByRole("dialog").getByText(/Êtes-vous sûr de vouloir rembourser/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Oui, rembourser" }).click();
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
  await page.getByRole("button", { name: "Aujourd'hui", exact: true }).click();
  await expect(page.getByRole("grid", { name: "Mon agenda de la semaine" }).getByRole("button", { name: /Kiné genou/ })).toBeVisible();
  await page.getByRole("button", { name: /Ajouter à mon planning/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Entraînement/ }).click();
  await expect(page.getByRole("heading", { name: "Réserver" })).toBeVisible();
});

test("réserver: coachs et clubs favoris choisis d'office", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  await page.getByRole("button", { name: /favoris/ }).click(); // son coach est déjà favori (lien d'invitation)
  const dialog = page.getByRole("dialog");
  const demo = dialog.getByRole("button", { name: /Coach Démo/ });
  if ((await demo.getAttribute("aria-pressed")) !== "true") await demo.click();
  await dialog.getByRole("button", { name: "Enregistrer mes favoris" }).click();
  await expect(page.getByRole("group", { name: "Coachs" }).getByRole("button", { name: /Coach Démo ★/ })).toHaveAttribute("aria-pressed", "true");
  await page.locator("nav").getByRole("button", { name: "Accueil" }).click();
  await page.evaluate(() => sessionStorage.removeItem("book-filters")); // nouvelle visite: les favoris reviennent d'office
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  await expect(page.getByRole("group", { name: "Coachs" }).getByRole("button", { name: /Coach Démo ★/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Coachs" }).getByRole("button", { name: "Tous" })).toHaveAttribute("aria-pressed", "false");
});

test("planning › calendrier: une séance passée à noter s'ouvre sur le panneau complet, sans « Préparer la séance »", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await nav(page, "Planning").click();
  const block = page.locator(".cal-block", { has: page.locator(".todo-dot") }).first();
  await block.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".donepanel")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Absent \? Rembourser/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Pas eu lieu ? Annuler" })).toBeVisible();
  await expect(dialog.getByText("Préparer la séance")).toHaveCount(0);
});

test("réserver: une carte par coach et club, l'heure se choisit sur des pastilles", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  await page.locator(".daypill").nth(4).click();
  const group = page.locator(".slotgroup").first();
  await expect(group).toBeVisible();
  await group.locator(".chips button").first().click();
  await expect(group.getByRole("button", { name: /Réserver ce créneau/ })).toBeVisible();
});

test("réserver: onglet « Réservation en groupe » visible dès le départ, le créneau mène à la page du groupe", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  await page.getByRole("tab", { name: "Réservation en groupe" }).click();
  await expect(page.getByRole("checkbox", { name: /Seul/ })).toHaveCount(0); // jamais seul en groupe
  await page.locator(".daypill").nth(5).click();
  const group = page.locator(".slotgroup").first();
  await expect(group).toBeVisible();
  await group.locator(".chips button").first().click();
  await group.getByRole("button", { name: /Créer le groupe et inviter/ }).click();
  await expect(page.getByRole("heading", { name: "Entraînement en groupe" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copier le lien" })).toBeVisible();
});

test("terrain hors des horaires de travail (mode disponibilités): avertissement et confirmation", async ({ page, request }) => {
  const { token } = await (await request.post("/api/auth/login", { data: { email: "demo@padel.tn", password: "demo1234" } })).json();
  const headers = { Authorization: `Bearer ${token}` };
  const st = await (await request.get("/api/booking/settings", { headers })).json();
  const avail = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_time: "09:00", end_time: "21:00" }));
  await request.put("/api/booking/settings", { headers, data: { ...st, booking_mode: "disponibilites", availability: avail } });
  try {
    await login(page, "demo@padel.tn");
    await nav(page, "Planning").click();
    await page.getByRole("button", { name: "Terrain", exact: true }).click();
    const form = page.locator("form.edit-card");
    await form.getByLabel("Début").selectOption("06:00");
    await expect(form.getByText(/En dehors de vos horaires de travail/)).toBeVisible();
    await form.getByRole("button", { name: /Enregistrer le terrain/ }).click();
    await expect(page.getByRole("dialog").getByText(/les joueurs ne verront pas ce créneau/)).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Non" }).click();
  } finally {
    await request.put("/api/booking/settings", { headers, data: st });
  }
});

test("trois demandes pour le même créneau: le coach voit les choix possibles et accepte en un geste", async ({ page, request }) => {
  const tok = async (email) => (await (await request.post("/api/auth/login", { data: { email, password: "demo1234" } })).json()).token;
  const as = async (email) => ({ Authorization: `Bearer ${await tok(email)}` });
  const sami = await as("sami@demo.tn"), karim = await as("karim@demo.tn"), mehdi = await as("mehdi@demo.tn");
  const coach = await as("demo@padel.tn");
  const day = new Date(Date.now() + 5 * 86400000).toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const [club] = await (await request.get("/api/clubs", { headers: coach })).json();
  await request.post("/api/court-bookings/manual", { headers: coach, data: { club_id: club.id, start: `${day}T20:00:00+01:00`, duration_min: 180, court_label: "Terrain soir" } });
  const off = await (await request.get(`/api/me/offers?day=${day}&kinds=individuel,groupe&groupe_min=90`, { headers: sami })).json();
  const slot = [...off.slots_with_court, ...off.slots_other].find((x) => x.coach.name === "Coach Démo"
    && x.options.some((o) => o.kind === "groupe" && o.duration_min === 90) && x.options.some((o) => o.kind === "individuel"));
  const group = { kind: "groupe", start: slot.start, coach_id: slot.coach.id, kinds: ["groupe"], durations: { groupe: [90] } };
  expect((await request.post("/api/me/book", { headers: sami, data: group })).ok()).toBeTruthy();
  expect((await request.post("/api/me/book", { headers: karim, data: group })).ok()).toBeTruthy();
  expect((await request.post("/api/me/book", { headers: mehdi, data: { kind: "individuel", start: slot.start, coach_id: slot.coach.id, kinds: ["individuel"] } })).ok()).toBeTruthy();

  await login(page, "demo@padel.tn");
  await nav(page, "Demandes").click();
  const card = page.locator(".req.conflict", { hasText: "Mehdi" }).filter({ hasText: "Karim" });
  await expect(card.getByText(/3 demandes · même créneau/)).toBeVisible();
  await expect(card.getByText("Elles ne sont pas toutes compatibles : choisissez qui joue.")).toBeVisible();
  await card.getByRole("button", { name: /Accepter Sami et Karim/ }).click();
  await expect(page.getByRole("dialog").getByText(/Mehdi sera refusé/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Accepter ce choix" }).click();
  await expect(page.locator(".req.conflict", { hasText: "Mehdi" }).filter({ hasText: "Karim" })).toHaveCount(0);
});

test("lien d'inscription du coach: le joueur choisit main, côté et objectifs, et devient son élève", async ({ page, browser }) => {
  await login(page, "demo@padel.tn");
  await nav(page, "Joueurs").click();
  await page.getByRole("button", { name: /Mon lien d'inscription/ }).click();
  const link = await page.getByLabel("Mon lien d'inscription").inputValue();
  expect(link).toMatch(/\/inscription\/.+/);
  const p = await (await browser.newContext()).newPage();
  await p.goto(link);
  await expect(p.getByText(/Coach Démo vous invite/)).toBeVisible();
  await p.getByLabel("Nom complet").fill("Olfa Lien");
  await p.getByLabel("Téléphone").fill("29 876 543");
  await p.getByRole("group", { name: "Main forte" }).getByRole("button", { name: "Gaucher" }).click();
  await p.getByRole("group", { name: "Côté de jeu" }).getByRole("button", { name: "Les deux" }).click();
  await p.getByRole("group", { name: "Mes objectifs" }).getByRole("button", { name: "Gagner un tableau en tournoi" }).click();
  await p.getByLabel("Tableau visé").selectOption("P250");
  await p.getByLabel("Votre e-mail").fill("olfa.lien@demo.tn");
  await p.getByLabel(/Mot de passe/).fill("secret1");
  await p.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(p.getByText(/administrateur/).first()).toBeVisible(); // en attente de confirmation
  await p.close();
  await page.reload();
  await page.getByText("Olfa Lien").first().click();
  await expect(page.getByText("Gagner un tableau P250")).toBeVisible();
  await expect(page.getByText(/gaucher · les deux côtés/)).toBeVisible();
});

test("le coach propose un autre horaire: le joueur est notifié dans l'appli et accepte", async ({ page, browser, request }) => {
  const tok = async (email) => (await (await request.post("/api/auth/login", { data: { email, password: "demo1234" } })).json()).token;
  const sami = { Authorization: `Bearer ${await tok("sami@demo.tn")}` };
  const slots = await (await request.get("/api/me/slots", { headers: sami })).json();
  const later = slots.filter((x) => new Date(x) - Date.now() > 3 * 86400000);
  const r = await (await request.post("/api/me/book", { headers: sami, data: { kind: "individuel", start: later[0], kinds: ["individuel"] } })).json();
  await login(page, "demo@padel.tn");
  await nav(page, "Demandes").click();
  await expect(page.locator(".card.req").first()).toBeVisible();
  let card = page.locator(`.card.req[data-id="${r.id}"]`);
  if (!(await card.count())) { await page.getByRole("button", { name: /une par une/ }).first().click(); card = page.locator(`.card.req[data-id="${r.id}"]`); }
  await card.getByRole("button", { name: "Autre horaire" }).click();
  await card.getByLabel("Heure proposée").selectOption("21:00");
  await card.getByRole("button", { name: "Envoyer la proposition" }).click();
  await expect(page.getByRole("heading", { name: /Autre horaire proposé/ })).toBeVisible();

  const p = await (await browser.newContext()).newPage();
  await login(p, "sami@demo.tn");
  await expect(p.getByRole("button", { name: /Notifications \(\d+ non lues\)/ })).toBeVisible();
  const prop = p.locator(".proposal-card").first();
  await expect(prop.getByText(/vous propose/)).toBeVisible();
  await prop.getByRole("button", { name: "Accepter" }).click();
  await expect(p.getByText("C'est noté : séance acceptée à ce nouvel horaire")).toBeVisible();
  await p.getByRole("button", { name: /Notifications/ }).click();
  await expect(p.getByRole("dialog").getByText(/vous propose un autre horaire/).first()).toBeVisible();
  await p.close();
});

test("seul, à deux ou en groupe: validée tout de suite, ouverte aux autres joueurs, 1 h s'il reste seul", async ({ page, browser, request }) => {
  const tok = async (email) => (await (await request.post("/api/auth/login", { data: { email, password: "demo1234" } })).json()).token;
  const sami = { Authorization: `Bearer ${await tok("sami@demo.tn")}` }, coach = { Authorization: `Bearer ${await tok("demo@padel.tn")}` };
  const day = new Date(Date.now() + 6 * 86400000).toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const [club] = await (await request.get("/api/clubs", { headers: coach })).json();
  expect((await request.post("/api/court-bookings/manual", { headers: coach, data: { club_id: club.id, start: `${day}T06:00:00+01:00`, duration_min: 90, court_label: "Terrain matin" } })).ok()).toBeTruthy();
  const r = await request.post("/api/me/book", { headers: sami, data: { kind: "individuel", start: `${day}T06:00:00+01:00`, kinds: ["individuel", "duo", "groupe"], durations: { individuel: [60], duo: [60], groupe: [90] } } });
  expect(r.ok()).toBeTruthy();
  const b = await r.json();
  if (b.status === "en_attente") expect((await request.post(`/api/booking/requests/${b.id}/accept`, { headers: coach, data: {} })).ok()).toBeTruthy();

  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await page.getByRole("tab", { name: /Liste/ }).click();
  const ticket = page.locator(".ticket", { hasText: "Ouverte à d'autres joueurs" }).first();
  await expect(ticket.getByText("jusqu'à 90 min s'ils vous rejoignent")).toBeVisible();
  await expect(ticket.getByText("· 60 min")).toBeVisible();
  await expect(ticket.locator(".status-line")).toHaveText("Confirmée");

  // côté coach: confirmée mais encore complétable, visible dans le calendrier et complétable en un geste
  const c = await (await browser.newContext()).newPage();
  await login(c, "demo@padel.tn");
  await nav(c, "Planning").click();
  const block = c.locator(".cal-block.completable", { hasText: "6–7h30" }).first();
  await expect(c.locator(".cal-block").first()).toBeVisible();
  // semaine de la séance (lundi → dimanche): 0 ou 1 semaine plus loin
  const monday = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.getTime(); };
  const today = new Date().toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  for (let i = 0; i < Math.round((monday(day) - monday(today)) / (7 * 86400000)); i++) await c.getByRole("button", { name: "Semaine suivante" }).first().click();
  await expect(c.locator(".cal-legend")).toContainText("Confirmée, encore des places : à compléter");
  await block.click();
  const dialog = c.getByRole("dialog");
  await expect(dialog.getByText(/Confirmée · encore 3 places à compléter/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Compléter la séance · 3 places libres/ })).toBeVisible();
  await c.close();
});

test("réservation en groupe: le joueur invite un partenaire, qui accepte depuis sa notification; le coach reçoit la demande", async ({ page, browser, request }) => {
  const tok = async (email) => (await (await request.post("/api/auth/login", { data: { email, password: "demo1234" } })).json()).token;
  const sami = { Authorization: `Bearer ${await tok("sami@demo.tn")}` };
  const day = new Date(Date.now() + 4 * 86400000).toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const off = await (await request.get(`/api/me/offers?day=${day}&kinds=duo&duo_min=60`, { headers: sami })).json();
  const slot = [...off.slots_with_court, ...off.slots_other].find((x) => x.coach.name === "Coach Démo");
  const g = await (await request.post("/api/me/group-bookings", { headers: sami, data: { coach_id: slot.coach.id, start: slot.start, kinds: ["duo"], durations: { duo: [60] } } })).json();
  const invitable = await (await request.get(`/api/me/groups/${g.token}/invitable`, { headers: sami })).json();
  const mate = invitable.find((p) => /Karim|Mehdi/.test(p.name));
  const email = /Karim/.test(mate.name) ? "karim@demo.tn" : "mehdi@demo.tn";

  await login(page, "sami@demo.tn");
  await expect(page.getByRole("heading", { name: /^Salut / })).toBeVisible();
  await page.goto(`/#/groupe/${g.token}`);
  await expect(page.getByRole("heading", { name: "Entraînement en groupe" })).toBeVisible();
  await expect(page.getByText(/1\/2 joueurs : encore 1/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copier le lien" })).toBeVisible();
  await page.getByRole("checkbox", { name: new RegExp(mate.name) }).check();
  await page.getByRole("button", { name: /Inviter 1 joueur/ }).click();
  await expect(page.getByText("1 invitation envoyée")).toBeVisible();

  const p = await (await browser.newContext()).newPage();
  await login(p, email);
  await p.getByRole("button", { name: /Notifications/ }).click();
  await p.getByRole("dialog").getByRole("button", { name: "Voir l'invitation" }).first().click();
  await p.getByRole("button", { name: "Rejoindre l'entraînement" }).click();
  await expect(p.getByText("C'est noté ! La demande est chez le coach.")).toBeVisible();
  await p.close();

  const c = await (await browser.newContext()).newPage();
  await login(c, "demo@padel.tn");
  await nav(c, "Demandes").click();
  await expect(c.getByText(/Réservation en groupe/).first()).toBeVisible();
  await c.close();
});

test("calendrier du coach: toucher une case vide propose séance ou terrain à ce jour et cette heure (terrain 1 à 6)", async ({ page }) => {
  await login(page, "demo@padel.tn");
  await nav(page, "Planning").click();
  await page.getByRole("button", { name: "Semaine suivante" }).first().click();
  const first = parseInt(await page.locator(".cal-times span").first().innerText(), 10); // première heure affichée
  await page.locator(".cal-col.addable").nth(2).click({ position: { x: 4, y: 46 * (14 - first) + 10 } }); // vers 14 h
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/14 h 00/)).toBeVisible();
  await dialog.getByRole("button", { name: /Ajouter un terrain/ }).click();
  await expect(page.getByLabel("Début")).toHaveValue("14:00");
  const label = page.locator("label.field", { hasText: "Terrain" }).locator("select");
  await expect(label).toHaveValue("Terrain 1");
  await expect(label.locator("option")).toHaveCount(6);
  await page.locator(".cal-col.addable").nth(3).click({ position: { x: 4, y: 46 * (10 - first) + 10 } }); // vers 10 h
  await page.getByRole("dialog").getByRole("button", { name: /Ajouter une séance/ }).click();
  await expect(page.locator("form.card")).toBeVisible();
});

test("agenda du joueur: case vide puis « Entraînement » ouvre Réserver au bon jour et à la bonne heure", async ({ page }) => {
  await login(page, "sami@demo.tn");
  await page.locator("nav").getByRole("button", { name: "Planning" }).click();
  await page.getByRole("button", { name: "Semaine suivante" }).click();
  const grid = page.getByRole("grid", { name: "Mon agenda de la semaine" });
  const first = parseInt(await grid.locator(".cal-times span").first().innerText(), 10); // première heure affichée
  await grid.locator(".cal-col").nth(2).click({ position: { x: 4, y: 44 * (10 - first) + 10 } }); // vers 10 h
  await page.getByRole("dialog").getByRole("button", { name: /Entraînement/ }).click();
  await expect(page.getByRole("heading", { name: "Réserver" })).toBeVisible();
  await expect(page.getByLabel("Heure idéale (facultatif)")).toHaveValue("10");
  await expect(page.locator(".daypill.on")).toHaveCount(1);
});

test("rejoindre la demande d'un autre joueur de son niveau, pas encore traitée par le coach", async ({ page, request }) => {
  const tok = async (email) => (await (await request.post("/api/auth/login", { data: { email, password: "demo1234" } })).json()).token;
  const sami = { Authorization: `Bearer ${await tok("sami@demo.tn")}` };
  const day = new Date(Date.now() + 9 * 86400000).toLocaleDateString("fr-CA", { timeZone: "Africa/Tunis" });
  const q = `day=${day}&kinds=duo,groupe&duo_min=60,90&groupe_min=90`;
  const coach = { Authorization: `Bearer ${await tok("demo@padel.tn")}` };
  const [club] = await (await request.get("/api/clubs", { headers: coach })).json();
  await request.post("/api/court-bookings/manual", { headers: coach, data: { club_id: club.id, start: `${day}T06:00:00+01:00`, duration_min: 180, court_label: "Terrain 1" } });
  const off = await (await request.get(`/api/me/offers?${q}`, { headers: sami })).json();
  const slot = [...off.slots_with_court, ...off.slots_other].find((x) => x.coach.name === "Coach Démo");
  expect((await request.post("/api/me/book", { headers: sami, data: { kind: "duo", start: slot.start, coach_id: slot.coach.id, kinds: ["duo", "groupe"], durations: { duo: [60, 90], groupe: [90] } } })).ok()).toBeTruthy();
  let email = null;
  for (const e of ["mehdi@demo.tn", "karim@demo.tn", "lina@demo.tn", "wassim@demo.tn"]) {
    const t = await tok(e).catch(() => null);
    if (!t) continue;
    const r = await (await request.get(`/api/me/offers?${q}`, { headers: { Authorization: `Bearer ${t}` } })).json();
    if ((r.requests ?? []).some((x) => x.players.some((p) => /Sami/.test(p.name)))) { email = e; break; }
  }
  expect(email).not.toBeNull();
  await login(page, email);
  await page.locator("nav").getByRole("button", { name: "Réserver" }).click();
  for (const k of [/À deux/, /En groupe/]) {
    const c = page.getByRole("checkbox", { name: k });
    if ((await c.getAttribute("aria-checked")) !== "true") await c.click();
  }
  await page.locator(".daypill").nth(9).click();
  await expect(page.getByRole("heading", { name: /Des joueurs de votre niveau veulent jouer/ })).toBeVisible();
  await page.getByRole("button", { name: /Rejoindre la demande de Sami/ }).first().click();
  await expect(page.getByRole("heading", { name: "Demande envoyée" })).toBeVisible();
});
