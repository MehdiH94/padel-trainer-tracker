// Tests de bout en bout (Playwright): npx playwright test   (rapport: npx playwright show-report)
// L'application est construite (npm run build) puis servie comme en production sur une base de démo neuve.
import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT || "8090";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1, // une seule base partagée: les scénarios s'enchaînent
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/setup.js",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices["Pixel 7"], // l'appli est d'abord utilisée sur téléphone
    locale: "fr-FR",
    timezoneId: "Africa/Tunis",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "mobile", use: { browserName: "chromium" } }],
  webServer: {
    command: "bash e2e/serve.sh",
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
