#!/usr/bin/env bash
# Lance l'application complète comme en production (API + application construite, app.web) sur une base neuve,
# pour les tests de bout en bout. Les données de démo sont ajoutées par e2e/setup.js.
set -euo pipefail
cd "$(dirname "$0")/../../backend"
rm -f e2e.db
export DATABASE_URL=sqlite:///./e2e.db ADMIN_EMAILS=demo@padel.tn REQUIRE_EMAIL_VERIFICATION=0 SMTP_HOST=
exec "${PYTHON:-python}" -m uvicorn app.web:web --port "${E2E_PORT:-8090}" --log-level warning
