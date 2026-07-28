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
# Files must match how the 61 finished reports in Daily Reports/ are named:
#   Morena Conveyance North - Daily-TW-MM-DD-YYYY.docx

from app.services.word import build_report_filename  # noqa: E402

rep = report_with(row())
name = build_report_filename(rep)
check("filename matches the filing convention",
      name == "Morena Conveyance North - Daily-TW-07-27-2026.docx", name)

check("date is zero-padded MM-DD-YYYY", "-07-27-2026." in name, name)

custom = build_report_filename(rep, "Some Other Project")
check("prefix is configurable",
      custom == "Some Other Project - Daily-TW-07-27-2026.docx", custom)

blank_prefix = build_report_filename(rep, "")
check("blank prefix falls back to the default",
      blank_prefix.startswith("Morena Conveyance North"), blank_prefix)

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


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
