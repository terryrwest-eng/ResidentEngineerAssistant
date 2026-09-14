"""
Verify the composer: a finished day record becomes a report, or nothing.

WHY THIS EXISTS: the day record was built and left with nothing to write to.
day_record.py says "the composer reads it — all of it — and writes. Nothing
else is allowed to write report prose", and settled() was built to feed a
composer that did not exist, so a completed conversation produced no report.

The checks below are the two properties that matter:

  1. Numbers are placed by code, never by the model. The model writes prose and
     only prose. Every station, time, quantity and name comes out of a settled
     slot, because a model that can write a station number can write the wrong
     one and nothing downstream would catch it.

  2. A hole refuses. Composing around a missing or unclear value would produce
     a confident sentence covering an unknown, which is worse than no report.

Gemini is mocked, so this runs offline.
Run from the repo root:  python3 backend/tests/test_composer.py
"""
import sys

sys.path.insert(0, "backend")

from app.services.day_record import DayRecord  # noqa: E402
from app.services import composer as comp  # noqa: E402
from app.services.composer import NotReady, compose, _shift_hours  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# What the composer's single model call returns. Set per-test.
PROSE = {}


def fake_call_json(client, model_name, prompt, where):
    fake_call_json.last_prompt = prompt
    return PROSE


import app.routers.conversation as convo  # noqa: E402
convo._call_json = fake_call_json
FAKE = (object(), "fake-model")


def build_record(*, crew=None, equip=None) -> DayRecord:
    """A record with everything the Morena profile requires, and nothing more."""
    rec = DayRecord("morena", "2026-08-05")
    rec.apply("day::locations", state="ok", value="Nobel Dr\nGenesee Ave",
              rows=[{"item": "Nobel Dr"}, {"item": "Genesee Ave"}],
              heard="we were on nobel and genesee")
    rec.set_instances("activity", ["Nobel Dr", "Genesee Ave"])

    for label in ("Nobel Dr", "Genesee Ave"):
        rec.apply(f"activity::{label}::start_time", state="ok", value="11:30 PM")
        rec.apply(f"activity::{label}::stop_time", state="ok", value="3:45 AM")
        rec.apply(f"activity::{label}::lunch_deducted", state="ok", value="yes")
        rec.apply(f"activity::{label}::summary", state="ok",
                  value=f"striping and layout at {label}")
        rec.apply(f"activity::{label}::crew", state="ok", rows=crew if crew is not None else [
            {"trade": "LL-02- Foreman", "name": "Stephen Strandberg",
             "qty": 1, "hours": 4.25, "company": "Payco"},
            {"trade": "LL-03- Laborers", "name": "Dan Griffin",
             "qty": 1, "hours": 4.25, "company": "Payco"},
            {"trade": "LL-03- Laborers", "name": "Juan Medina",
             "qty": 1, "hours": 4.25, "company": "Payco"},
        ])
        rec.apply(f"activity::{label}::equipment", state="ok", rows=equip if equip is not None else [
            {"name": "LE-161- Traffic Control Truck", "qty": 1, "hours": 4.25, "company": "Payco"},
            {"name": "LE-161- Traffic Control Truck", "qty": 1, "hours": 4.25, "company": "Payco"},
            {"name": "LE-170- Airless Paint Striper", "qty": 1, "hours": 4.25, "company": "Payco"},
        ])
    rec.apply("activity::Nobel Dr::stations", state="ok", value="Sta 143+98.80 to Sta 147+12")
    return rec


# ─────────────────────────────────────────────────────────
print("\n--- refusing to write ---")

rec = DayRecord("morena", "2026-08-05")
try:
    compose(rec, *FAKE)
    check("an empty record refuses to compose", False, "it composed")
except NotReady as exc:
    check("an empty record refuses to compose", True)
    check("and it says what is blocking", len(exc.blocking) > 0,
          f"{len(exc.blocking)} blocking")

rec = build_record()
rec.apply("activity::Nobel Dr::start_time", state="suspect", value="11:30 PM",
          heard="half eleven or half twelve", reason="could not tell 11:30 from 12:30")
try:
    compose(rec, *FAKE)
    check("one unclear value stops the whole report", False, "it composed")
except NotReady:
    check("one unclear value stops the whole report", True)

rec = build_record()
rec.conflicts.append({"key": "activity::Nobel Dr::stop_time", "known": "3:45 AM",
                      "heard": "4:45", "note": "two different stop times"})
try:
    compose(rec, *FAKE)
    check("an unsettled contradiction stops it too", False, "it composed")
except NotReady:
    check("an unsettled contradiction stops it too", True)


# ─────────────────────────────────────────────────────────
print("\n--- writing ---")

PROSE = {
    "locations": [
        {"location": "Nobel Dr", "narrative": "Payco laid out bike lanes and turn arrows on Nobel Dr."},
        {"location": "Genesee Ave", "narrative": "The same crew moved to Genesee Ave and continued striping."},
    ],
    "day_notes": "SDG&E stood by for the duration.",
}

rec = build_record()
check("a complete record composes", rec.can_compose())
report = compose(rec, *FAKE)

check("it produces one activity per location",
      len(report["activities"]) == 2, f"{len(report['activities'])} activities")
check("locations keep the order they were worked",
      [a["work_area"] for a in report["activities"]] == ["Nobel Dr", "Genesee Ave"],
      str([a["work_area"] for a in report["activities"]]))

nobel = report["activities"][0]
genesee = report["activities"][1]

check("the model's paragraph lands in the summary",
      "bike lanes" in nobel["summary"], nobel["summary"][:60])
check("it saw the whole day, not one activity at a time",
      "same crew" in genesee["summary"], genesee["summary"][:60])
check("day-level prose is kept", "SDG&E" in report["general"]["notes"])

# --- the property that matters most --------------------------------------
check("the station comes from the record, not the model",
      nobel["stations"] == "Sta 143+98.80 to Sta 147+12", nobel["stations"])
check("a location with no station gets none rather than an invented one",
      genesee["stations"] == "", repr(genesee["stations"]))
check("times come from the record",
      report["general"]["start_time"] == "11:30 PM"
      and report["general"]["end_time"] == "3:45 AM",
      f"{report['general']['start_time']} - {report['general']['end_time']}")
check("the report date is the record's", report["general"]["report_date"] == "2026-08-05")
check("the project comes from the profile, not the conversation",
      report["general"]["project_name"], report["general"]["project_name"])

# --- rows are people and machines, not totals -----------------------------
check("one crew row per person", len(nobel["manpower"]) == 3,
      f"{len(nobel['manpower'])} rows")
check("names survive into the report",
      [r["name"] for r in nobel["manpower"]] == ["Stephen Strandberg", "Dan Griffin", "Juan Medina"],
      str([r["name"] for r in nobel["manpower"]]))
check("the trade is kept separately, for the PMWeb code",
      nobel["manpower"][1]["trade"] == "LL-03- Laborers")
check("two identical trucks stay two rows",
      sum(1 for r in nobel["equipment"] if "Traffic Control" in r["name"]) == 2,
      f"{len(nobel['equipment'])} equipment rows")
check("no row is summed into a quantity it was not given",
      all(r["qty"] == 1 for r in nobel["manpower"] + nobel["equipment"]))
check("equipment keeps the name as spoken",
      any(r["name"] == "LE-170- Airless Paint Striper" for r in nobel["equipment"]))

# --- the model is not asked to place numbers ------------------------------
prompt = fake_call_json.last_prompt
check("the prose prompt forbids inventing facts",
      "If it is not here, it does not go in" in prompt)
check("and tells it not to re-list the roster",
      "roster" in prompt)


# ─────────────────────────────────────────────────────────
print("\n--- falling back ---")

PROSE = {"locations": [], "day_notes": ""}
rec = build_record()
report = compose(rec, *FAKE)
check("a location the model skipped keeps the inspector's own words",
      report["activities"][0]["summary"] == "striping and layout at Nobel Dr",
      report["activities"][0]["summary"])


# ─────────────────────────────────────────────────────────
print("\n--- hours ---")

check("a night shift across midnight is not negative",
      _shift_hours("11:30 PM", "3:45 AM", False) == 4.25,
      str(_shift_hours("11:30 PM", "3:45 AM", False)))
check("lunch comes off when it was taken",
      _shift_hours("7:00 AM", "3:30 PM", True) == 8.0,
      str(_shift_hours("7:00 AM", "3:30 PM", True)))
check("an unreadable time falls back to 8 rather than 0",
      _shift_hours("", "", False) == 8.0)

# A crew row that carried its own hours keeps them.
rec = build_record(crew=[{"trade": "LL-03- Laborers", "name": "Dan Griffin",
                          "qty": 1, "hours": 2.5, "company": "Payco"}])
PROSE = {"locations": [], "day_notes": ""}
report = compose(rec, *FAKE)
check("a row that carried its own hours keeps them",
      report["activities"][0]["manpower"][0]["hours"] == 2.5,
      str(report["activities"][0]["manpower"][0]["hours"]))

# And one that did not gets the shift length, lunch already off: 11:30 PM to
# 3:45 AM is 4.25, and this record answered yes to the half hour.
rec = build_record(crew=[{"trade": "LL-03- Laborers", "name": "Juan Medina",
                          "qty": 1, "company": "Payco"}])
report = compose(rec, *FAKE)
check("a row with no hours gets the shift length, less lunch",
      report["activities"][0]["manpower"][0]["hours"] == 3.75,
      str(report["activities"][0]["manpower"][0]["hours"]))


# ─────────────────────────────────────────────────────────
print("\n--- the endpoint ---")

from fastapi.testclient import TestClient  # noqa: E402
convo._get_gemini_client = lambda *a, **k: FAKE
from app.main import app  # noqa: E402
from app.core.auth import require_user  # noqa: E402
app.dependency_overrides[require_user] = lambda: {"id": "u1", "email": "t@t"}
http = TestClient(app)

PROSE = {"locations": [{"location": "Nobel Dr", "narrative": "Striping on Nobel Dr."},
                       {"location": "Genesee Ave", "narrative": "Striping on Genesee."}],
         "day_notes": ""}

r = http.post("/api/conversation/compose",
              json={"profile": "morena", "report_date": "2026-08-05",
                    "record": build_record().to_dict()})
check("a finished record composes over HTTP", r.status_code == 200, str(r.status_code))
if r.status_code == 200:
    body = r.json()["report"]
    check("the response carries a saveable report",
          len(body["activities"]) == 2 and body["general"]["report_date"] == "2026-08-05")

r = http.post("/api/conversation/compose",
              json={"profile": "morena", "report_date": "2026-08-05",
                    "record": DayRecord("morena", "2026-08-05").to_dict()})
check("an unfinished record is refused, not written around",
      r.status_code == 409, str(r.status_code))
if r.status_code == 409:
    detail = r.json()["detail"]
    check("and the refusal says what to go and ask",
          detail["error"] == "record_not_ready" and len(detail["blocking"]) > 0,
          f"{len(detail.get('blocking', []))} blocking")


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
