"""Point d'entrée de production: sert l'API sous /api et l'application React construite (frontend/dist) sur /.

    uvicorn app.web:web --host 0.0.0.0 --port 8000
"""
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

from .main import app as api
from .main import lifespan

DIST = Path(os.getenv("STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist"))


class SinglePage(StaticFiles):
    """Fichiers statiques; toute autre adresse (ex. /invite/xyz) renvoie index.html, le routage se fait côté navigateur."""

    async def get_response(self, path, scope):
        try:
            resp = await super().get_response(path, scope)
        except HTTPException as e:
            if e.status_code != 404:
                raise
            resp = await super().get_response("index.html", scope)
        # index.html est toujours revérifié: après un déploiement, le téléphone charge tout de suite la nouvelle version.
        # Les fichiers de assets/ ont un nom qui change à chaque build: ils peuvent rester en cache longtemps.
        if path.startswith("assets/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            resp.headers["Cache-Control"] = "no-cache"
        return resp


web = FastAPI(title="Padel Trainer Tracker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
web.mount("/api", api)
if DIST.exists():
    web.mount("/", SinglePage(directory=DIST, html=True))
