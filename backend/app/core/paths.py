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

─────────────────────────────────────────────────────────────────────────
PER-USER STORAGE
─────────────────────────────────────────────────────────────────────────

Each user owns a directory tree, and every path below resolves inside the
current user's tree:

    <root>/
      auth.db                     identity — shared, the only cross-user store
      users/
        <user-id>/
          reporter.db             that user's reports, trackers, settings
          reports/ photos/ specs/ schedules/ dispatches/ backfill/

WHY SCOPE THE DIRECTORY RATHER THAN ADD user_id COLUMNS

The conventional approach — a user_id column on every table and a WHERE clause
on every query — has one failure mode that matters here: a single query that
forgets its WHERE clause serves one user's reports to another, silently, and
looks perfectly normal in review. There are seven tables and roughly ninety
endpoints, so there would be a lot of places to be perfect in.

Scoping at the directory means isolation does not depend on remembering
anything. A query cannot read across users because it is not connected to a
database that contains them. It also handles the half of the data that is files
on disk — reports JSON, photos, uploaded schedules and dispatch PDFs — which a
user_id column would not have covered at all.

The paths are functions, not the constants they used to be, because their value
now depends on who is asking. Callers that need a directory to exist should call
ensure_user_dirs() first.
"""

import os

from app.core.user_context import require_user_id

# backend/app/core/paths.py → up 3 = backend/
_PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The storage root. Everything — identity and every user's tree — lives below.
ROOT_DIR = os.environ.get("DAILY_REPORTER_DATA_DIR") or os.path.join(_PACKAGE_ROOT, "data")

# Identity. The one store deliberately NOT per-user: it is how we know who the
# users are, so it cannot live inside a particular user's directory.
AUTH_DB_PATH = os.path.join(ROOT_DIR, "auth.db")

# Parent of every user's tree.
USERS_ROOT = os.path.join(ROOT_DIR, "users")


def user_root(user_id: str) -> str:
    """The directory owning everything belonging to one user."""
    return os.path.join(USERS_ROOT, user_id)


def data_dir() -> str:
    """The current user's data directory. Raises if nobody is authenticated."""
    return user_root(require_user_id())


def reports_dir() -> str:
    return os.path.join(data_dir(), "reports")


def photos_dir() -> str:
    return os.path.join(data_dir(), "photos")


def specs_dir() -> str:
    return os.path.join(data_dir(), "specs")


def schedules_dir() -> str:
    return os.path.join(data_dir(), "schedules")


def dispatches_dir() -> str:
    return os.path.join(data_dir(), "dispatches")


def backfill_dir() -> str:
    return os.path.join(data_dir(), "backfill")


def settings_file() -> str:
    return os.path.join(data_dir(), "settings.json")


def conversation_draft_file() -> str:
    """
    The conversation this user has started and not yet written.

    One per user, not one per day: a conversation is a single sitting, and a
    second one started before the first was written replaces it - which is
    exactly what the person doing it meant.
    """
    return os.path.join(data_dir(), "conversation_draft.json")


def db_path() -> str:
    """The current user's database. Each user gets their own SQLite file."""
    return os.path.join(data_dir(), "reporter.db")


def _sub_dirs(root: str) -> list[str]:
    return [
        root,
        os.path.join(root, "reports"),
        os.path.join(root, "photos"),
        os.path.join(root, "specs"),
        os.path.join(root, "schedules"),
        os.path.join(root, "dispatches"),
        os.path.join(root, "backfill"),
    ]


def ensure_root_dirs() -> None:
    """Create the storage root and the users parent. Safe to call repeatedly."""
    os.makedirs(ROOT_DIR, exist_ok=True)
    os.makedirs(USERS_ROOT, exist_ok=True)


def ensure_user_dirs(user_id: str | None = None) -> str:
    """
    Create one user's directory tree. Defaults to the current user.
    Returns the user's root. Safe to call repeatedly.
    """
    root = user_root(user_id) if user_id else data_dir()
    for directory in _sub_dirs(root):
        os.makedirs(directory, exist_ok=True)
    return root
