"""Verify the Word export survives the messy data real reports actually contain.

WHY THIS EXISTS: every Word export 500'd for any report containing a single
resource row with a blank hours field. The call sites used
`float(item.get("hours", 0))`, and a dict default only applies when the key is
ABSENT — rows carry `"hours": null`, so .get returned None and float(None)
raised TypeError. One empty box in one row killed the whole document.

These fixtures are modelled on a real failing report pulled from production
(4 activities, 7 rows with null hours, plus null start/stop times and company).
"""
import io
import sys

sys.path.insert(0, "backend")

from app.services.word import generate_word_document, _num  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def row(**kw):
    base = {
        "trade": "LL-03- Laborers", "name": "", "qty": 1, "hours": 8,
        "company": "OHL NA", "start_time": "7:00 AM", "stop_time": "3:30 PM",
    }
    base.update(kw)
    return base


def report_with(*manpower, equipment=None):
    return {
        "general": {
            "project_name": "Morena Conveyance Northern",
            "project_number": "C-346",
            "report_date": "2026-07-27",
            "resident_engineer": "T. West",
        },
        "activities": [{
            "work_area": "Executive - OHLA - Grout interior pipe joints 48\"",
            "summary": "• Grouted interior pipe joints.",
            "manpower": list(manpower),
            "equipment": equipment or [],
            "extra_work_manpower": [], "extra_work_equipment": [],
            "consultant_manpower": [],
        }],
        "status": "submitted",
    }


def exports(report):
    """Return (ok, size_or_error)."""
    try:
        stream = generate_word_document(report)
        data = stream.getvalue()
        if not isinstance(stream, io.BytesIO) or data[:2] != b"PK":
            return False, "not a valid docx"
        return True, len(data)
    except Exception as exc:  # noqa: BLE001 — the point is to catch everything
        return False, f"{type(exc).__name__}: {exc}"


# ── _num coercion ───────────────────────────────────────────────────────────

check("_num(None) -> 0", _num(None) == 0.0)
check("_num('') -> 0", _num("") == 0.0)
check("_num('   ') -> 0", _num("   ") == 0.0)
check("_num('8') -> 8", _num("8") == 8.0)
check("_num('8.5') -> 8.5", _num("8.5") == 8.5)
check("_num(8) -> 8", _num(8) == 8.0)
check("_num('abc') -> 0 (no crash)", _num("abc") == 0.0)
check("_num(True) -> 0 (bool is not a quantity)", _num(True) == 0.0)


# ── The exact crash ─────────────────────────────────────────────────────────

ok, info = exports(report_with(row(hours=None)))
check("null hours exports instead of 500", ok, str(info))

ok, info = exports(report_with(row(qty=None)))
check("null qty exports", ok, str(info))

ok, info = exports(report_with(row(hours=None, qty=None, company=None,
                                   start_time=None, stop_time=None)))
check("every numeric/text field null exports", ok, str(info))

ok, info = exports(report_with(row(hours="8"), row(hours="7.5"), row(hours="")))
check("string hours export", ok, str(info))

ok, info = exports(report_with(
    row(hours=8), row(hours=None), row(hours=10, qty=3),
    equipment=[{"name": "CAT 330", "description": "Excavator", "qty": 1,
                "hours": None, "company": None, "is_rental": None}],
))
check("mixed good and null rows export", ok, str(info))


# ── A null row must not silently become phantom labor ───────────────────────
# Rows with no hours are skipped by the consolidator (qty <= 0 or hours <= 0),
# which is correct — a blank row is not eight hours of work.

good, _ = exports(report_with(row(hours=8)))
both, _ = exports(report_with(row(hours=8), row(hours=None)))
check("a null-hours row does not break a report that also has real rows",
      good and both)


# ── Still works with nothing at all ─────────────────────────────────────────

ok, info = exports(report_with())
check("activity with no resources exports", ok, str(info))

ok, info = exports({"general": {}, "activities": [], "status": "draft"})
check("completely empty report exports", ok, str(info))


# ── Filename convention ─────────────────────────────────────────────────────
# Named from the report's own project name, so renaming the project renames
# the files:  <project name> - Daily-TW-MM-DD-YYYY.docx

from app.services.word import build_report_filename  # noqa: E402

rep = report_with(row())   # project_name = "Morena Conveyance Northern"
name = build_report_filename(rep)
check("filename uses the report's own project name",
      name == "Morena Conveyance Northern - Daily-TW-07-27-2026.docx", name)

check("date is zero-padded MM-DD-YYYY", "-07-27-2026." in name, name)

# Renaming the project renames the files — one place to change it.
renamed = dict(rep, general=dict(rep["general"], project_name="Genesee Widening"))
check("renaming the project renames the file",
      build_report_filename(renamed) == "Genesee Widening - Daily-TW-07-27-2026.docx",
      build_report_filename(renamed))

# The settings prefix only applies when the report has no project name.
no_project = dict(rep, general=dict(rep["general"], project_name=""))
check("settings prefix is used when the report has no project",
      build_report_filename(no_project, "Fallback Project")
      == "Fallback Project - Daily-TW-07-27-2026.docx",
      build_report_filename(no_project, "Fallback Project"))

check("project name beats the settings prefix",
      build_report_filename(rep, "Should Not Win").startswith("Morena Conveyance Northern"),
      build_report_filename(rep, "Should Not Win"))

check("no project and no prefix falls back to the default",
      build_report_filename(no_project, "").startswith("Morena Conveyance North"),
      build_report_filename(no_project, ""))

undated = build_report_filename({"general": {}})
check("a report with no date still yields a usable name",
      undated.endswith(".docx") and "unknown-date" in undated, undated)

unsafe = build_report_filename(rep, 'Bad/Name:With*Chars?')
check("characters illegal in filenames are stripped",
      not any(c in unsafe for c in '<>:"/\\|?*'), unsafe)


# ── What the "Copy Report" button pastes ────────────────────────────────────
# Same content as the Word doc minus the consolidated resource table.

from app.services.word import generate_notes_html  # noqa: E402

html = generate_notes_html(report_with(
    row(trade="LL-02- Foreman", hours=8),
    equipment=[{"name": "CAT 330", "description": "Excavator", "qty": 1, "hours": 8}],
))
check("copy content is produced", bool(html) and len(html) > 100, f"{len(html)} chars")
check("copy content has NO table", "<table" not in html.lower())
check("copy content excludes the consolidated section",
      "consolidated" not in html.lower())
check("copy content keeps the report body",
      "DAILY FIELD REPORT" in html and "Grout interior pipe joints" in html)
_has_bullet = "•" in html or "&#8226;" in html
check("bullets survive as real UTF-8", _has_bullet,
      "found" if _has_bullet else "NO BULLET IN OUTPUT")


# ── Morena Pipelines multi-activity export (Interview + Dictate) ────────────
from app.services.word import build_report_preview, generate_report_document  # noqa: E402

morena_pipelines_multi = {
    "general": {
        "project_name": "Morena Pipelines",
        "profile_key": "morena_pipelines",
        "report_date": "2026-10-19",
    },
    "interview": {
        "profile": "morena_pipelines",
        "composed": [
            {
                "id": "work_summary",
                "number": 1,
                "title": "Work Summary & Pipe Installation",
                "body": (
                    "Starting stations: Excavation: Sta 124+55\n"
                    "Potholing: Potholed at four locations on Morena Blvd."
                ),
            },
            {
                "id": "tm_tracking",
                "number": 2,
                "title": "Time & Material (T&M) Tracking",
                "body": "No time and material work was performed this shift.",
            },
        ],
    },
    "activities": [
        {
            "work_area": "Daily Progress",
            "stations": "Sta 124+55 to Sta 133+48",
            "summary": (
                "1. Work Summary & Pipe Installation\n"
                "Starting stations: Excavation: Sta 124+55\n"
                "Potholing: Potholed at four locations on Morena Blvd.\n\n"
                "2. Time & Material (T&M) Tracking\n"
                "No time and material work was performed this shift."
            ),
            "manpower": [{"trade": "LL-03- Laborers", "qty": 7}],
            "equipment": [{"name": "LE-109- Skid Steer", "qty": 1}],
            "interview_pass": 1,
        },
        {
            "work_area": "Morena Blvd - Carpentry & Vault Formwork",
            "stations": "Sta 118+00",
            "summary": (
                "• Start Time: 7:00 PM\n"
                "• End Time: 5:00 AM\n"
                "• Constructed formwork at the vault location."
            ),
            "manpower": [{"trade": "LL-03- Laborers", "qty": 2}, {"trade": "Carpenter", "qty": 1}],
            "equipment": [{"name": "Light Tower", "qty": 1}],
        },
    ],
}

mp_preview = build_report_preview(morena_pipelines_multi)
act_headers = [s["title"] for s in mp_preview["sections"] if s.get("is_activity_header")]
check("Morena Pipelines renders a title header at the top of each activity",
      act_headers == [
          "Potholing — Sta 124+55 to Sta 133+48",
          "Morena Blvd - Carpentry & Vault Formwork — Sta 118+00",
      ],
      str(act_headers))
check("Morena Pipelines renders 8 sections per activity (2 headers + 16 sections = 18 blocks)",
      len(mp_preview["sections"]) == 18, str(len(mp_preview["sections"])))
act1_sec1 = mp_preview["sections"][1]["lines"]
act1_sec7 = mp_preview["sections"][7]["lines"]
act2_sec1 = mp_preview["sections"][10]["lines"]
act2_sec7 = mp_preview["sections"][16]["lines"]
check("Activity 1 Section 1 holds only Activity 1 narrative",
      any("Potholed at four locations" in line for line in act1_sec1)
      and not any("Constructed formwork" in line for line in act1_sec1),
      str(act1_sec1))
check("Activity 1 Section 7 holds only Activity 1 crew (7 Laborers)",
      any("Laborers: 7" in line for line in act1_sec7), str(act1_sec7))
check("Activity 2 Section 1 holds only Activity 2 narrative",
      any("Constructed formwork at the vault" in line for line in act2_sec1)
      and not any("Potholed at four locations" in line for line in act2_sec1),
      str(act2_sec1))
check("Activity 2 Section 7 holds only Activity 2 crew (2 Laborers, 1 Carpenter)",
      any("Laborers: 2" in line for line in act2_sec7)
      and any("Carpenter: 1" in line for line in act2_sec7),
      str(act2_sec7))
mp_stream = generate_report_document(morena_pipelines_multi)
check("Morena Pipelines multi-activity docx generates cleanly",
      mp_stream.getvalue()[:2] == b"PK", f"{len(mp_stream.getvalue())} bytes")

morena_with_notes = dict(
    morena_pipelines_multi,
    general=dict(
        morena_pipelines_multi["general"],
        notes="Cloudy evening turned to rain around 10:00 PM\nOHLA worked at Morena Boulevard.",
    ),
)
mp_notes_preview = build_report_preview(morena_with_notes)
check("Morena Pipelines includes General Notes section at top when general.notes is present",
      mp_notes_preview["sections"][0]["title"] == "General Notes"
      and any("OHLA worked at Morena Boulevard." in line for line in mp_notes_preview["sections"][0]["lines"]),
      str(mp_notes_preview["sections"][0]))


# ---------------------------------------------------------------------------
# 10. Guided Interview compose_report: Morena Conveyance North & Morena Pipelines
# ---------------------------------------------------------------------------
import asyncio
import json
from unittest.mock import patch
from app.routers.interview import ComposeRequest, compose_report


class _FakeGeminiResp:
    def __init__(self, payload: dict):
        self.text = json.dumps(payload)
        self.candidates = []


with patch("app.routers.interview._get_gemini_client", return_value=(object(), "fake-model")), \
     patch("app.routers.interview._gemini_call_with_retry") as mock_gemini:

    mock_gemini.return_value = _FakeGeminiResp({
        "sections": [
            {
                "id": "location:1",
                "body": (
                    "• Northbound lane 2 on Morena Blvd was closed with cones and arrow boards.\n"
                    "• The crew excavated the trench from Sta 10+00 to Sta 10+50 using an excavator.\n"
                    "• Traffic control was picked up at 3:00 PM."
                ),
            },
            {
                "id": "location:2",
                "body": (
                    "• Performed tie-in preparation at Genesee Ave.\n"
                    "• Steel plates were placed over the excavation at the end of the shift."
                ),
            },
            {
                "id": "general_notes",
                "body": "City water inspector visited the site at 10:00 AM.",
            },
        ]
    })

    morena_req = ComposeRequest(
        profile="morena",
        report_date="2026-10-28",
        answers={
            "locations": "Morena Blvd & Buenos Ave\nGenesee Ave Tie-In",
            "start_time": "7:00 AM",
            "stop_time": "3:30 PM",
            "stations": "Sta 10+00 to Sta 10+50",
            "traffic_control": "yes",
            "traffic_control_detail": "northbound lane 2 closed on morena blvd",
            "summary": "dug trench 10+00 to 10+50",
            "traffic_control_removed": "picked up at 3pm",
            "start_time#2": "8:00 AM",
            "stop_time#2": "2:30 PM",
            "summary#2": "prepped tie in and plated trench",
            "visitors": "city water inspector here at 10am",
        },
    )
    morena_composed = asyncio.run(compose_report(morena_req, _user={"id": "u1"}))
    by_sec_id = {s.id: s for s in morena_composed.sections}

    check("Morena Conveyance North compose returns location:1, location:2, and general_notes",
          set(by_sec_id.keys()) == {"location:1", "location:2", "general_notes"},
          str(list(by_sec_id.keys())))
    check("Morena Conveyance North location:1 opens with Start Time and End Time lines",
          by_sec_id["location:1"].body.startswith("Start Time: 7:00 AM\nEnd Time: 3:30 PM\n"),
          repr(by_sec_id["location:1"].body))
    check("Morena Conveyance North location:2 opens with Start Time and End Time lines",
          by_sec_id["location:2"].body.startswith("Start Time: 8:00 AM\nEnd Time: 2:30 PM\n"),
          repr(by_sec_id["location:2"].body))
    check("Morena Conveyance North general_notes holds composed day_close prose",
          "City water inspector visited" in by_sec_id["general_notes"].body,
          repr(by_sec_id["general_notes"].body))

    mock_gemini.return_value = _FakeGeminiResp({
        "sections": [
            {
                "id": "work_summary",
                "body": "Trench Excavation: Advanced excavation from Sta 143+98 to Sta 142+40.",
            },
            {
                "id": "extra_activity:1",
                "body": "Vault Formwork: Constructed formwork at the vault at Sta 118+00.",
            },
        ]
    })

    mp_req = ComposeRequest(
        profile="morena_pipelines",
        report_date="2026-10-28",
        answers={
            "shift_start": "7:00 AM",
            "shift_end": "3:30 PM",
            "starting_stations": "Excavation: Sta 143+98",
            "ending_stations": "Excavation: Sta 142+40",
            "more_activities": "yes",
            "extra_activity_area": "Morena Blvd — Vault Formwork",
            "extra_activity_start": "7:30 AM",
            "extra_activity_stop": "4:00 PM",
            "extra_activity_summary": "built formwork at vault sta 118+00",
        },
    )
    mp_composed = asyncio.run(compose_report(mp_req, _user={"id": "u1"}))
    mp_by_id = {s.id: s for s in mp_composed.sections}

    check("Morena Pipelines compose includes Start/End Time on work_summary",
          mp_by_id["work_summary"].body.startswith("Start Time: 7:00 AM\nEnd Time: 3:30 PM\n"),
          repr(mp_by_id["work_summary"].body))
    check("Morena Pipelines compose includes extra_activity:1 with Start/End Time",
          "extra_activity:1" in mp_by_id
          and mp_by_id["extra_activity:1"].body.startswith("Start Time: 7:30 AM\nEnd Time: 4:00 PM\n"),
          repr(mp_by_id.get("extra_activity:1")))


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
