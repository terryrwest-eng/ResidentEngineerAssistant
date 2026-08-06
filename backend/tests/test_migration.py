"""
Verification: existing single-user data survives the move to multi-user.

There is exactly one shot at this on the real deployment — the first time
somebody registers, whatever is already on the volume gets adopted. If it goes
wrong, the reports are gone or orphaned. So this builds a realistic old-layout
directory and checks every file arrives.

Run:  python3 backend/tests/test_migration.py
"""

import json
import os
import sqlite3
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

_TEST_ROOT = tempfile.mkdtemp(prefix="rea-migration-")
os.environ["DAILY_REPORTER_DATA_DIR"] = _TEST_ROOT

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

results: list[bool] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    results.append(bool(condition))
    print(f"{'PASS' if condition else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
    return bool(condition)


print("=" * 70)
print("MIGRATION OF EXISTING SINGLE-USER DATA")
print("=" * 70)

# ── Build an old-layout directory, the way the app left it before multi-user ──
print("\n--- staging a pre-multi-user data directory ---")

os.makedirs(os.path.join(_TEST_ROOT, "reports"), exist_ok=True)
os.makedirs(os.path.join(_TEST_ROOT, "photos", "report-1"), exist_ok=True)
os.makedirs(os.path.join(_TEST_ROOT, "specs"), exist_ok=True)
os.makedirs(os.path.join(_TEST_ROOT, "schedules", "sched-1"), exist_ok=True)
os.makedirs(os.path.join(_TEST_ROOT, "dispatches", "2026-06-08"), exist_ok=True)
os.makedirs(os.path.join(_TEST_ROOT, "backfill", "batch-1"), exist_ok=True)
os.makedirs(os.path.join(_TEST_ROOT, "trackers"), exist_ok=True)

staged = {
    "reports/2026-07-30_Morena_abc12345.json": json.dumps({
        "id": "abc12345",
        "general": {"project_name": "Morena Conveyance", "report_date": "2026-07-30"},
        "activities": [{
            "id": "a1", "work_area": "North trench", "stations": "",
            "summary": "\u2022 Excavated the north trench",
            "manpower": [], "equipment": [], "extra_work_manpower": [],
            "extra_work_equipment": [], "consultant_manpower": [],
        }],
    }),
    "photos/report-1/site.jpg": "not-really-a-jpeg",
    "specs/spec-notes.txt": "spec",
    "schedules/sched-1/sched-1.json": json.dumps({"filename": "digout.pdf"}),
    "dispatches/2026-06-08/parsed.json": json.dumps({"company": "Paving Co"}),
    "backfill/batch-1/status.json": json.dumps({"state": "done"}),
    "settings.json": json.dumps({"default_project": "Morena Conveyance"}),
    "extension_context.json": json.dumps({"report_id": "abc12345"}),
}
for rel, content in staged.items():
    path = os.path.join(_TEST_ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

# A REAL SQLite database, not placeholder bytes — the point is to prove the
# actual database moves and is still usable afterwards, which a junk file could
# never show.
_legacy_db = os.path.join(_TEST_ROOT, "reporter.db")
_conn = sqlite3.connect(_legacy_db)
_conn.executescript("""
    CREATE TABLE reports (
        id TEXT PRIMARY KEY, project_name TEXT NOT NULL DEFAULT '',
        project_number TEXT NOT NULL DEFAULT '', report_date TEXT NOT NULL DEFAULT '',
        inspector_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        activity_count INTEGER NOT NULL DEFAULT 0, file_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
""")
_conn.execute(
    "INSERT INTO reports (id, project_name, report_date, status, activity_count, "
    "file_path, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ("abc12345", "Morena Conveyance", "2026-07-30", "draft", 1,
     os.path.join(_TEST_ROOT, "reports", "2026-07-30_Morena_abc12345.json"),
     "2026-07-30T00:00:00", "2026-07-30T00:00:00"),
)
_conn.commit()
_conn.close()
staged["reporter.db"] = "<real sqlite database>"

check("staged an old-layout directory", len(staged) == 9, f"{len(staged)} items")

# ── Registering the first user adopts it ──
print("\n--- first registration adopts the existing data ---")
client = TestClient(app)
r = client.post("/api/auth/register",
                json={"name": "Terry", "email": "terry@example.com",
                      "password": "correct-horse-battery"})
check("registration succeeds", r.status_code == 201, f"HTTP {r.status_code}")
payload = r.json()
user_id = payload["user"]["id"]

check("migration reported moved items", len(payload.get("migrated", [])) > 0,
      f"{len(payload.get('migrated', []))} moved")
check("nothing was skipped or failed",
      len(payload.get("migration_skipped", [])) == 0,
      str(payload.get("migration_skipped")))

# ── Every file landed in the user's tree ──
print("\n--- every file arrived ---")
user_dir = os.path.join(_TEST_ROOT, "users", user_id)
for rel in staged:
    check(f"{rel} moved into the user's directory",
          os.path.isfile(os.path.join(user_dir, rel)))

with open(os.path.join(user_dir, "reports/2026-07-30_Morena_abc12345.json"), encoding="utf-8") as f:
    moved = json.load(f)
check("report contents are intact",
      moved["general"]["project_name"] == "Morena Conveyance",
      moved["general"]["project_name"])
check("the activity survived the move on disk",
      len(moved["activities"]) == 1 and moved["activities"][0]["work_area"] == "North trench")

with open(os.path.join(user_dir, "settings.json"), encoding="utf-8") as f:
    moved_settings = json.load(f)
check("settings survived", moved_settings.get("default_project") == "Morena Conveyance")

# ── The root is left clean ──
print("\n--- the old locations are cleared ---")
for rel in ["reports", "photos", "specs", "schedules", "dispatches", "backfill"]:
    check(f"{rel}/ no longer sits in the storage root",
          not os.path.isdir(os.path.join(_TEST_ROOT, rel)))
for rel in ["settings.json", "reporter.db", "extension_context.json"]:
    check(f"{rel} no longer sits in the storage root",
          not os.path.isfile(os.path.join(_TEST_ROOT, rel)))

check("a marker records that the migration ran",
      os.path.isfile(os.path.join(_TEST_ROOT, ".migrated-to-multiuser")))

# ── The adopted data is actually readable through the API ──
print("\n--- the adopted reports are usable ---")
token = payload["token"]
r = client.get("/api/reports", headers={"Authorization": f"Bearer {token}"})
_body = r.json()
_adopted = _body if isinstance(_body, list) else _body.get("reports", [])
check("the adopted report is listed through the API",
      any(x.get("project_name") == "Morena Conveyance" for x in _adopted),
      f"saw {[x.get('project_name') for x in _adopted]}")

# OPENING one is the check that matters, and its absence is what let a real bug
# through: the reports index stores an absolute file path, so after the move
# every adopted report still LISTED correctly — the list is built from the index
# — and then 404'd on open, because the path pointed at the old directory.
# Listing proves the index survived; only opening proves the data is reachable.
_report_id = next((x.get("id") for x in _adopted
                   if x.get("project_name") == "Morena Conveyance"), "")
check("the adopted report has an id to open", bool(_report_id), str(_report_id))

r = client.get(f"/api/reports/{_report_id}", headers={"Authorization": f"Bearer {token}"})
check("the adopted report OPENS", r.status_code == 200, f"HTTP {r.status_code}")

_full = r.json() if r.status_code == 200 else {}
_full = _full.get("report", _full)
check("its general info is intact",
      _full.get("general", {}).get("project_name") == "Morena Conveyance",
      str(_full.get("general", {}).get("project_name")))
_acts = _full.get("activities", [])
check("its activities came with it", len(_acts) == 1, f"{len(_acts)} activities")
check("the activity's work area survived",
      bool(_acts) and _acts[0].get("work_area") == "North trench",
      str(_acts[0].get("work_area")) if _acts else "(none)")

# The index should point at the new location, not be limping along on the
# lazy repair in get_report.
_db = os.path.join(user_dir, "reporter.db")
_conn2 = sqlite3.connect(_db)
_stored = _conn2.execute("SELECT file_path FROM reports WHERE id = ?", (_report_id,)).fetchone()
_conn2.close()
check("the index points inside the user's directory",
      bool(_stored) and _stored[0].startswith(user_dir),
      str(_stored[0]) if _stored else "(no row)")
check("the file the index names actually exists",
      bool(_stored) and os.path.isfile(_stored[0]))

r = client.get("/api/settings", headers={"Authorization": f"Bearer {token}"})
check("the adopted settings load through the API",
      r.status_code == 200 and r.json().get("default_project") == "Morena Conveyance",
      str(r.json().get("default_project")))

# ── A second user gets nothing ──
print("\n--- the second user starts empty ---")
r = client.post("/api/auth/register",
                json={"name": "Sam", "email": "sam@example.com",
                      "password": "correct-horse-battery"})
sam_id = r.json()["user"]["id"]
client.post(f"/api/auth/users/{sam_id}/approve", headers={"Authorization": f"Bearer {token}"})
r = client.post("/api/auth/login",
                json={"email": "sam@example.com", "password": "correct-horse-battery"})
sam_token = r.json()["token"]

r = client.get("/api/reports", headers={"Authorization": f"Bearer {sam_token}"})
body = r.json()
reports = body if isinstance(body, list) else body.get("reports", [])
check("the second user inherits none of it", len(reports) == 0, f"saw {len(reports)}")

r = client.get("/api/settings", headers={"Authorization": f"Bearer {sam_token}"})
check("the second user does not inherit the settings",
      r.json().get("default_project") in ("", None), str(r.json().get("default_project")))

# ── Running twice does nothing ──
print("\n--- the migration cannot run twice ---")
from app.services.migrate_to_multiuser import has_legacy_data, migrate_legacy_data_to  # noqa: E402

check("no legacy data is detected afterwards", has_legacy_data() is False)
again = migrate_legacy_data_to(sam_id)
check("re-running moves nothing", len(again["moved"]) == 0, str(again))

shutil.rmtree(_TEST_ROOT, ignore_errors=True)

print("\n" + "=" * 70)
passed, total = sum(results), len(results)
print(f"{passed}/{total} passed")
print("=" * 70)
sys.exit(0 if passed == total else 1)
