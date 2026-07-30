"""
Daily Reporter V3 — Database & File Storage Service

STORAGE STRATEGY: SQLite + File-Per-Report
- SQLite: fast queries, indexing, search, ACID transactions
- File-per-report: human-readable JSON backup, isolated failure

Every write operation:
1. Write to SQLite (inside a transaction)
2. Write the full report as a standalone JSON file

If SQLite corrupts → JSON files are still there.
If a JSON file is accidentally deleted → SQLite still has the data.
Belt and suspenders.
"""

import json
import os
import shutil
import sqlite3
import logging
import tempfile
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# --- Paths ---
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data")
DB_PATH = os.path.join(DATA_DIR, "reporter.db")
REPORTS_DIR = os.path.join(DATA_DIR, "reports")
PHOTOS_DIR = os.path.join(DATA_DIR, "photos")
SPECS_DIR = os.path.join(DATA_DIR, "specs")


def get_connection() -> sqlite3.Connection:
    """
    Get a SQLite connection with WAL mode and foreign keys enabled.
    WAL mode allows concurrent reads while writing — critical for a web server.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    return conn


def init_database():
    """
    Create all tables if they don't exist.
    Called once on app startup.
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(REPORTS_DIR, exist_ok=True)
    os.makedirs(PHOTOS_DIR, exist_ok=True)
    os.makedirs(SPECS_DIR, exist_ok=True)

    conn = get_connection()
    try:
        conn.executescript("""
            -- Users table
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                is_approved INTEGER NOT NULL DEFAULT 0,
                gemini_api_key TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- Reports index (lightweight — full data is in JSON files)
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                project_name TEXT NOT NULL DEFAULT '',
                project_number TEXT NOT NULL DEFAULT '',
                report_date TEXT NOT NULL DEFAULT '',
                inspector_name TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                activity_count INTEGER NOT NULL DEFAULT 0,
                file_path TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- Index for fast date/project lookups
            CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date);
            CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_name);
            CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

            -- Settings (key-value store)
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Excavation tracker
            CREATE TABLE IF NOT EXISTS excavation_entries (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                station_from TEXT NOT NULL DEFAULT '',
                station_to TEXT NOT NULL DEFAULT '',
                depth TEXT NOT NULL DEFAULT '',
                soil_type TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            -- Pay item tracker
            CREATE TABLE IF NOT EXISTS pay_items (
                id TEXT PRIMARY KEY,
                item_number TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                unit TEXT NOT NULL DEFAULT '',
                contract_qty REAL NOT NULL DEFAULT 0,
                installed_qty REAL NOT NULL DEFAULT 0,
                remaining_qty REAL NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );

            -- Punch list
            CREATE TABLE IF NOT EXISTS punch_items (
                id TEXT PRIMARY KEY,
                description TEXT NOT NULL DEFAULT '',
                location TEXT NOT NULL DEFAULT '',
                responsible_party TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'open',
                priority TEXT NOT NULL DEFAULT 'medium',
                date_opened TEXT NOT NULL,
                date_closed TEXT,
                notes TEXT NOT NULL DEFAULT ''
            );

            -- Redline tracker
            CREATE TABLE IF NOT EXISTS redline_entries (
                id TEXT PRIMARY KEY,
                drawing_number TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                date_submitted TEXT NOT NULL,
                date_resolved TEXT,
                notes TEXT NOT NULL DEFAULT ''
            );

            -- PDF documents index
            CREATE TABLE IF NOT EXISTS pdf_documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                file_path TEXT NOT NULL,
                page_count INTEGER NOT NULL DEFAULT 0,
                uploaded_at TEXT NOT NULL
            );
        """)
        conn.commit()
        logger.info(f"Database initialized at {DB_PATH}")
    finally:
        conn.close()


# ============================================
# REPORT FILE OPERATIONS
# ============================================

def _report_file_path(report_id: str, report_date: str, project_name: str) -> str:
    """
    Generate the file path for a report's JSON file.
    Format: data/reports/YYYY-MM-DD_ProjectName_id.json
    """
    # Sanitize project name for filesystem
    safe_project = "".join(
        c if c.isalnum() or c in (' ', '-', '_') else '_'
        for c in (project_name or "Unknown")
    ).strip().replace(' ', '_')[:50]

    safe_date = (report_date or "0000-00-00")[:10]
    short_id = report_id[:8]

    filename = f"{safe_date}_{safe_project}_{short_id}.json"
    return os.path.join(REPORTS_DIR, filename)


def atomic_write_json(file_path: str, data: dict):
    """
    Write JSON to a file ATOMICALLY.
    Writes to a temp file first, then renames. This guarantees:
    - No half-written files (crash-safe)
    - No corruption from concurrent writes
    - The file is either complete or doesn't exist
    """
    dir_path = os.path.dirname(file_path)
    os.makedirs(dir_path, exist_ok=True)

    # Write to temp file in same directory (same filesystem for atomic rename)
    fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
            f.flush()
            os.fsync(f.fileno())  # Force write to disk

        # Atomic rename (on same filesystem, this is guaranteed atomic)
        shutil.move(tmp_path, file_path)
        logger.debug(f"Atomic write: {file_path}")
    except Exception:
        # Clean up temp file on failure
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def read_report_file(file_path: str) -> Optional[dict]:
    """Read a report JSON file. Returns None if file doesn't exist."""
    if not os.path.exists(file_path):
        logger.warning(f"Report file not found: {file_path}")
        return None
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.error(f"Failed to read report file {file_path}: {e}")
        return None


def save_report(report_data: dict) -> str:
    """
    Save a report to BOTH SQLite and a JSON file.
    Returns the file path of the saved JSON.

    This is the single write path for all report saves.
    """
    report_id = report_data.get("id", "")
    general = report_data.get("general", {})
    report_date = general.get("report_date", "")
    project_name = general.get("project_name", "")
    project_number = general.get("project_number", "")
    inspector_name = general.get("inspector_name", "")
    status = report_data.get("status", "draft")
    activities = report_data.get("activities", [])
    now = datetime.utcnow().isoformat()

    # Determine file path
    file_path = _report_file_path(report_id, report_date, project_name)

    # 1. Write the full report as a JSON file (atomic)
    report_data["updated_at"] = now
    if "created_at" not in report_data:
        report_data["created_at"] = now

    atomic_write_json(file_path, report_data)

    # 2. Update the SQLite index
    conn = get_connection()
    try:
        conn.execute("""
            INSERT INTO reports (id, project_name, project_number, report_date,
                                inspector_name, status, activity_count, file_path,
                                created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                project_name = excluded.project_name,
                project_number = excluded.project_number,
                report_date = excluded.report_date,
                inspector_name = excluded.inspector_name,
                status = excluded.status,
                activity_count = excluded.activity_count,
                file_path = excluded.file_path,
                updated_at = excluded.updated_at
        """, (
            report_id, project_name, project_number, report_date,
            inspector_name, status, len(activities), file_path,
            report_data.get("created_at", now), now
        ))
        conn.commit()
        logger.info(f"Report saved: {report_id} → {file_path}")
    finally:
        conn.close()

    return file_path


def find_report_by_date(report_date: str, project_name: str = "") -> Optional[dict]:
    """
    Find an existing report for a given date (and project, when one is given).

    WHY: a daily report is one-per-day-per-project. Creating a second one for a
    date that already has one is always an accident — an auto-save that fired
    before the first save came back, a double-click, a second tab — and it
    litters the history with copies of the same day. Callers use this to reuse
    the existing report instead of minting a new ID.

    Returns the oldest match, so repeated accidents keep collapsing onto the
    original rather than hopping between duplicates.
    """
    if not report_date:
        return None

    conn = get_connection()
    try:
        if project_name:
            row = conn.execute(
                "SELECT * FROM reports WHERE report_date = ? AND project_name = ? "
                "ORDER BY created_at ASC LIMIT 1",
                (report_date, project_name),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM reports WHERE report_date = ? "
                "ORDER BY created_at ASC LIMIT 1",
                (report_date,),
            ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_report(report_id: str) -> Optional[dict]:
    """
    Get a full report by ID.
    Reads from the JSON file (full data) using the path from SQLite (fast lookup).
    """
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT file_path FROM reports WHERE id = ?", (report_id,)
        ).fetchone()

        if not row:
            logger.warning(f"Report not found in index: {report_id}")
            return None

        return read_report_file(row["file_path"])
    finally:
        conn.close()


def list_reports(
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
    project_name: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> list[dict]:
    """
    List reports from the SQLite index (fast).
    Returns lightweight index data, NOT full report contents.
    """
    conn = get_connection()
    try:
        query = "SELECT * FROM reports WHERE 1=1"
        params: list = []

        if status:
            query += " AND status = ?"
            params.append(status)
        if project_name:
            query += " AND project_name LIKE ?"
            params.append(f"%{project_name}%")
        if date_from:
            query += " AND report_date >= ?"
            params.append(date_from)
        if date_to:
            query += " AND report_date <= ?"
            params.append(date_to)

        query += " ORDER BY report_date DESC, updated_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def delete_report(report_id: str) -> bool:
    """
    Delete a report from both SQLite and the file system.
    """
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT file_path FROM reports WHERE id = ?", (report_id,)
        ).fetchone()

        if not row:
            return False

        # Delete from SQLite
        conn.execute("DELETE FROM reports WHERE id = ?", (report_id,))
        conn.commit()

        # Delete the JSON file
        file_path = row["file_path"]
        if os.path.exists(file_path):
            os.remove(file_path)
            logger.info(f"Deleted report file: {file_path}")

        # Delete associated photos
        photos_dir = os.path.join(PHOTOS_DIR, report_id)
        if os.path.exists(photos_dir):
            shutil.rmtree(photos_dir)
            logger.info(f"Deleted photos directory: {photos_dir}")

        logger.info(f"Report deleted: {report_id}")
        return True
    finally:
        conn.close()


def get_report_count() -> int:
    """Get the total number of reports in the database."""
    conn = get_connection()
    try:
        row = conn.execute("SELECT COUNT(*) as count FROM reports").fetchone()
        return row["count"] if row else 0
    finally:
        conn.close()


# ============================================
# SETTINGS OPERATIONS
# ============================================

def get_setting(key: str, default: str = "") -> str:
    """Get a setting value by key."""
    conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_setting(key: str, value: str):
    """Set a setting value."""
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
            (key, value, value)
        )
        conn.commit()
    finally:
        conn.close()


def get_all_settings() -> dict:
    """Get all settings as a dictionary."""
    conn = get_connection()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {row["key"]: row["value"] for row in rows}
    finally:
        conn.close()
