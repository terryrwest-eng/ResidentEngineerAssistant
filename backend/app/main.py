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

from app.services.database import init_database
from app.routers import reports, auth, export, ai, trackers, settings

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("daily-reporter")

# --- Data directories ---
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
REPORTS_DIR = os.path.join(DATA_DIR, "reports")
PHOTOS_DIR = os.path.join(DATA_DIR, "photos")
SPECS_DIR = os.path.join(DATA_DIR, "specs")

for directory in [DATA_DIR, REPORTS_DIR, PHOTOS_DIR, SPECS_DIR]:
    os.makedirs(directory, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("Starting Daily Reporter V3 backend...")
    init_database()
    logger.info("Database initialized.")
    logger.info(f"Data directory: {DATA_DIR}")
    logger.info(f"Reports directory: {REPORTS_DIR}")
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

# --- Static files for photos ---
app.mount("/api/photos", StaticFiles(directory=PHOTOS_DIR), name="photos")

# --- Routers ---
app.include_router(auth.router)
app.include_router(reports.router)
app.include_router(ai.router)
app.include_router(export.router)
app.include_router(trackers.router)
app.include_router(settings.router)


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "version": "3.0.0",
        "data_dir": DATA_DIR,
    }


# --- Serve React SPA in production ---
# In production (Railway), the built frontend lives in /app/static.
# API routes above take priority. Everything else falls through to the SPA.
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
