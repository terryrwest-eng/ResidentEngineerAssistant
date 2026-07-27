"""Verify the Backfill wizard: scope rule, date checksum, and no-fabrication guards (Task 5.1).

Gemini is mocked, Open-Meteo is mocked. Runs offline and costs nothing.

The checks that matter most here are the ones that protect the output from being
quietly wrong: a struck-through worker must not become phantom labor, the 805
tunnel crew must come out of the report but stay visible in the audit trail, and
a tunnel-only day must produce NO report rather than an empty one.
"""
import io
import json
import os
import sys
import tempfile
import types
import zipfile

sys.path.insert(0, "backend")

# Scratch data dir — never touch real reports. Must be set before app imports.
os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-backfill-test-")
)

from fastapi.testclient import TestClient  # noqa: E402
from app.routers import ai as ai_router  # noqa: E402
from app.routers import backfill as backfill_router  # noqa: E402
from app.routers import weather as weather_router  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# ── Fake Gemini ─────────────────────────────────────────────────────────────

class FakeReason:
    def __init__(self, name):
        self.name = name


class FakeCandidate:
    def __init__(self, reason="STOP"):
        self.finish_reason = FakeReason(reason)


class FakeResponse:
    def __init__(self, text, reason="STOP"):
        self.text = text
        self.candidates = [FakeCandidate(reason)]


# Two crew sheets for 2026-01-13. Sheet 1 is Juan Higuera on the conveyance —
# in scope. Sheet 2 is Rey Villa on the 805 tunnel — out of scope. Sheet 1 has a
# struck-through worker and an illegible name, both of which must survive intact.
PASS1_TWO_SHEETS = """SHEET 1
  JOB NUMBER: C-346
  JOB NAME: Morena ps & conv.
  DATE ON SHEET: 1-13-25
  FOREMAN: Juan Higuera
  SHIFT: 6:30 AM to 3:00 PM
  LABOR:
    - Higuera, Juan | Foreman | RT: 8 | OT: 0 | DT: 0 | WORKED
    - Salado, Ubaldo | Laborer | RT: 8 | OT: 2 | DT: 0 | WORKED
    - Ramirez, Hector | Laborer | RT: 8 | OT: 0 | DT: 0 | STRUCK THROUGH — DID NOT WORK
    - [illegible] | Laborer | RT: 8 | OT: 0 | DT: 0 | WORKED
  COMPANY EQUIPMENT:
    - CAT 330 Excavator | 8
  RENTED EQUIPMENT:
    - Dewatering Pump | United Rentals
  SUBCONTRACTORS / 3RD PARTY:
    - Hudson | traffic control | 1 flagger
  SUMMARY OF WORK COMPLETED TODAY:
    Continued blow off install. Backfilled and compacted.
  ILLEGIBLE / UNCERTAIN:
    - fourth labor row name could not be read

SHEET 2
  JOB NUMBER: C-0346
  JOB NAME: Morena Convey: 805 Tunnel
  DATE ON SHEET: 1-13-26
  FOREMAN: Rey Villa
  SHIFT: 7:00 PM to 3:30 AM
  LABOR:
    - Villa, Rey | Foreman | RT: 8 | OT: 0 | DT: 0 | WORKED
  COMPANY EQUIPMENT:
    - Tunnel Mucker | 8
  SUMMARY OF WORK COMPLETED TODAY:
    Tunnel heading advance.
  ILLEGIBLE / UNCERTAIN:

TOTAL SHEETS: 2
TOTAL PAGES READ: 4
"""

# A day where the only sheet on site was the tunnel crew.
PASS1_TUNNEL_ONLY = """SHEET 1
  JOB NUMBER: C-346
  JOB NAME: Morena Convey: 805 Tunnel
  DATE ON SHEET: 12-6-25
  FOREMAN: Rey Villa
  SHIFT: 6:30 PM to 5:00 AM
  LABOR:
    - Villa, Rey | Foreman | RT: 10 | OT: 2 | DT: 0 | WORKED
  SUMMARY OF WORK COMPLETED TODAY:
    Tunnel heading advance.

TOTAL SHEETS: 1
TOTAL PAGES READ: 2
"""

PARSE_JSON = {
    "activities": [{
        "work_area": "Morena Conveyance - OHL - Blowoff Installation",
        "stations": "",
        "summary": "• Continued blowoff installation.\n• Backfilled and compacted.",
        "needs_location": True,
        "source_sheet": "SHEET 1",
        "manpower": [
            {"trade": "Foreman", "name": "Higuera, Juan", "company": "OHL", "qty": 1,
             "hours": 8, "ot_hours": 0, "start_time": "6:30 AM", "stop_time": "3:00 PM",
             "is_3rd_party": False},
            {"trade": "Laborer", "name": "Salado, Ubaldo", "company": "OHL", "qty": 1,
             "hours": 8, "ot_hours": 2, "start_time": "6:30 AM", "stop_time": "3:00 PM",
             "is_3rd_party": False},
            {"trade": "Laborer", "name": "[illegible]", "company": "OHL", "qty": 1,
             "hours": 8, "ot_hours": 0, "start_time": "6:30 AM", "stop_time": "3:00 PM",
             "is_3rd_party": False},
        ],
        "equipment": [
            {"name": "CAT 330", "description": "Excavator", "company": "OHL", "qty": 1,
             "hours": 8, "start_time": "6:30 AM", "stop_time": "3:00 PM",
             "is_rental": False, "is_3rd_party": False},
            {"name": "Dewatering Pump", "description": "Dewatering Pump",
             "company": "United Rentals", "qty": 1, "hours": 8, "start_time": "",
             "stop_time": "", "is_rental": True, "is_3rd_party": False},
        ],
        "third_party": [
            {"company": "Hudson", "work_performed": "traffic control",
             "crew_size": 1, "hours": 0},
        ],
        "missing_info": ["station range for the blowoff", "percent complete"],
        "uncertain_fields": ["manpower name — fourth labor row unreadable"],
    }],
    "shift_start": "6:30 AM",
    "shift_stop": "3:00 PM",
    "general_notes": "Conveyance crew continued blowoff work.",
    "excluded_sheets": [],
}

CLASSIFY_JSON = {"doc_type": "timesheet", "work_date": "2026-01-14", "confidence": 0.82}

STATE = {"pass1": PASS1_TWO_SHEETS}


def fake_client():
    c = types.SimpleNamespace()

    def generate_content(**kw):
        cfg = kw.get("config")
        schema = getattr(cfg, "response_schema", None)
        name = getattr(schema, "__name__", "")
        if name == "ClassifyResult":
            return FakeResponse(json.dumps(CLASSIFY_JSON))
        if name == "TimesheetParseResult":
            return FakeResponse(json.dumps(PARSE_JSON))
        # Text mode = pass 1 (timesheet read or sub-email read)
        return FakeResponse(STATE["pass1"])

    c.models = types.SimpleNamespace(generate_content=generate_content)
    return c, "fake-model"


ai_router._get_gemini_client = fake_client
backfill_router._get_gemini_client = fake_client


async def fake_fetch_weather(lat, lon, location_label="", date=None):
    return {
        "status": "success",
        "temperature_high": "68", "temperature_low": "51",
        "wind_speed": 7, "wind_direction": "WNW", "wind_info": "7 mph WNW",
        "condition": "Partly Cloudy", "emoji": "⛅", "sky_condition_id": "partly-cloudy",
        "weather_code": 2, "location": location_label, "date": date, "source": "archive",
    }


async def fake_geocode(zip_code):
    return (32.8, -117.2, "San Diego")


weather_router._fetch_weather = fake_fetch_weather
backfill_router._geocode_zip = fake_geocode

from app.main import app  # noqa: E402
from app.services.database import init_database, get_report  # noqa: E402
from app.routers.settings import _load, _save  # noqa: E402

init_database()
client = TestClient(app)

# Make sure the scope rule has the tunnel foreman configured (a fresh settings
# file gets it from DEFAULT_SETTINGS, but be explicit — this is what's under test).
_settings = _load()
_settings["backfill"] = {"tunnel_foremen": ["Rey Villa"], "tunnel_job_keywords": ["805", "tunnel"]}
_settings["default_zip_code"] = "92101"
_settings["default_project"] = "Morena Conveyance Northern"
_save(_settings)


def make_pdf(lines: list[str]) -> bytes:
    """A tiny real PDF so the render path is genuinely exercised."""
    import fitz
    doc = fitz.open()
    page = doc.new_page()
    y = 72
    for line in lines:
        page.insert_text((72, y), line, fontsize=11)
        y += 16
    data = doc.tobytes()
    doc.close()
    return data


# ── 1. Filename date parsing + weekday checksum ─────────────────────────────

d, src, wk = backfill_router._extract_date_from_filename("1.13.26 Tuesday.pdf")
check("filename date parsed", d == "2026-01-13", f"{d} ({src}, weekday={wk})")
check("weekday checksum agrees", wk == "ok", wk)

d, src, wk = backfill_router._extract_date_from_filename("10.29.25 Wednesday.pdf")
check("2025 date parsed", d == "2025-10-29", f"{d} ({src})")

# "1.2.25 Friday.pdf" — Jan 2 2025 was a Thursday; Jan 2 2026 was a Friday.
# The year in the name is a typo and the weekday is what catches it.
d, src, wk = backfill_router._extract_date_from_filename("1.2.25 Friday.pdf")
check("year typo corrected by weekday", d == "2026-01-02", f"{d} ({src})")
check("correction is reported, not silent", src == "filename_corrected" and wk == "corrected",
      f"{src}/{wk}")

d, src, wk = backfill_router._extract_date_from_filename("1.16.25 Friday.pdf")
check("second year typo corrected", d == "2026-01-16", f"{d} ({src})")

d, src, wk = backfill_router._extract_date_from_filename("scan_no_date.pdf")
check("undated filename yields nothing", d == "" and src == "none", f"{d}/{src}")


# ── 2. The scope rule ───────────────────────────────────────────────────────

kept, excluded = backfill_router._apply_scope_rule(PASS1_TWO_SHEETS)
check("tunnel sheet excluded", len(excluded) == 1, f"{len(excluded)} excluded")
check("exclusion names a reason", bool(excluded and excluded[0]["reason"]),
      excluded[0]["reason"] if excluded else "")
check("in-scope sheet kept", "Juan Higuera" in kept)
check("tunnel crew removed from kept text", "Rey Villa" not in kept)

# Foreman alone is enough, even when the job name says nothing about the tunnel.
foreman_only = PASS1_TWO_SHEETS.replace("Morena Convey: 805 Tunnel", "Morena Conveyance")
kept2, excluded2 = backfill_router._apply_scope_rule(foreman_only)
check("foreman alone triggers the rule", len(excluded2) == 1 and "Rey Villa" in excluded2[0]["reason"],
      excluded2[0]["reason"] if excluded2 else "not excluded")

# ...and it is configuration, not a constant: clear the list and he is in scope.
_s = _load()
_s["backfill"] = {"tunnel_foremen": [], "tunnel_job_keywords": ["805", "tunnel"]}
_save(_s)
_, excluded3 = backfill_router._apply_scope_rule(foreman_only)
check("foreman rule is a setting, not hardcoded", len(excluded3) == 0, f"{len(excluded3)} excluded")
_s["backfill"] = {"tunnel_foremen": ["Rey Villa"], "tunnel_job_keywords": ["805", "tunnel"]}
_save(_s)


# ── 3. Upload ───────────────────────────────────────────────────────────────

ts_pdf = make_pdf(["JOB C-346  MORENA", "FOREMAN: JUAN HIGUERA", "RT 8  OT 2"])
tunnel_pdf = make_pdf(["JOB C-346  805 TUNNEL", "FOREMAN: REY VILLA", "RT 10 OT 2"])
undated_pdf = make_pdf(["JOB C-346", "FOREMAN: MARCOS"])

r = client.post("/api/backfill/upload", files=[
    ("files", ("1.13.26 Tuesday.pdf", ts_pdf, "application/pdf")),
    ("files", ("12.6.25 805 Saturday.pdf", tunnel_pdf, "application/pdf")),
    ("files", ("scan_no_date.pdf", undated_pdf, "application/pdf")),
])
check("upload 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:160]}")
up = r.json()
batch_id = up["batch_id"]
by_name = {f["filename"]: f for f in up["files"]}
check("dated file got its date from the filename",
      by_name["1.13.26 Tuesday.pdf"]["work_date"] == "2026-01-13",
      by_name["1.13.26 Tuesday.pdf"]["work_date"])
check("filename date costs no AI call",
      by_name["1.13.26 Tuesday.pdf"]["date_source"] == "filename")
check("undated file falls back to AI classification",
      by_name["scan_no_date.pdf"]["date_source"] == "ai"
      and by_name["scan_no_date.pdf"]["work_date"] == "2026-01-14",
      f"{by_name['scan_no_date.pdf']['date_source']}/{by_name['scan_no_date.pdf']['work_date']}")
check("page count recorded", by_name["1.13.26 Tuesday.pdf"]["page_count"] == 1)

ts_id = by_name["1.13.26 Tuesday.pdf"]["file_id"]
tunnel_id = by_name["12.6.25 805 Saturday.pdf"]["file_id"]


# ── 4. Generate — the in-scope day ──────────────────────────────────────────

STATE["pass1"] = PASS1_TWO_SHEETS
r = client.post("/api/backfill/generate", json={
    "batch_id": batch_id,
    "groups": [{"date": "2026-01-13", "file_ids": [ts_id]}],
    "detail_level": "factual",
})
check("generate 202/200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:160]}")

status = client.get(f"/api/backfill/{batch_id}/status").json()
day = status["dates"][0]
check("date finished", day["state"] == "done", f"{day['state']}: {day['message']}")
check("one activity built", day["activity_count"] == 1, str(day["activity_count"]))

report = get_report(day["report_id"])
check("report saved", report is not None)
check("report carries the work date", report["general"]["report_date"] == "2026-01-13",
      report["general"]["report_date"])
check("weather filled from the archive", report["general"]["temperature_high"] == "68",
      report["general"]["temperature_high"])
check("shift times come from the timesheet", report["general"]["start_time"] == "6:30 AM",
      report["general"]["start_time"])

act = report["activities"][0]
names = [m["name"] for m in act["manpower"]]
check("struck-through worker is NOT in the report", "Ramirez, Hector" not in names, str(names))
check("worked crew is present", "Higuera, Juan" in names and "Salado, Ubaldo" in names, str(names))
check("illegible name kept as [illegible], not guessed", "[illegible]" in names, str(names))
check("OT hours preserved separately",
      any(m.get("ot_hours") == 2 for m in act["manpower"]))
check("rental equipment flagged",
      any(e.get("is_rental") for e in act["equipment"]))
check("every resource row has an id",
      all(row.get("id") for row in act["manpower"] + act["equipment"]))
check("subcontractor folded into the summary", "Hudson" in act["summary"], act["summary"][:80])

flags = report["backfill"]["flags"]
check("illegible field flagged for review",
      any("illegible" in f for f in flags), str(flags[:2]))
check("missing info surfaced", any("missing" in f for f in flags), str(flags[:4]))
check("no-location flagged", any("no location" in f for f in flags))
check("tunnel exclusion recorded on the report",
      len(report["backfill"]["excluded_sheets"]) == 1,
      str(report["backfill"]["excluded_sheets"]))
check("excluded sheet explained in the notes", "805 tunnel" in report["general"]["notes"].lower(),
      report["general"]["notes"][-90:])
check("source file traceable", report["backfill"]["source_files"][0]["file_id"] == ts_id)


# ── 5. A tunnel-only day must produce NO report ─────────────────────────────

STATE["pass1"] = PASS1_TUNNEL_ONLY
r = client.post("/api/backfill/generate", json={
    "batch_id": batch_id,
    "groups": [{"date": "2025-12-06", "file_ids": [tunnel_id]}],
})
check("second generate accepted", r.status_code == 200, f"HTTP {r.status_code} {r.text[:160]}")

status = client.get(f"/api/backfill/{batch_id}/status").json()
tunnel_day = next(d for d in status["dates"] if d["date"] == "2025-12-06")
check("tunnel-only day is skipped", tunnel_day["state"] == "skipped",
      f"{tunnel_day['state']}: {tunnel_day['message']}")
check("tunnel-only day made no report", not tunnel_day["report_id"],
      tunnel_day["report_id"])
check("skip reason is visible, not silent", bool(tunnel_day["excluded_sheets"]),
      str(tunnel_day["excluded_sheets"]))


# ── 6. Source file serving + export ─────────────────────────────────────────

r = client.get(f"/api/backfill/{batch_id}/file/{ts_id}")
check("source file served for side-by-side", r.status_code == 200
      and r.headers["content-type"] == "application/pdf",
      f"HTTP {r.status_code} {r.headers.get('content-type')}")

r = client.get(f"/api/backfill/{batch_id}/file/not-a-real-id")
check("unknown file id is a clean 404", r.status_code == 404, f"HTTP {r.status_code}")

r = client.get(f"/api/backfill/{batch_id}/export.zip")
check("export.zip 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")
if r.status_code == 200:
    archive = zipfile.ZipFile(io.BytesIO(r.content))
    check("zip holds one docx (skipped date excluded)", len(archive.namelist()) == 1,
          str(archive.namelist()))
    check("docx is named by date", "2026-01-13" in archive.namelist()[0],
          archive.namelist()[0])
    check("docx is not empty", archive.infolist()[0].file_size > 5000,
          str(archive.infolist()[0].file_size))


# ── 7. Guard rails ──────────────────────────────────────────────────────────

r = client.get("/api/backfill/00000000-0000-0000-0000-000000000000/status")
check("unknown batch is a clean 404", r.status_code == 404, f"HTTP {r.status_code}")

r = client.get("/api/backfill/../../etc/status")
check("path traversal rejected", r.status_code in (400, 404), f"HTTP {r.status_code}")

r = client.post("/api/backfill/generate", json={"batch_id": batch_id, "groups": []})
check("generate with no groups is a 400", r.status_code == 400, f"HTTP {r.status_code}")

r = client.get("/api/backfill")
check("batch list includes this batch",
      any(b["batch_id"] == batch_id for b in r.json()["batches"]))


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
