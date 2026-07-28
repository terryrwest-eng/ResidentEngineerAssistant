"""Verify the extension context survives multiple server workers.

WHY THIS EXISTS: the active-report pointer was a module-level dict. Production
runs `uvicorn --workers 2`, so there were two of them, one per process. The web
app POSTs the context to whichever worker answers; the Chrome extension — a
separate browser process on its own connection — GETs from whichever worker
answers it.

Measured against production before the fix: of 20 reads after a write, 11
returned the report just set and 9 returned a stale ID left in the other
worker's memory. The user's PMWeb grid was being filled from the wrong day
about half the time.

The fix is to keep the pointer in a file on the shared data volume. This test
simulates a second worker by importing a fresh module instance and confirming
it sees what the first one wrote.
"""
import importlib
import os
import sys
import tempfile

sys.path.insert(0, "backend")

os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-extctx-")
)

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402
from app.services.database import init_database  # noqa: E402

init_database()
client = TestClient(app)

results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# ── Basic round trip ────────────────────────────────────────────────────────

r = client.get("/api/extension/context")
check("empty context reads cleanly", r.status_code == 200, str(r.json()))

r = client.post("/api/extension/context", json={"report_id": "report-alpha"})
check("set returns success", r.json().get("report_id") == "report-alpha", str(r.json()))

r = client.get("/api/extension/context")
check("reads back what was set", r.json().get("report_id") == "report-alpha", str(r.json()))


# ── The actual bug: a SECOND worker must see it ─────────────────────────────
# Re-importing the router gives a fresh module object with fresh module-level
# state — which is what a second uvicorn worker has. Before the fix this
# returned None, because the value lived in that module's dict.

import app.routers.reports as reports_module  # noqa: E402

reloaded = importlib.reload(reports_module)
second_worker_view = reloaded._read_context()
check(
    "a second worker sees the same context (THE BUG)",
    second_worker_view.get("report_id") == "report-alpha",
    str(second_worker_view),
)

# And a write from the second worker is visible to the first.
reloaded._write_context("report-beta")
r = client.get("/api/extension/context")
check(
    "a write from another worker is visible here",
    r.json().get("report_id") == "report-beta",
    str(r.json()),
)


# ── Clearing ────────────────────────────────────────────────────────────────

client.post("/api/extension/context", json={"report_id": None})
r = client.get("/api/extension/context")
check("clearing works", r.json().get("report_id") is None, str(r.json()))

r = client.post("/api/extension/context", json={})
check("missing key clears rather than erroring", r.status_code == 200, str(r.json()))


# ── The picker endpoint ─────────────────────────────────────────────────────

r = client.get("/api/extension/reports")
check("picker endpoint responds", r.status_code == 200, f"HTTP {r.status_code}")
body = r.json()
check("picker returns a reports array", isinstance(body.get("reports"), list))

# Seed two reports on ONE date — the split-shift case, which is the whole
# reason the picker shows shift times.
for start, end, area in [("06:30", "15:00", "Genesee - OHL - Paving"),
                         ("18:30", "05:00", "Marian Bear - OHL - Blowoff")]:
    client.post("/api/reports", json={
        "general": {
            "project_name": "Morena Conveyance Northern",
            "report_date": "2026-07-27",
            "start_time": start, "end_time": end,
        },
        "activities": [{"work_area": area, "summary": "", "manpower": [], "equipment": []}],
        "status": "draft",
    })

r = client.get("/api/extension/reports")
reports = r.json()["reports"]
same_day = [x for x in reports if x["report_date"] == "2026-07-27"]
check("both split-shift reports are listed", len(same_day) == 2, f"{len(same_day)} found")
check(
    "split shifts are distinguishable by their times",
    len({x["start_time"] for x in same_day}) == 2,
    str([x["start_time"] for x in same_day]),
)
check(
    "each entry carries its activity names",
    all(x["activities"] for x in same_day),
    str([x["activities"] for x in same_day]),
)
check(
    "earlier shift is listed first within the day",
    same_day[0]["start_time"] < same_day[1]["start_time"],
    str([x["start_time"] for x in same_day]),
)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
