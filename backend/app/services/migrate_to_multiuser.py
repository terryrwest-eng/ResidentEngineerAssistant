"""
Daily Reporter — moving single-user data into the first user's directory.

Before multi-user, everything lived directly under the storage root:

    <root>/reporter.db  reports/  photos/  specs/  schedules/  dispatches/
           backfill/  settings.json  extension_context.json

Now each user owns a tree under <root>/users/<user-id>/. This moves the old
layout into one user's tree, once.

WHEN IT RUNS
On the first admin's registration, and only when there is old data sitting in
the root. That is the only moment the answer is unambiguous: whoever claims the
app is the person whose reports those already are.

HOW IT AVOIDS LOSING ANYTHING
  - Moves, never copies-then-deletes, so there is no window where a file exists
    in neither place.
  - Refuses to overwrite. If a destination already exists the source is left
    alone and reported, rather than one clobbering the other.
  - Leaves a marker so it cannot run twice.
  - Any failure is logged and skipped, not raised: a half-migrated tree with the
    remainder still in the root is recoverable by hand, whereas a failed request
    that leaves the user unable to register is not.
"""

import logging
import os
import shutil
import sqlite3

from app.core.paths import ROOT_DIR, ensure_user_dirs, user_root

logger = logging.getLogger(__name__)

# Everything the single-user layout put directly in the root.
LEGACY_DIRS = ["reports", "photos", "specs", "schedules", "dispatches", "backfill"]
LEGACY_FILES = [
    "reporter.db",
    "reporter.db-wal",
    "reporter.db-shm",
    "settings.json",
    "extension_context.json",
]

MARKER = ".migrated-to-multiuser"


def has_legacy_data() -> bool:
    """True when the root still holds a single-user layout worth moving."""
    if os.path.exists(os.path.join(ROOT_DIR, MARKER)):
        return False
    for name in LEGACY_DIRS:
        path = os.path.join(ROOT_DIR, name)
        if os.path.isdir(path) and os.listdir(path):
            return True
    for name in LEGACY_FILES:
        if os.path.isfile(os.path.join(ROOT_DIR, name)):
            return True
    return False


def _repoint_report_paths(destination: str, result: dict[str, list[str]]) -> None:
    """
    Rewrite the reports index to point at where the files now are.

    WHY THIS IS NOT OPTIONAL

    The reports table stores each report's JSON file as an ABSOLUTE path, and
    moving the files does not change it. Left alone, every adopted report still
    LISTS correctly — the list comes from the index — and then fails to open,
    because the path in the row points at a directory that no longer has the
    file. A history full of reports that 404 is a worse outcome than an obvious
    failure, because it looks like the data is gone.

    Only the filename is reused; the directory is replaced with the user's own.
    Rows whose file is genuinely absent are left untouched rather than pointed
    somewhere wrong.
    """
    db = os.path.join(destination, "reporter.db")
    if not os.path.isfile(db):
        return

    new_reports_dir = os.path.join(destination, "reports")
    try:
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        try:
            has_table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='reports'"
            ).fetchone()
            if not has_table:
                return

            repointed = 0
            for row in conn.execute("SELECT id, file_path FROM reports").fetchall():
                filename = os.path.basename(row["file_path"] or "")
                if not filename:
                    continue
                candidate = os.path.join(new_reports_dir, filename)
                if not os.path.isfile(candidate):
                    logger.warning(
                        f"Report {row['id']} indexed at {row['file_path']} has no file "
                        f"at {candidate} — leaving the row alone"
                    )
                    result["skipped"].append(row["file_path"])
                    continue
                if candidate != row["file_path"]:
                    conn.execute(
                        "UPDATE reports SET file_path = ? WHERE id = ?",
                        (candidate, row["id"]),
                    )
                    repointed += 1
            conn.commit()
            if repointed:
                logger.info(f"Repointed {repointed} report file paths into {new_reports_dir}")
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        # A database we cannot read is worth reporting, not worth failing
        # registration over — the lazy repair in get_report still covers it.
        logger.error(f"Could not repoint report paths in {db}: {exc}")
        result["failed"].append(db)


def migrate_legacy_data_to(user_id: str) -> dict[str, list[str]]:
    """
    Move the old single-user layout into user_id's tree.

    Returns what was moved and what was skipped. Safe to call when there is
    nothing to do.
    """
    result: dict[str, list[str]] = {"moved": [], "skipped": [], "failed": []}

    if not has_legacy_data():
        return result

    destination = user_root(user_id)
    ensure_user_dirs(user_id)
    logger.info(f"Migrating single-user data in {ROOT_DIR} to user {user_id}")

    for name in LEGACY_DIRS:
        source = os.path.join(ROOT_DIR, name)
        if not os.path.isdir(source):
            continue
        target = os.path.join(destination, name)
        try:
            # ensure_user_dirs created empty destinations; moving into them
            # file by file keeps this safe if either side already has content.
            for entry in os.listdir(source):
                src_entry = os.path.join(source, entry)
                dst_entry = os.path.join(target, entry)
                if os.path.exists(dst_entry):
                    logger.warning(f"Not overwriting {dst_entry} — left {src_entry} in place")
                    result["skipped"].append(src_entry)
                    continue
                os.makedirs(target, exist_ok=True)
                shutil.move(src_entry, dst_entry)
                result["moved"].append(f"{name}/{entry}")
            # Only remove the old directory once it is genuinely empty.
            if os.path.isdir(source) and not os.listdir(source):
                os.rmdir(source)
        except OSError as exc:
            logger.error(f"Could not migrate {source}: {exc}")
            result["failed"].append(source)

    for name in LEGACY_FILES:
        source = os.path.join(ROOT_DIR, name)
        if not os.path.isfile(source):
            continue
        target = os.path.join(destination, name)
        try:
            if os.path.exists(target):
                logger.warning(f"Not overwriting {target} — left {source} in place")
                result["skipped"].append(source)
                continue
            shutil.move(source, target)
            result["moved"].append(name)
        except OSError as exc:
            logger.error(f"Could not migrate {source}: {exc}")
            result["failed"].append(source)

    _repoint_report_paths(destination, result)

    try:
        with open(os.path.join(ROOT_DIR, MARKER), "w", encoding="utf-8") as f:
            f.write(
                f"Single-user data was moved into users/{user_id} on first registration.\n"
                "Delete this file only if you intend the migration to run again.\n"
            )
    except OSError as exc:
        logger.error(f"Could not write the migration marker: {exc}")

    logger.info(
        f"Migration finished — {len(result['moved'])} moved, "
        f"{len(result['skipped'])} skipped, {len(result['failed'])} failed"
    )
    return result
