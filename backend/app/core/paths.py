"""
Daily Reporter V3 — Data Path Resolution

Single source of truth for where persistent data lives.

WHY THIS EXISTS: every router used to re-derive `data/` by counting
os.path.dirname() calls up from __file__. Those all happened to resolve to the
same place (the Docker image flattens backend/ into /app), but only main.py
honored DAILY_REPORTER_DATA_DIR — so pointing that env var at a different
volume would have split the data across two locations.

Set DAILY_REPORTER_DATA_DIR to relocate everything; leave it unset for the
default alongside the backend package.
"""

import os

# backend/app/core/paths.py → up 3 = backend/
_PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DATA_DIR = os.environ.get("DAILY_REPORTER_DATA_DIR") or os.path.join(_PACKAGE_ROOT, "data")

REPORTS_DIR = os.path.join(DATA_DIR, "reports")
PHOTOS_DIR = os.path.join(DATA_DIR, "photos")
SPECS_DIR = os.path.join(DATA_DIR, "specs")
SCHEDULES_DIR = os.path.join(DATA_DIR, "schedules")
DISPATCHES_DIR = os.path.join(DATA_DIR, "dispatches")
BACKFILL_DIR = os.path.join(DATA_DIR, "backfill")

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
DB_PATH = os.path.join(DATA_DIR, "reporter.db")

ALL_DIRS = [
    DATA_DIR, REPORTS_DIR, PHOTOS_DIR, SPECS_DIR,
    SCHEDULES_DIR, DISPATCHES_DIR, BACKFILL_DIR,
]


def ensure_dirs() -> None:
    """Create every data directory if missing. Safe to call repeatedly."""
    for directory in ALL_DIRS:
        os.makedirs(directory, exist_ok=True)
