"""Verify /api/ai/parse-report now creates a real report (Task 1.1).

Before the fix this endpoint imported a nonexistent `create_report` and raised
ImportError -> HTTP 500 on every single call. Gemini is mocked so we exercise
the persistence path that was broken.
"""
import json
import sys
import types

sys.path.insert(0, "backend")

from fastapi.testclient import TestClient
from app.routers import ai as ai_router
from app.services.database import get_report

FAKE_AI_JSON = {
    "project": "Morena Conveyance Northern",
    "original_date": "2026-05-16",
    "activities": [
        {
            "work_area": "Rose Canyon - OHL - Concrete Shaft Demolition",
            "summary_html": "• Performed demolition of the concrete shaft.\n• Completed approximately 75%.",
            "manpower": [
                {"trade": "LL-04- Operator", "name": "Rael, Joe", "qty": 1, "hours": 8, "company": "OHL"},
                {"trade": "LL-03- Laborers", "name": "", "qty": 3, "hours": 8, "company": "OHL"},
            ],
            "equipment": [
                {"name": "LE-125- Skid Steer", "description": "6-033", "qty": 1, "hours": 8, "company": "OHL NA"},
            ],
        },
        {
            "work_area": "WRP - OHL - Excavation",
            "summary_html": "• Crew excavated for the 30-inch pipe.",
            "manpower": [{"trade": "LL-02- Foreman", "name": "Lopez, Salvador", "qty": 1, "hours": 10, "company": "OHL"}],
            "equipment": [],
        },
    ],
}


class FakeFile:
    name = "files/fake123"
    uri = "https://fake/files/fake123"


class FakeResponse:
    text = json.dumps(FAKE_AI_JSON)


def fake_client():
    c = types.SimpleNamespace()
    c.files = types.SimpleNamespace(upload=lambda **kw: FakeFile())
    c.models = types.SimpleNamespace(generate_content=lambda **kw: FakeResponse())
    return c, "fake-model"


ai_router._get_gemini_client = fake_client

from app.main import app  # noqa: E402

# Signs in as the first (auto-approved admin) account. Every data route now
# requires a user, and storage resolves inside that user's directory — the
# client carries the token so these checks exercise the real path.
import os as _os
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _auth_helper import authed_client  # noqa: E402
client = authed_client(app)

results = []
def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


resp = client.post(
    "/api/ai/parse-report",
    files={"file": ("05-16-2026 Summary of Work.pdf", b"%PDF-1.4 fake", "application/pdf")},
)

check("endpoint returns 200 (was 500)", resp.status_code == 200, f"HTTP {resp.status_code}: {resp.text[:200]}")

if resp.status_code == 200:
    body = resp.json()
    check("activity_count reported", body.get("activity_count") == 2, str(body.get("activity_count")))
    rid = body.get("report_id")
    check("report_id returned", bool(rid), str(rid))

    saved = get_report(rid)
    check("report actually persisted and readable", saved is not None)

    if saved:
        acts = saved.get("activities", [])
        check("both activities saved", len(acts) == 2, f"{len(acts)}")
        check("summary_html renamed to summary",
              all(a.get("summary") and "summary_html" not in a for a in acts),
              str([sorted(a.keys()) for a in acts]))
        check("every activity has an id", all(a.get("id") for a in acts),
              str([a.get("id") for a in acts]))
        ids = [r.get("id") for a in acts for k in ("manpower", "equipment") for r in a.get(k, [])]
        check("every resource row has an id", ids and all(ids), f"{len(ids)} rows, all set={all(ids)}")
        check("ids are unique", len(set(ids)) == len(ids), f"{len(set(ids))}/{len(ids)} unique")
        check("project name captured", saved["general"]["project_name"] == "Morena Conveyance Northern",
              saved["general"]["project_name"])

    # Word export of the imported report must contain the bullets
    w = client.get(f"/api/export/{rid}/word")
    check("word export 200", w.status_code == 200, f"HTTP {w.status_code}")
    if w.status_code == 200:
        import io
        from docx import Document
        doc = Document(io.BytesIO(w.content))
        text = "\n".join(p.text for p in doc.paragraphs)
        check("word export contains imported summary text",
              "demolition of the concrete shaft" in text and "30-inch pipe" in text)

print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
