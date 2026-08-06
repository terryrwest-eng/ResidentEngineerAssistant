"""
Regression test: a create must NEVER overwrite an existing report.

Opening a new report on a day that already has one used to adopt that report's
ID and replace its contents — a finished day's work destroyed by opening a blank
report and typing one character. The server now returns 409 having written
nothing, and the user decides whether to open the existing report or keep both.

Run:  python backend/tests/test_duplicate_date_guard.py
Needs: fastapi, httpx (already in backend/requirements.txt)
"""
import os, sys, tempfile, shutil

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Scratch storage must be set BEFORE app.core.paths is imported — it reads the
# env var once, at import time.
#
# This replaced monkeypatching db.DB_PATH and db.REPORTS_DIR. Those were
# module-level constants; storage is per-user now, so they are functions that
# resolve against whoever is asking, and assigning to the old names quietly did
# nothing at all.
from _auth_helper import use_scratch_storage, authed_client  # noqa: E402

tmp = use_scratch_storage("rea-dupguard-")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from app.routers.reports import router  # noqa: E402
from app.routers.auth import router as auth_router  # noqa: E402

# The auth router comes along so the client has an account to sign in as; the
# reports routes require one.
api = FastAPI(); api.include_router(auth_router); api.include_router(router)
c = authed_client(api)

DATE = "2026-07-30"
PROJ = "Morena Conveyance"

def get_all():
    return c.get("/api/reports").json()["reports"]

print("1. Save a finished report for the day (7 activities)")
r = c.post("/api/reports", json={
    "general": {"report_date": DATE, "project_name": PROJ},
    "activities": [{"id": str(i), "work_area": f"real work {i}"} for i in range(7)],
})
assert r.status_code == 200, r.text
finished_id = r.json()["id"]
print(f"   created {finished_id[:8]} with 7 activities")

print("\n2. Open a NEW report for the same day + project, type one character")
r2 = c.post("/api/reports", json={
    "general": {"report_date": DATE, "project_name": PROJ},
    "activities": [],
})
print(f"   server responded {r2.status_code}")
assert r2.status_code == 409, f"EXPECTED 409, GOT {r2.status_code} — OVERWRITE RISK"
d = r2.json()["detail"]
assert d["existing_id"] == finished_id
print(f"   409 with existing_id={d['existing_id'][:8]} — refused, nothing written")

print("\n3. Is the finished report intact?")
still = c.get(f"/api/reports/{finished_id}").json()
assert len(still["activities"]) == 7, f"DATA LOSS: {len(still['activities'])} activities left"
print(f"   yes — still has {len(still['activities'])} activities")
assert len(get_all()) == 1, f"expected 1 report, found {len(get_all())}"
print(f"   and there is still exactly {len(get_all())} report for the day")

print("\n4. User answers 'Keep both' -> allow_duplicate")
r3 = c.post("/api/reports", json={
    "general": {"report_date": DATE, "project_name": PROJ},
    "activities": [], "allow_duplicate": True,
})
assert r3.status_code == 200, r3.text
assert r3.json()["id"] != finished_id
print(f"   created a separate report {r3.json()['id'][:8]}; now {len(get_all())} reports")

print("\n5. Finished report STILL intact after keep-both")
still2 = c.get(f"/api/reports/{finished_id}").json()
assert len(still2["activities"]) == 7
print(f"   yes — {len(still2['activities'])} activities")

print("\n6. Blank-project report must NOT touch the real project's report")
r4 = c.post("/api/reports", json={
    "general": {"report_date": DATE, "project_name": ""}, "activities": [],
})
assert r4.status_code == 200, "blank project should be a separate report, not a 409 onto Morena"
assert r4.json()["id"] not in (finished_id,)
still3 = c.get(f"/api/reports/{finished_id}").json()
assert len(still3["activities"]) == 7
print(f"   separate report created; Morena report still has {len(still3['activities'])} activities")

print("\n7. allow_duplicate must not leak into stored data")
saved = c.get(f"/api/reports/{r3.json()['id']}").json()
assert "allow_duplicate" not in saved, "allow_duplicate leaked into the saved report!"
print("   clean — flag was popped before saving")

shutil.rmtree(tmp, ignore_errors=True)
print("\n=== ALL CHECKS PASSED — no path overwrites a finished report ===")
