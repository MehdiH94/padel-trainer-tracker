// Avant les tests: données de démo (coach demo@padel.tn, joueur sami@demo.tn…) dans la base neuve.
// Lancé sans bloquer Node: le serveur de test (dont Playwright lit la sortie) doit continuer à répondre.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export default async function setup() {
  const port = process.env.E2E_PORT || "8090";
  try {
    await promisify(execFile)(process.env.PYTHON || "python", ["seed_demo.py"], {
      cwd: path.resolve(import.meta.dirname, "../../backend"),
      env: { ...process.env, API_URL: `http://127.0.0.1:${port}/api`, DATABASE_URL: "sqlite:///./e2e.db" }, // même base que e2e/serve.sh
    });
  } catch (e) {
    throw new Error(`Données de démo non chargées: ${e.stderr || e.message}`);
  }
}
