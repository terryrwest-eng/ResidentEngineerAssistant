"""
Verification: users cannot reach each other's data.

This is the test that matters for the multi-user change. Everything else is
plumbing; the promise is that two people using the app see only their own
reports, settings and trackers, and that an unauthenticated caller sees nothing.

Run from the repo root:
    DAILY_REPORTER_DATA_DIR=/tmp/rea-mu python3 backend/tests/test_multiuser.py

Uses a scratch data directory so it never touches real reports.
"""

import os
import shutil
import sys
import tempfile

# Scratch storage BEFORE app imports — paths read the env var at import time.
_TEST_ROOT = tempfile.mkdtemp(prefix="rea-multiuser-")
os.environ["DAILY_REPORTER_DATA_DIR"] = _TEST_ROOT

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)

results: list[bool] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    results.append(bool(condition))
    print(f"{'PASS' if condition else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
    return bool(condition)


def register(name: str, email: str, password: str = "correct-horse-battery"):
    return client.post("/api/auth/register",
                       json={"name": name, "email": email, "password": password})


def login(email: str, password: str = "correct-horse-battery"):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


print("=" * 70)
print("MULTI-USER ISOLATION")
print("=" * 70)

# ── Nothing is reachable without signing in ──
print("\n--- an unauthenticated caller gets nothing ---")
for path in ["/api/reports", "/api/settings", "/api/trackers/excavation"]:
    r = client.get(path)
    check(f"{path} refuses anonymous access", r.status_code == 401, f"HTTP {r.status_code}")

r = client.get("/api/health")
check("health check stays public", r.status_code == 200, f"HTTP {r.status_code}")

r = client.get("/api/auth/setup-state")
check("setup state is public and reports an unclaimed app",
      r.status_code == 200 and r.json()["needs_first_user"] is True)

# ── First user becomes the admin ──
print("\n--- registration ---")
r = register("Terry", "terry@example.com")
check("first registration succeeds", r.status_code == 201, f"HTTP {r.status_code}")
first = r.json()
check("first user is an approved admin",
      first["user"]["role"] == "admin" and first["user"]["is_approved"] is True)
check("first user gets a token immediately", bool(first["token"]))
admin_token = first["token"]
admin_id = first["user"]["id"]

r = client.get("/api/auth/setup-state")
check("setup state flips once claimed", r.json()["needs_first_user"] is False)

# ── Second user must wait for approval ──
r = register("Sam", "sam@example.com")
check("second registration succeeds", r.status_code == 201, f"HTTP {r.status_code}")
second = r.json()
check("second user is NOT approved", second["user"]["is_approved"] is False)
check("second user gets no token", second["token"] is None)
sam_id = second["user"]["id"]

r = login("sam@example.com")
check("unapproved user cannot sign in", r.status_code == 403, f"HTTP {r.status_code}")

r = register("Imposter", "TERRY@example.com")
check("duplicate email is refused case-insensitively", r.status_code == 400,
      f"HTTP {r.status_code}")

r = login("terry@example.com", "wrong-password")
check("wrong password is refused", r.status_code == 401, f"HTTP {r.status_code}")
check("wrong password says nothing about whether the email exists",
      "incorrect" in r.json().get("detail", "").lower())

r = client.post("/api/auth/register",
                json={"name": "Shorty", "email": "s@example.com", "password": "abc"})
check("short password is refused", r.status_code == 400, f"HTTP {r.status_code}")

# ── Approval ──
print("\n--- approval is admin-only ---")
r = client.get("/api/auth/users")
check("listing users needs authentication", r.status_code == 401, f"HTTP {r.status_code}")

r = client.post(f"/api/auth/users/{sam_id}/approve", headers=auth(admin_token))
check("admin can approve", r.status_code == 200, f"HTTP {r.status_code}")

r = login("sam@example.com")
check("approved user can now sign in", r.status_code == 200, f"HTTP {r.status_code}")
sam_token = r.json()["token"]

r = client.get("/api/auth/users", headers=auth(sam_token))
check("a normal user cannot list users", r.status_code == 403, f"HTTP {r.status_code}")

r = client.post(f"/api/auth/users/{admin_id}/revoke", headers=auth(sam_token))
check("a normal user cannot revoke the admin", r.status_code == 403, f"HTTP {r.status_code}")

# ── The actual promise: separate data ──
print("\n--- reports are private ---")
terry_report = {
    "general": {"project_name": "Terry Project", "report_date": "2026-08-05",
                "project_number": "T-1", "project_location": "", "inspector_name": "Terry",
                "resident_engineer": "", "start_time": "07:00", "end_time": "15:30",
                "sky_conditions": [], "temperature_high": "", "temperature_low": "",
                "wind_info": "", "notes": ""},
    "activities": [],
}
sam_report = {
    "general": {**terry_report["general"], "project_name": "Sam Project",
                "project_number": "S-1", "inspector_name": "Sam"},
    "activities": [],
}

r = client.post("/api/reports", json=terry_report, headers=auth(admin_token))
check("Terry can save a report", r.status_code in (200, 201), f"HTTP {r.status_code}")
terry_report_id = r.json().get("id", "")

r = client.post("/api/reports", json=sam_report, headers=auth(sam_token))
check("Sam can save a report", r.status_code in (200, 201), f"HTTP {r.status_code}")
sam_report_id = r.json().get("id", "")

r = client.get("/api/reports", headers=auth(admin_token))
terry_list = r.json() if isinstance(r.json(), list) else r.json().get("reports", [])
names = [x.get("project_name") for x in terry_list]
check("Terry sees exactly one report — his own",
      len(terry_list) == 1 and names == ["Terry Project"], f"saw {names}")

r = client.get("/api/reports", headers=auth(sam_token))
sam_list = r.json() if isinstance(r.json(), list) else r.json().get("reports", [])
names = [x.get("project_name") for x in sam_list]
check("Sam sees exactly one report — his own",
      len(sam_list) == 1 and names == ["Sam Project"], f"saw {names}")

r = client.get(f"/api/reports/{sam_report_id}", headers=auth(admin_token))
check("Terry cannot fetch Sam's report by its id", r.status_code == 404,
      f"HTTP {r.status_code}")

r = client.delete(f"/api/reports/{sam_report_id}", headers=auth(admin_token))
check("Terry cannot delete Sam's report", r.status_code == 404, f"HTTP {r.status_code}")

r = client.get(f"/api/reports/{sam_report_id}", headers=auth(sam_token))
check("Sam's report still exists afterwards", r.status_code == 200, f"HTTP {r.status_code}")

# ── Settings are private ──
print("\n--- settings are private ---")
client.put("/api/settings", json={"default_project": "Terry Default"}, headers=auth(admin_token))
client.put("/api/settings", json={"default_project": "Sam Default"}, headers=auth(sam_token))

r = client.get("/api/settings", headers=auth(admin_token))
check("Terry reads his own default project",
      r.json().get("default_project") == "Terry Default", str(r.json().get("default_project")))

r = client.get("/api/settings", headers=auth(sam_token))
check("Sam reads his own default project",
      r.json().get("default_project") == "Sam Default", str(r.json().get("default_project")))

# ── Trackers are private ──
print("\n--- trackers are private ---")
client.post("/api/trackers/excavation",
            json={"date": "2026-08-05", "station_from": "10+00", "station_to": "11+00",
                  "depth": "4ft", "soil_type": "clay", "notes": "Terry entry"},
            headers=auth(admin_token))

r = client.get("/api/trackers/excavation", headers=auth(sam_token))
entries = r.json() if isinstance(r.json(), list) else r.json().get("entries", [])
check("Sam's excavation tracker is empty", len(entries) == 0, f"saw {len(entries)}")

r = client.get("/api/trackers/excavation", headers=auth(admin_token))
entries = r.json() if isinstance(r.json(), list) else r.json().get("entries", [])
check("Terry's excavation tracker has his entry", len(entries) == 1, f"saw {len(entries)}")

# ── Storage really is separate on disk ──
print("\n--- separate directories on disk ---")
users_root = os.path.join(_TEST_ROOT, "users")
check("each user has their own directory",
      os.path.isdir(os.path.join(users_root, admin_id))
      and os.path.isdir(os.path.join(users_root, sam_id)))
check("each user has their own database",
      os.path.isfile(os.path.join(users_root, admin_id, "reporter.db"))
      and os.path.isfile(os.path.join(users_root, sam_id, "reporter.db")))
check("identity lives outside every user directory",
      os.path.isfile(os.path.join(_TEST_ROOT, "auth.db")))

# ── Revoking takes effect immediately ──
print("\n--- revoked access stops working at once ---")
r = client.post(f"/api/auth/users/{sam_id}/revoke", headers=auth(admin_token))
check("admin can revoke Sam", r.status_code == 200, f"HTTP {r.status_code}")

r = client.get("/api/reports", headers=auth(sam_token))
check("Sam's existing token stops working straight away", r.status_code == 403,
      f"HTTP {r.status_code}")

r = client.post(f"/api/auth/users/{admin_id}/revoke", headers=auth(admin_token))
check("the last admin cannot revoke themselves", r.status_code == 400, f"HTTP {r.status_code}")

r = client.delete(f"/api/auth/users/{admin_id}", headers=auth(admin_token))
check("the last admin cannot delete themselves", r.status_code == 400, f"HTTP {r.status_code}")

# ── Bad tokens ──
print("\n--- bad tokens ---")
r = client.get("/api/reports", headers=auth("not-a-real-token"))
check("a garbage token is refused", r.status_code == 401, f"HTTP {r.status_code}")

r = client.get("/api/reports", headers={"Authorization": "Bearer "})
check("an empty bearer token is refused", r.status_code == 401, f"HTTP {r.status_code}")

# ── Download tokens ──
#
# Android cannot download a blob inside the Capacitor WebView, so the export URL
# is handed to the SYSTEM BROWSER — a different application, with no access to
# this app's session and no way to set an Authorization header. Requiring a
# bearer header on the export routes silently stopped the phone saving the Word
# copy it has always saved. A short-lived token in the query string is what that
# browser can carry; these checks are what stop it becoming a way around auth.
print("\n--- download tokens ---")

# Re-approve Sam, revoked above, so there are two live accounts again.
client.post(f"/api/auth/users/{sam_id}/approve", headers=auth(admin_token))
sam_token = client.post(
    "/api/auth/login",
    json={"email": "sam@example.com", "password": "correct-horse-battery"},
).json()["token"]

r = client.get("/api/auth/download-token", headers=auth(admin_token))
check("a signed-in user can mint a download token", r.status_code == 200, f"HTTP {r.status_code}")
terry_dl = r.json().get("token", "")

r = client.get("/api/auth/download-token")
check("an anonymous caller cannot mint one", r.status_code == 401, f"HTTP {r.status_code}")

r = client.get(f"/api/export/{terry_report_id}/word")
check("export refuses a request with no credentials at all",
      r.status_code == 401, f"HTTP {r.status_code}")

r = client.get(f"/api/export/{terry_report_id}/word?t={terry_dl}")
check("export works with the token in the URL and no header",
      r.status_code == 200, f"HTTP {r.status_code}")
check("and returns a real Word document",
      r.content[:2] == b"PK" and len(r.content) > 1000, f"{len(r.content)} bytes")

# The token must open a download and nothing else.
r = client.get("/api/reports", headers=auth(terry_dl))
check("a download token is not accepted as a session", r.status_code == 401, f"HTTP {r.status_code}")

r = client.get(f"/api/settings?t={terry_dl}")
check("a download token does not work on other routes", r.status_code == 401, f"HTTP {r.status_code}")

# And it must not cross between users.
sam_dl = client.get("/api/auth/download-token", headers=auth(sam_token)).json()["token"]
r = client.get(f"/api/export/{terry_report_id}/word?t={sam_dl}")
check("Sam's download token cannot fetch Terry's report",
      r.status_code == 404, f"HTTP {r.status_code}")

r = client.get(f"/api/export/{terry_report_id}/word?t=nonsense")
check("a forged download token is refused", r.status_code == 401, f"HTTP {r.status_code}")

shutil.rmtree(_TEST_ROOT, ignore_errors=True)

print("\n" + "=" * 70)
passed, total = sum(results), len(results)
print(f"{passed}/{total} passed")
print("=" * 70)
sys.exit(0 if passed == total else 1)
