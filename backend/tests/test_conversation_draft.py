"""
Verify the parked conversation — the server side of "closing the screen costs
nothing".

WHY THIS EXISTS: the conversation kept its record only in React state. Closing
the screen threw a whole shift of answers away, twice, with nothing written
anywhere. The device now keeps a copy, and so does the server — the server copy
is what carries a conversation started on the phone over to the laptop, and
what survives losing the phone.

What matters here: it round-trips, it is atomic, it never belongs to anybody
but the person who parked it, and a draft that cannot be read costs a fresh
start rather than a broken screen. It is NOT a report and must never appear in
the report history.

Run from the repo root:  python3 backend/tests/test_conversation_draft.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, "backend")

os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-convdraft-")
)

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _auth_helper import authed_client  # noqa: E402

client = authed_client(app)

results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


DRAFT = {
    "report_date": "2026-09-12",
    "profile": "morena",
    "history": [
        {"role": "assistant", "text": "Where did you work today?"},
        {"role": "inspector", "text": "Nobel Drive and Genesee Avenue"},
        {"role": "assistant", "text": "What time did you start on Nobel?"},
    ],
    "record": {"slots": [{"key": "day::locations", "value": "Nobel Drive", "state": "ok"}]},
    "asked_keys": ["day::start_time"],
    "progress": {"total": 20, "known": 4, "suspect": 0, "empty": 16},
    "gaps": [],
    "conflicts": [],
    "ready": False,
    "typed": "we started at seven",
    "device": "the-phone",
}


# ── Nothing parked ──────────────────────────────────────────────────────────

r = client.get("/api/conversation/draft")
check("no draft reads cleanly", r.status_code == 200 and r.json()["draft"] is None, str(r.json()))


# ── Round trip ──────────────────────────────────────────────────────────────

r = client.put("/api/conversation/draft", json=DRAFT)
check("parking one succeeds", r.status_code == 200, str(r.json()))
first_saved = r.json().get("saved_at", "")
check("  and it is stamped with the server's clock", bool(first_saved), first_saved)

r = client.get("/api/conversation/draft")
got = r.json()["draft"]
check("it comes back", got is not None)
check("  the thread survives", len(got["history"]) == 3)
check("  the record survives", got["record"]["slots"][0]["key"] == "day::locations")
check("  the day it belongs to survives", got["report_date"] == "2026-09-12")
check("  what was asked survives", got["asked_keys"] == ["day::start_time"])
check("  the sentence typed but not sent survives", got["typed"] == "we started at seven")
check("  the device that wrote it survives", got["device"] == "the-phone")


# ── It is not a report ──────────────────────────────────────────────────────

r = client.get("/api/reports?limit=50")
reports = r.json().get("reports", [])
check(
    "an unfinished conversation is NOT in the report history",
    len(reports) == 0,
    f"{len(reports)} reports",
)


# ── Written again, replaced not appended ────────────────────────────────────

second = dict(DRAFT)
second["history"] = DRAFT["history"] + [{"role": "inspector", "text": "seven to three thirty"}]
r = client.put("/api/conversation/draft", json=second)
check("parking again succeeds", r.status_code == 200)
check("  with a newer stamp", r.json()["saved_at"] >= first_saved)

got = client.get("/api/conversation/draft").json()["draft"]
check("the newer conversation replaced the older", len(got["history"]) == 4)


# ── One conversation, one user ──────────────────────────────────────────────

bootstrap = TestClient(app)
r = bootstrap.post("/api/auth/register", json={
    "name": "Someone Else", "email": "other@example.com", "password": "other-password-1234",
})
# A second account arrives unapproved and gets no token — the first account is
# the admin, so it lets them in.
other_id = r.json()["user"]["id"]
client.post(f"/api/auth/users/{other_id}/approve")
r = bootstrap.post("/api/auth/login", json={
    "email": "other@example.com", "password": "other-password-1234",
})
other = {"Authorization": f"Bearer {r.json()['token']}"}

r = bootstrap.get("/api/conversation/draft", headers=other)
check(
    "another user does not see it",
    r.status_code == 200 and r.json()["draft"] is None,
    str(r.json()),
)

bootstrap.put("/api/conversation/draft", headers=other, json={
    **DRAFT, "report_date": "2026-01-01", "device": "their-laptop",
})
got = client.get("/api/conversation/draft").json()["draft"]
check(
    "and parking theirs does not overwrite ours",
    got["report_date"] == "2026-09-12" and got["device"] == "the-phone",
    str(got.get("report_date")),
)

r = bootstrap.get("/api/conversation/draft")
check("signed out, nobody sees anything", r.status_code in (401, 403), str(r.status_code))


# ── Too big to park ─────────────────────────────────────────────────────────

huge = dict(DRAFT)
huge["history"] = [{"role": "inspector", "text": "x" * 2000} for _ in range(600)]
r = client.put("/api/conversation/draft", json=huge)
check("a runaway conversation is refused", r.status_code == 413, str(r.status_code))

got = client.get("/api/conversation/draft").json()["draft"]
check("  and the good one is still there", got is not None and len(got["history"]) == 4)


# ── Unreadable on disk ──────────────────────────────────────────────────────

from app.core.paths import conversation_draft_file  # noqa: E402

path = conversation_draft_file()
with open(path, "w", encoding="utf-8") as fh:
    fh.write("{ this is not json")

r = client.get("/api/conversation/draft")
check(
    "a draft that cannot be read starts fresh instead of failing",
    r.status_code == 200 and r.json()["draft"] is None,
    str(r.status_code),
)

# It must still be writable afterwards — a corrupt file cannot wedge the page.
r = client.put("/api/conversation/draft", json=DRAFT)
check("  and parking still works after that", r.status_code == 200)
with open(path, encoding="utf-8") as fh:
    check("  leaving valid JSON on disk", isinstance(json.load(fh), dict))


# ── Released ────────────────────────────────────────────────────────────────

r = client.delete("/api/conversation/draft")
check("releasing succeeds", r.status_code == 200)
check("  and it is gone", client.get("/api/conversation/draft").json()["draft"] is None)
r = client.delete("/api/conversation/draft")
check("releasing nothing is not an error", r.status_code == 200)


failed = results.count(False)
print(f"\n{len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
