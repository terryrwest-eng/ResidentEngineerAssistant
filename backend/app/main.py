"""
Daily Reporter V3 — FastAPI Backend Entry Point

Serves the API for the frontend (web, desktop, mobile).
All data stored as files on disk (SQLite index + JSON reports).
"""

import os
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.routers import reports, auth, export, ai, trackers, settings, weather, pdf_search, schedule, dispatches, backfill, interview, conversation

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("daily-reporter")

# --- Data directories (single source of truth: app.core.paths) ---
from app.core.paths import ROOT_DIR, ensure_root_dirs  # noqa: E402
from app.services.auth_db import init_auth_database  # noqa: E402

ensure_root_dirs()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("Starting Daily Reporter V3 backend...")
    # Only the identity store is created here. Each user's own database lives
    # inside their directory and is created on their first authenticated
    # request — there is no single database to initialize at startup any more.
    init_auth_database()
    logger.info("Auth database initialized.")
    logger.info(f"Storage root: {ROOT_DIR}")
    yield
    logger.info("Shutting down Daily Reporter V3 backend.")


# --- App ---
app = FastAPI(
    title="Daily Reporter V3",
    description="Construction field reporting API",
    version="3.0.0",
    lifespan=lifespan,
)

# --- CORS ---
# Allow all origins in development; lock down for production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# NOTE: there is no /api/photos static mount.
#
# It used to serve PHOTOS_DIR directly, but photos are now per-user and a static
# mount points at one fixed directory with no authentication — under multi-user
# that is precisely the leak this design exists to prevent. Nothing referenced
# it (no frontend caller, no upload endpoint), so it is gone rather than
# rebuilt. Serving photos again means an authenticated route that resolves
# photos_dir() for the calling user.

# --- Routers ---
app.include_router(auth.router)
app.include_router(reports.router)
app.include_router(ai.router)
app.include_router(export.router)
app.include_router(trackers.router)
app.include_router(settings.router)
app.include_router(weather.router)
app.include_router(pdf_search.router)
app.include_router(schedule.router)
app.include_router(dispatches.router)
app.include_router(backfill.router)
app.include_router(interview.router)


app.include_router(conversation.router)
@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "version": "3.0.0",
        "storage_root": ROOT_DIR,
    }


# --- Serve React SPA in production ---
# In production (Railway), the built frontend lives in /app/static.
# API routes above take priority. Everything else falls through to the SPA.
STATIC_DIR = os.environ.get("DAILY_REPORTER_STATIC_DIR")
if not STATIC_DIR:
    STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
if os.path.isdir(STATIC_DIR):
    from fastapi.responses import FileResponse

    # Serve static assets (JS, CSS, images)
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="frontend-assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Catch-all: serve React SPA index.html for client-side routing."""
        file_path = os.path.join(STATIC_DIR, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    logger.info(f"Serving frontend from: {STATIC_DIR}")
else:
    logger.info("No static directory found — running in API-only mode (dev)")
