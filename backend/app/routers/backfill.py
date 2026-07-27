"""
Daily Reporter V3 — Backfill Router (makeup reports from scanned timesheets)

Reconstructs daily field reports for days that were never written, from scanned
handwritten contractor timesheets (and subcontractor emails saved as PDFs).

Endpoints:
  POST /api/backfill/upload                  → store files, classify type + work date
  POST /api/backfill/generate                → build one draft report per date (background)
  GET  /api/backfill/{batch_id}/status       → per-date progress (frontend polls this)
  GET  /api/backfill/{batch_id}/file/{fid}   → serve a stored source file (side-by-side review)
  GET  /api/backfill/{batch_id}/export.zip   → every report in the batch as .docx
  GET  /api/backfill                         → list batches (resume after a reload)

THE SCOPE RULE (the thing that makes this correct):
    All timesheets for a date, MINUS the 805 tunnel crew, = one of Terry's reports.
A sheet is tunnel work if the job name mentions 805/tunnel, OR the foreman is one
of the configured tunnel foremen (Rey Villa ran that crew through the makeup
window). That foreman association has since ended, so it lives in settings rather
than in this file. Excluded sheets are never dropped silently — every one is
listed in status.json with the reason, so the review UI can show it.

WHY TWO PASSES: Landmine #6 — JSON forcing plus image input makes the model
invent plausible content. Pass 1 reads the pages as text with no schema to
satisfy; pass 2 structures that verified text with no images in the request.

HANDWRITING RULE: anything not clearly legible becomes the literal string
"[illegible]" and is recorded in uncertain_fields. Never a guessed name or number
— a wrong name in a payroll-adjacent document is worse than a visible gap.
"""

import asyncio
import io
import json
import logging
import os
import re
import shutil
import uuid
import zipfile
from datetime import date as date_type, datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.core.paths import BACKFILL_DIR
from app.routers.ai import (
    _clean_json,
    _finish_reason_problem,
    _gemini_call_with_retry,
    _get_gemini_client,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/backfill", tags=["backfill"])


# ============================================
# Rendering budget
# ============================================
# 300 DPI is what makes the handwritten hour columns readable. A day can carry
# up to 17 pages though, and the inline-parts request has a hard size ceiling —
# so we step the DPI down until the batch fits rather than silently truncating
# pages. Whatever we settle on is logged and recorded in status.json.
RENDER_DPI_LADDER = [300, 250, 200, 150]
INLINE_IMAGE_BUDGET_BYTES = 14 * 1024 * 1024
JPEG_QUALITY = 80

# Classification of a file needs one page at low resolution — it is only looking
# for "is this a timesheet, and what date is on it".
CLASSIFY_DPI = 150

WEEKDAY_NAMES = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}

# M.D.YY — the contractor's own filename convention ("1.13.26 Tuesday.pdf")
_DOTTED_DATE = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{2,4})")
# MM-DD-YYYY — how the finished reports are named
_DASHED_DATE = re.compile(r"(\d{1,2})-(\d{1,2})-(\d{4})")
# YYYY-MM-DD — ISO, if anything upstream ever produces it
_ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


# ============================================
# Pass 1 — faithful read (no schema to satisfy)
# ============================================

TIMESHEET_READ_PROMPT = """You are reading scanned contractor daily timesheets for a single work day.
These are photographs/scans of paper forms. Most of the numbers and the work
description are HANDWRITTEN. There is no text layer — read the images.

WHAT YOU ARE LOOKING AT
Each foreman fills out his own sheet, usually 2 pages:
  PAGE 1 — a PRINTED employee roster with HANDWRITTEN hours beside each name.
           Columns for RT (regular time), OT (overtime), DT (double time).
           Also: job number, job name, date, foreman name, shift start/stop times,
           company-owned equipment, and a short work note.
  PAGE 2 — rented equipment, materials, subcontractors, safety items, and a
           handwritten box titled "SUMMARY OF WORK COMPLETED TODAY".

The number of sheets per day VARIES — anywhere from one crew to eight. Do not
assume a count and do not assume a layout. Discover the crews from the pages you
are given. A new sheet starts wherever a new job/foreman/date header appears.

ABSOLUTE RULES
1. STRUCK-THROUGH ROWS MEAN THAT PERSON DID NOT WORK. If a name is crossed out,
   lined through, or has its hours struck, report it as NOT WORKED. Never carry a
   struck row into the worked hours. This is the single most damaging mistake you
   can make here — it invents labor that was never on site.
2. If a name, number, or word is not CLEARLY legible, write the literal string
   [illegible] in its place. NEVER guess a name or a number. A gap is correct; a
   guess is not.
3. Handwritten names are often ADDED BELOW the printed roster. Include them.
4. Read the hours columns separately: RT, OT and DT are different columns. Report
   each one. Do not add them together.
5. Copy job numbers, job names and foreman names EXACTLY as written, including
   misspellings ("MORGNA", "Morena ps & conv."). Do not normalize them.
6. Report the date written on each sheet as written, even if it looks wrong.
7. Do not summarize the work description. Transcribe it word for word.

OUTPUT FORMAT — plain text, no JSON, no commentary:

SHEET 1
  JOB NUMBER: <as written>
  JOB NAME: <as written>
  DATE ON SHEET: <as written>
  FOREMAN: <as written>
  SHIFT: <start> to <stop>
  LABOR:
    - <name> | trade/classification if shown | RT: <n> | OT: <n> | DT: <n> | WORKED
    - <name> | ... | STRUCK THROUGH — DID NOT WORK
  COMPANY EQUIPMENT:
    - <unit / description> | hours if shown
  RENTED EQUIPMENT:
    - <unit / description> | vendor if shown
  SUBCONTRACTORS / 3RD PARTY:
    - <company> | what they did | crew count / hours if shown
  MATERIALS:
    - <as written>
  SUMMARY OF WORK COMPLETED TODAY:
    <verbatim transcription, or the word BLANK if the box is empty>
  ILLEGIBLE / UNCERTAIN:
    - <describe each thing you could not read and where it was>

SHEET 2
  ...

At the end, output:
TOTAL SHEETS: <n>
TOTAL PAGES READ: <n>
"""


# ============================================
# Pass 2 — structure the verified text (no images)
# ============================================

TIMESHEET_JSON_PROMPT = """You are converting an already-verified transcription of contractor timesheets
into structured JSON. There are no images in this request — work ONLY from the
text below. Do not add anything that is not in it.

THE WORK DATE IS {work_date}. Use it. Dates written on the sheets themselves are
frequently wrong (a sheet filed under 1-13-26 may read "1-13-25"); the filing
date is authoritative and has already been resolved. Do not "correct" it.

ONE CREW SHEET = ONE ACTIVITY, unless a single sheet clearly describes work in
two separate locations, in which case split it.

{scope_note}

FOR EACH ACTIVITY:
- work_area: "Location(s) - Company - Basic Description", e.g.
  "Sta 395+87 - OHL - Blowoff Installation". Use the location as written on the
  sheet. If the sheet gives no location, use the job name and set
  needs_location true.
- summary: past-tense factual bullets, one per line, each starting with "• ".
  {detail_note}
- manpower: one row per worker who ACTUALLY WORKED. Never include a row the
  transcription marked struck-through / did not work.
    - trade: the craft (Laborer, Operator, Foreman, Carpenter, Teamster, ...)
    - name: exactly as transcribed; keep [illegible] if that is what it says
    - qty: 1 per named person
    - hours: RT hours for that person
    - ot_hours: OT hours; count DT hours as OT as well and note the DT split in
      the summary if it appears
    - start_time / stop_time: the sheet's shift times, 12-hour with AM/PM
    - company: the contractor named on the sheet
    - is_3rd_party: true only for subcontractor crews
- equipment: company equipment and rented equipment.
    - is_rental true for anything under rented equipment or from a rental vendor
    - company: the owner/vendor as written
- third_party: subcontractors and vendors named on the sheet, with what they did.
- missing_info: short plain-language list of what a reader of the finished report
  would expect but the timesheet does not contain — station ranges, quantities,
  percent complete, what is scheduled next. One entry per gap.
- uncertain_fields: every field where the transcription said [illegible] or the
  reading was doubtful, as "field — what was unreadable".
- source_sheet: which SHEET number in the transcription this activity came from.

DAY-LEVEL OUTPUT:
- shift_start / shift_stop: earliest start and latest stop across included crews,
  12-hour with AM/PM.
- general_notes: one or two sentences describing the day at a high level. No
  station numbers, no crew counts — those belong in the activities.
- excluded_sheets: any sheet you did NOT turn into an activity, with the reason.

HARD RULES:
- Do not invent a name, a number, an hour, a station, or a quantity.
- Keep [illegible] verbatim wherever it appears — do not substitute a plausible value.
- Times are 12-hour with AM/PM. Never 24-hour.
- Bullets use the "• " character. Plain text — no HTML tags.
- Everything past tense.

{continuity_block}

TRANSCRIPTION TO STRUCTURE:
---
{pass1_text}
---
"""

DETAIL_NOTE_FACTUAL = (
    "Report ONLY what the timesheet states. Do not add station ranges, "
    "quantities, or percent-complete that are not written on the sheet — put "
    "those in missing_info instead. If the summary box was BLANK, use the "
    "continuity context below to state what the crew was continuing, and add "
    '"work description inferred from prior day — confirm" to missing_info.'
)

DETAIL_NOTE_NARRATIVE = (
    "Write the summary the way the sample daily reports do — a short factual "
    "narrative of the crew's day. You may connect the sheet's facts into full "
    "sentences, but you may NOT introduce any station, quantity, or measurement "
    "that is not on the sheet. Anything you would need but do not have goes in "
    "missing_info."
)


# ============================================
# Classification prompt (one page, cheap)
# ============================================

CLASSIFY_PROMPT = """Look at this single page and answer what kind of construction document it is.

doc_type must be exactly one of:
  timesheet  — a contractor's daily labor/equipment sheet (printed roster, handwritten hours)
  sub_email  — a printed or saved email from a subcontractor or vendor about work performed
  dispatch   — a paving/crew dispatch sheet
  schedule   — a look-ahead or digout/paving schedule
  other      — anything else

work_date: the work date shown on the page, as YYYY-MM-DD. Empty string if none
is visible. Do NOT guess a year that is not on the page.

confidence: 0.0 to 1.0.

Answer with JSON only.
"""


# ============================================
# Structured-output schemas (enforced by Gemini)
# ============================================

class TimesheetManpower(BaseModel):
    trade: str = ""
    name: str = ""
    company: str = ""
    qty: float = 1
    hours: float = 0
    ot_hours: float = 0
    start_time: str = ""
    stop_time: str = ""
    is_3rd_party: bool = False


class TimesheetEquipment(BaseModel):
    name: str = ""
    description: str = ""
    company: str = ""
    qty: float = 1
    hours: float = 0
    start_time: str = ""
    stop_time: str = ""
    is_rental: bool = False
    is_3rd_party: bool = False


class TimesheetThirdParty(BaseModel):
    company: str = ""
    work_performed: str = ""
    crew_size: float = 0
    hours: float = 0


class TimesheetActivity(BaseModel):
    work_area: str = ""
    stations: str = ""
    summary: str = ""
    needs_location: bool = False
    source_sheet: str = ""
    manpower: list[TimesheetManpower] = []
    equipment: list[TimesheetEquipment] = []
    third_party: list[TimesheetThirdParty] = []
    missing_info: list[str] = []
    uncertain_fields: list[str] = []


class ExcludedSheet(BaseModel):
    sheet: str = ""
    reason: str = ""


class TimesheetParseResult(BaseModel):
    activities: list[TimesheetActivity] = []
    shift_start: str = ""
    shift_stop: str = ""
    general_notes: str = ""
    excluded_sheets: list[ExcludedSheet] = []


class ClassifyResult(BaseModel):
    doc_type: str = "other"
    work_date: str = ""
    confidence: float = 0.0


# ============================================
# Request / response models
# ============================================

class BackfillFileInfo(BaseModel):
    file_id: str
    filename: str
    doc_type: str = "timesheet"
    work_date: str = ""
    confidence: float = 0.0
    date_source: str = ""          # "filename" | "filename_corrected" | "ai" | "none"
    weekday_check: str = ""        # "ok" | "corrected" | "mismatch" | ""
    page_count: int = 0
    size_bytes: int = 0
    note: str = ""


class BackfillUploadResponse(BaseModel):
    batch_id: str
    files: list[BackfillFileInfo] = []


class BackfillGroup(BaseModel):
    date: str
    file_ids: list[str] = []


class BackfillGenerateRequest(BaseModel):
    batch_id: str
    groups: list[BackfillGroup] = []
    project_defaults_from_settings: bool = True
    detail_level: str = "factual"      # "factual" | "narrative"
    use_continuity: bool = True
    fetch_weather: bool = True


class BackfillGenerateResponse(BaseModel):
    batch_id: str
    queued_dates: list[str] = []
    message: str = ""


# ============================================
# Batch storage helpers
# ============================================

def _batch_dir(batch_id: str) -> str:
    """Resolve a batch directory, refusing anything that escapes BACKFILL_DIR."""
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", batch_id):
        raise HTTPException(status_code=400, detail="Invalid batch id.")
    path = os.path.join(BACKFILL_DIR, batch_id)
    if not os.path.abspath(path).startswith(os.path.abspath(BACKFILL_DIR)):
        raise HTTPException(status_code=400, detail="Invalid batch id.")
    return path


def _status_path(batch_id: str) -> str:
    return os.path.join(_batch_dir(batch_id), "status.json")


def _read_status(batch_id: str) -> dict[str, Any]:
    path = _status_path(batch_id)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Batch not found.")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logger.error(f"[backfill] Could not read status for {batch_id}: {exc}")
        raise HTTPException(status_code=500, detail="Batch status is unreadable.")


def _write_status(batch_id: str, status: dict[str, Any]) -> None:
    """
    Atomic write. Called after every single date so a crash 20 dates in never
    loses the 19 that already succeeded.
    """
    path = _status_path(batch_id)
    status["updated_at"] = datetime.utcnow().isoformat()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(status, f, indent=2, default=str)
    shutil.move(tmp, path)


# ============================================
# Filename date parsing (with weekday checksum)
# ============================================

def _weekday_in_filename(filename: str) -> Optional[int]:
    lowered = filename.lower()
    for name, idx in WEEKDAY_NAMES.items():
        if name in lowered:
            return idx
    return None


def _extract_date_from_filename(filename: str) -> tuple[str, str, str]:
    """
    Pull a work date out of the filename.

    Returns (date_str, date_source, weekday_check).

    The weekday in the filename is a checksum, and it matters: two files in the
    January-2026 folder are named "1.2.25 Friday.pdf" and "1.16.25 Friday.pdf".
    Those dates were Thursdays in 2025 and Fridays in 2026 — the year in the name
    is a typo. When the weekday disagrees, we try the neighbouring years and take
    the one the weekday confirms.
    """
    stem = os.path.basename(filename)
    expected_weekday = _weekday_in_filename(stem)

    candidates: list[date_type] = []

    iso = _ISO_DATE.search(stem)
    dashed = _DASHED_DATE.search(stem)
    dotted = _DOTTED_DATE.search(stem)

    if iso:
        y, m, d = int(iso.group(1)), int(iso.group(2)), int(iso.group(3))
        try:
            candidates.append(date_type(y, m, d))
        except ValueError:
            pass
    elif dashed:
        m, d, y = int(dashed.group(1)), int(dashed.group(2)), int(dashed.group(3))
        try:
            candidates.append(date_type(y, m, d))
        except ValueError:
            pass
    elif dotted:
        m, d, raw_y = int(dotted.group(1)), int(dotted.group(2)), dotted.group(3)
        year = int(raw_y)
        if len(raw_y) <= 2:
            year += 2000
        for candidate_year in (year, year + 1, year - 1):
            try:
                candidates.append(date_type(candidate_year, m, d))
            except ValueError:
                continue

    if not candidates:
        return "", "none", ""

    primary = candidates[0]
    if expected_weekday is None:
        return primary.isoformat(), "filename", ""

    if primary.weekday() == expected_weekday:
        return primary.isoformat(), "filename", "ok"

    for alt in candidates[1:]:
        if alt.weekday() == expected_weekday:
            logger.info(
                f"[backfill] Filename year looks like a typo: '{stem}' says "
                f"{primary.isoformat()} but the weekday matches {alt.isoformat()} — using that."
            )
            return alt.isoformat(), "filename_corrected", "corrected"

    # Weekday disagrees with every candidate — keep the literal reading and flag it.
    return primary.isoformat(), "filename", "mismatch"


# ============================================
# PDF / image rendering
# ============================================

def _render_pages(
    file_bytes: bytes,
    filename: str,
    max_pages: Optional[int] = None,
    dpi_ladder: Optional[list[int]] = None,
) -> tuple[list[bytes], int, int]:
    """
    Render a PDF (or pass through an image) to JPEG bytes for Gemini.

    Returns (jpeg_pages, page_count, dpi_used).

    Steps the DPI down until the whole day fits the inline request budget rather
    than dropping pages — a day can be 17 pages and a dropped page is a crew that
    silently vanishes from the report.
    """
    lowered = filename.lower()
    if not lowered.endswith(".pdf"):
        # Already an image (phone photo of a sheet) — hand it over untouched.
        return [file_bytes], 1, 0

    import fitz  # PyMuPDF

    ladder = dpi_ladder or RENDER_DPI_LADDER
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    page_count = len(doc)
    page_range = range(min(page_count, max_pages) if max_pages else page_count)

    pages: list[bytes] = []
    dpi_used = ladder[-1]
    try:
        for dpi in ladder:
            pages = []
            total = 0
            for page_num in page_range:
                pix = doc[page_num].get_pixmap(dpi=dpi, alpha=False)
                img = pix.tobytes("jpeg", jpg_quality=JPEG_QUALITY)
                pages.append(img)
                total += len(img)
            dpi_used = dpi
            if total <= INLINE_IMAGE_BUDGET_BYTES:
                break
            logger.warning(
                f"[backfill] {filename}: {len(pages)} pages at {dpi} DPI = "
                f"{total / 1024 / 1024:.1f} MB, over budget — retrying lower."
            )
    finally:
        doc.close()

    return pages, page_count, dpi_used


def _image_parts(pages: list[bytes]) -> list[Any]:
    from google.genai import types as genai_types
    return [
        genai_types.Part.from_bytes(data=page, mime_type="image/jpeg")
        for page in pages
    ]


# ============================================
# The scope rule
# ============================================

def _backfill_settings() -> dict[str, Any]:
    from app.routers.settings import _load
    settings = _load()
    config = settings.get("backfill") or {}
    return {
        "tunnel_foremen": config.get("tunnel_foremen", []),
        "tunnel_job_keywords": config.get("tunnel_job_keywords", ["805", "tunnel"]),
        "_settings": settings,
    }


def _sheet_is_tunnel(sheet_text: str, tunnel_foremen: list[str], keywords: list[str]) -> tuple[bool, str]:
    """
    Decide whether one transcribed sheet is 805 tunnel work.

    Two independent signals, per the scope rule:
      - the job name mentions 805 or tunnel, or
      - the foreman is one of the configured tunnel foremen.

    The foreman signal is configured rather than hardcoded because the man who
    carries it came off the tunnel; going forward the job-name check is what
    holds. Returns (is_tunnel, reason) — the reason is shown in the review UI so
    nothing is ever excluded invisibly.
    """
    lowered = sheet_text.lower()

    job_match = re.search(r"job name:\s*(.+)", lowered)
    job_name = job_match.group(1).strip() if job_match else ""
    for keyword in keywords:
        if keyword.lower() in job_name:
            return True, f"job name mentions '{keyword}' ({job_name[:60]})"

    foreman_match = re.search(r"foreman:\s*(.+)", lowered)
    foreman = foreman_match.group(1).strip() if foreman_match else ""
    for name in tunnel_foremen:
        if name and name.lower() in foreman:
            return True, f"foreman is {name} (configured tunnel foreman)"

    return False, ""


def _split_sheets(pass1_text: str) -> list[tuple[str, str]]:
    """Split the pass-1 transcription into (sheet_label, sheet_text) chunks."""
    parts = re.split(r"(?im)^\s*(SHEET\s+\d+)\s*$", pass1_text)
    if len(parts) < 3:
        return [("SHEET 1", pass1_text)]
    sheets: list[tuple[str, str]] = []
    for i in range(1, len(parts) - 1, 2):
        sheets.append((parts[i].strip(), parts[i] + "\n" + parts[i + 1]))
    return sheets


def _apply_scope_rule(pass1_text: str) -> tuple[str, list[dict[str, str]]]:
    """
    Remove tunnel-crew sheets from the transcription before structuring.

    Returns (kept_text, excluded) where excluded records every dropped sheet with
    the reason it was dropped.
    """
    config = _backfill_settings()
    sheets = _split_sheets(pass1_text)

    kept: list[str] = []
    excluded: list[dict[str, str]] = []

    for label, text in sheets:
        is_tunnel, reason = _sheet_is_tunnel(
            text, config["tunnel_foremen"], config["tunnel_job_keywords"]
        )
        if is_tunnel:
            excluded.append({"sheet": label, "reason": f"805 tunnel crew — {reason}"})
            logger.info(f"[backfill] Excluding {label}: {reason}")
        else:
            kept.append(text)

    return "\n\n".join(kept).strip(), excluded


# ============================================
# Continuity — what was this crew doing yesterday
# ============================================

async def _continuity_block(work_date: str, use_continuity: bool) -> str:
    """
    Build the prior-days context that lets a BLANK summary box be filled in.

    A crew stays on a task until it is finished, so the previous day's summary
    for the same crew is the best available evidence of what a blank box meant.
    Anything inferred this way is flagged in missing_info for confirmation.
    """
    if not use_continuity:
        return ""

    from app.services.database import list_reports, get_report

    try:
        target = datetime.strptime(work_date, "%Y-%m-%d").date()
    except ValueError:
        return ""

    window_start = (target - timedelta(days=7)).isoformat()
    try:
        prior = list_reports(
            limit=5, offset=0,
            date_from=window_start,
            date_to=(target - timedelta(days=1)).isoformat(),
        )
    except Exception as exc:
        logger.warning(f"[backfill] Continuity lookup failed for {work_date}: {exc}")
        return ""

    if not prior:
        return ""

    lines: list[str] = []
    for index_row in prior[:3]:
        report = get_report(index_row.get("id", ""))
        if not report:
            continue
        report_date = (report.get("general") or {}).get("report_date", "")
        for act in report.get("activities", [])[:6]:
            summary = (act.get("summary") or "").replace("\n", " ")[:400]
            if summary:
                lines.append(f"  {report_date} — {act.get('work_area', '')}: {summary}")

    if not lines:
        return ""

    return (
        "CONTINUITY CONTEXT — what these crews were doing on the days before "
        f"{work_date}. Use this ONLY to interpret a BLANK summary box (a crew "
        "stays on a task until it is finished). Never copy a station, quantity "
        "or measurement out of it into today's activity.\n"
        + "\n".join(lines)
        + "\n"
    )


# ============================================
# Weather
# ============================================

_geocode_cache: dict[str, tuple[float, float, str]] = {}


async def _geocode_zip(zip_code: str) -> Optional[tuple[float, float, str]]:
    if zip_code in _geocode_cache:
        return _geocode_cache[zip_code]

    import httpx
    from app.routers.weather import GEOCODING_URL

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                GEOCODING_URL,
                params={"name": zip_code, "count": 1, "language": "en", "format": "json"},
            )
            response.raise_for_status()
            results = response.json().get("results", [])
    except Exception as exc:
        logger.warning(f"[backfill] Geocoding {zip_code} failed: {exc}")
        return None

    if not results:
        return None

    location = (
        float(results[0].get("latitude")),
        float(results[0].get("longitude")),
        results[0].get("name", zip_code),
    )
    _geocode_cache[zip_code] = location
    return location


async def _weather_for(work_date: str, zip_code: str) -> dict[str, Any]:
    """
    Historical weather for one backfill date. Never fatal — a missing forecast
    must not cost us the report.
    """
    if not zip_code:
        return {}

    location = await _geocode_zip(zip_code)
    if not location:
        return {}

    from app.routers.weather import _fetch_weather

    lat, lon, label = location
    try:
        return await _fetch_weather(lat, lon, label, date=work_date)
    except HTTPException as exc:
        logger.warning(f"[backfill] No weather for {work_date}: {exc.detail}")
        return {}
    except Exception as exc:
        logger.warning(f"[backfill] Weather lookup failed for {work_date}: {exc}")
        return {}


# ============================================
# Gemini passes
# ============================================

def _read_timesheets(client: Any, model_name: str, image_parts: list[Any], work_date: str) -> str:
    """Pass 1 — read the pages as text. No JSON, no schema."""
    from google.genai import types as genai_types

    response = _gemini_call_with_retry(
        client, model_name,
        contents=[TIMESHEET_READ_PROMPT] + image_parts,
        config=genai_types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=32768,
            thinking_config=genai_types.ThinkingConfig(thinking_budget=8192),
        ),
    )

    problem = _finish_reason_problem(response)
    text = getattr(response, "text", None) or ""
    if problem and not text:
        raise RuntimeError(f"Timesheet read failed: {problem}")
    if problem:
        logger.warning(f"[backfill] {work_date} pass 1: {problem}")
    if not text.strip():
        raise RuntimeError("The model returned no transcription for these pages.")
    return text


def _structure_timesheets(
    client: Any,
    model_name: str,
    pass1_text: str,
    work_date: str,
    detail_level: str,
    continuity: str,
    scope_note: str,
) -> dict[str, Any]:
    """Pass 2 — structure the verified text. Schema-enforced, no images."""
    from google.genai import types as genai_types

    prompt = TIMESHEET_JSON_PROMPT.format(
        work_date=work_date,
        scope_note=scope_note,
        detail_note=(
            DETAIL_NOTE_NARRATIVE if detail_level == "narrative" else DETAIL_NOTE_FACTUAL
        ),
        continuity_block=continuity,
        pass1_text=pass1_text,
    )

    response = _gemini_call_with_retry(
        client, model_name,
        contents=[prompt],
        config=genai_types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json",
            response_schema=TimesheetParseResult,
            max_output_tokens=32768,
        ),
    )

    problem = _finish_reason_problem(response)
    raw = getattr(response, "text", None) or ""
    if problem and not raw:
        raise RuntimeError(f"Timesheet structuring failed: {problem}")
    if problem:
        logger.warning(f"[backfill] {work_date} pass 2: {problem}")

    return _clean_json(raw)


def _read_sub_email(client: Any, model_name: str, parts: list[Any], work_date: str) -> str:
    """Read a subcontractor email PDF for work details to merge into the day."""
    from google.genai import types as genai_types

    prompt = (
        "This is a subcontractor or vendor email about work performed on "
        f"{work_date}. Transcribe the work details it reports: who was on site, "
        "what they did, where, how many people, how many hours, and any "
        "equipment or materials. Plain text. Quote quantities exactly. If "
        "something is unreadable write [illegible]. Do not infer anything that "
        "is not written."
    )

    response = _gemini_call_with_retry(
        client, model_name,
        contents=[prompt] + parts,
        config=genai_types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=8192,
        ),
    )
    return getattr(response, "text", None) or ""


def _classify_file(client: Any, model_name: str, parts: list[Any]) -> dict[str, Any]:
    """One cheap call on the first page: what is this, and what date is on it."""
    from google.genai import types as genai_types

    response = _gemini_call_with_retry(
        client, model_name,
        contents=[CLASSIFY_PROMPT] + parts,
        config=genai_types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json",
            response_schema=ClassifyResult,
            max_output_tokens=1024,
        ),
    )
    return _clean_json(getattr(response, "text", None) or "{}")


# ============================================
# Report assembly
# ============================================

_RESOURCE_KEYS = (
    "manpower", "equipment", "extra_work_manpower",
    "extra_work_equipment", "consultant_manpower",
)


def _build_report(
    work_date: str,
    parsed: dict[str, Any],
    weather: dict[str, Any],
    settings: dict[str, Any],
    batch_id: str,
    source_files: list[dict[str, str]],
    excluded: list[dict[str, str]],
    sub_email_notes: list[str],
) -> dict[str, Any]:
    """Turn a parsed day into a saveable draft report."""
    activities: list[dict[str, Any]] = []
    flags: list[str] = []

    for act in parsed.get("activities", []) or []:
        third_party = act.get("third_party", []) or []
        summary = act.get("summary", "") or ""

        # Subcontractor lines the timesheet named but did not itemise belong in
        # the summary — they are what the sub email will later corroborate.
        for party in third_party:
            company = party.get("company", "")
            work = party.get("work_performed", "")
            if company and work:
                summary = summary.rstrip() + f"\n• {company}: {work}"

        activity = {
            "id": str(uuid.uuid4()),
            "work_area": act.get("work_area", ""),
            "stations": act.get("stations", ""),
            "summary": summary,
            "manpower": act.get("manpower", []) or [],
            "equipment": act.get("equipment", []) or [],
            "extra_work_manpower": [],
            "extra_work_equipment": [],
            "consultant_manpower": [],
        }

        for key in _RESOURCE_KEYS:
            for row in activity.get(key, []):
                if isinstance(row, dict):
                    row["id"] = row.get("id") or str(uuid.uuid4())

        activities.append(activity)

        label = act.get("work_area") or act.get("source_sheet") or "activity"
        for uncertain in act.get("uncertain_fields", []) or []:
            flags.append(f"{label}: illegible — {uncertain}")
        for missing in act.get("missing_info", []) or []:
            flags.append(f"{label}: missing — {missing}")
        if act.get("needs_location"):
            flags.append(f"{label}: no location on the timesheet")

    notes_parts: list[str] = []
    if parsed.get("general_notes"):
        notes_parts.append(parsed["general_notes"])
    if sub_email_notes:
        notes_parts.append(
            "From subcontractor emails:\n" + "\n".join(sub_email_notes)
        )
    if excluded:
        notes_parts.append(
            "Excluded from this report (scope rule): "
            + "; ".join(f"{item['sheet']} — {item['reason']}" for item in excluded)
        )

    sky_conditions = []
    if weather.get("sky_condition_id"):
        sky_conditions = [{
            "id": weather["sky_condition_id"],
            "label": weather.get("condition", ""),
            "emoji": weather.get("emoji", ""),
        }]

    report = {
        "id": str(uuid.uuid4()),
        "general": {
            "project_name": settings.get("default_project", ""),
            "project_number": settings.get("project_number", ""),
            "project_location": settings.get("project_location", ""),
            "inspector_name": "",
            "resident_engineer": settings.get("default_resident_engineer", ""),
            "report_date": work_date,
            "start_time": parsed.get("shift_start", "") or settings.get("default_start_time", "7:00 AM"),
            "end_time": parsed.get("shift_stop", "") or settings.get("default_stop_time", "3:30 PM"),
            "sky_conditions": sky_conditions,
            "temperature_high": weather.get("temperature_high", ""),
            "temperature_low": weather.get("temperature_low", ""),
            "wind_info": weather.get("wind_info", ""),
            "notes": "\n\n".join(notes_parts),
        },
        "activities": activities,
        "photos": [],
        "status": "draft",
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
        # Extra key — ReportModel uses extra="ignore" and the raw-JSON save path
        # keeps it, so the review UI can find its way back to the source scans.
        "backfill": {
            "batch_id": batch_id,
            "flags": flags,
            "excluded_sheets": excluded,
            "source_files": source_files,
            "generated_at": datetime.utcnow().isoformat(),
        },
    }

    return report


# ============================================
# ENDPOINT: upload
# ============================================

@router.post("/upload", response_model=BackfillUploadResponse)
async def upload_backfill_files(files: list[UploadFile] = File(...)):
    """
    Store source documents and work out what each one is and which day it covers.

    The filename is tried first — it is free, and the contractor's own naming
    ("1.13.26 Tuesday.pdf") carries a weekday that catches the year typos. Only
    files the filename cannot date cost an AI call.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")

    batch_id = str(uuid.uuid4())
    batch_path = os.path.join(BACKFILL_DIR, batch_id)
    files_path = os.path.join(batch_path, "files")
    os.makedirs(files_path, exist_ok=True)

    client = None
    model_name = ""

    results: list[BackfillFileInfo] = []

    for upload in files:
        filename = upload.filename or "unnamed"
        file_bytes = await upload.read()
        file_id = str(uuid.uuid4())

        stored_name = f"{file_id}_{re.sub(r'[^A-Za-z0-9._-]', '_', filename)}"
        stored_path = os.path.join(files_path, stored_name)
        with open(stored_path, "wb") as f:
            f.write(file_bytes)

        date_str, date_source, weekday_check = _extract_date_from_filename(filename)
        doc_type = "timesheet"
        confidence = 0.9 if date_str else 0.0
        note = ""

        lowered = filename.lower()
        if "email" in lowered or "re_" in lowered or lowered.startswith("[external]"):
            doc_type = "sub_email"

        page_count = 0
        try:
            if lowered.endswith(".pdf"):
                import fitz
                doc = fitz.open(stream=file_bytes, filetype="pdf")
                page_count = len(doc)
                doc.close()
        except Exception as exc:
            logger.warning(f"[backfill/upload] Could not read page count for {filename}: {exc}")

        # Only pay for a model call when the filename gave us nothing.
        if not date_str:
            try:
                if client is None:
                    client, model_name = _get_gemini_client()
                pages, _, _ = _render_pages(
                    file_bytes, filename, max_pages=1, dpi_ladder=[CLASSIFY_DPI]
                )
                classified = _classify_file(client, model_name, _image_parts(pages))
                doc_type = classified.get("doc_type", doc_type) or doc_type
                date_str = classified.get("work_date", "") or ""
                confidence = float(classified.get("confidence", 0.0) or 0.0)
                date_source = "ai" if date_str else "none"
                if not date_str:
                    note = "No date found — set it in the Group step."
            except Exception as exc:
                logger.warning(f"[backfill/upload] Classification failed for {filename}: {exc}")
                date_source = "none"
                note = f"Could not classify automatically: {exc}"

        if weekday_check == "corrected":
            note = "Year in the filename disagreed with the weekday — corrected."
        elif weekday_check == "mismatch":
            note = "Filename weekday does not match the date — please confirm."

        results.append(BackfillFileInfo(
            file_id=file_id,
            filename=filename,
            doc_type=doc_type,
            work_date=date_str,
            confidence=confidence,
            date_source=date_source,
            weekday_check=weekday_check,
            page_count=page_count,
            size_bytes=len(file_bytes),
            note=note,
        ))

        logger.info(
            f"[backfill/upload] {filename} → {doc_type}, date={date_str or 'unknown'} "
            f"({date_source}), {page_count} pages"
        )

    status = {
        "batch_id": batch_id,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
        "state": "uploaded",
        "files": [
            {**info.model_dump(), "stored_name": f"{info.file_id}_"
             f"{re.sub(r'[^A-Za-z0-9._-]', '_', info.filename)}"}
            for info in results
        ],
        "dates": [],
    }
    _write_status(batch_id, status)

    return BackfillUploadResponse(batch_id=batch_id, files=results)


# ============================================
# ENDPOINT: generate
# ============================================

@router.post("/generate", response_model=BackfillGenerateResponse)
async def generate_backfill_reports(
    request: BackfillGenerateRequest,
    background_tasks: BackgroundTasks,
):
    """
    Build one draft report per date, sequentially, in the background.

    Sequential on purpose: each date's continuity context reads the reports the
    earlier dates just produced, and status.json is rewritten after every date so
    a crash or a restart costs one date, not the batch.
    """
    status = _read_status(request.batch_id)

    if not request.groups:
        raise HTTPException(status_code=400, detail="No date groups provided.")

    if status.get("state") == "generating":
        raise HTTPException(status_code=409, detail="This batch is already generating.")

    groups = sorted(request.groups, key=lambda g: g.date)

    # Merge, never replace. New timesheets arrive for the makeup window a few at
    # a time, so a second run must process only its own dates and leave every
    # date already generated exactly as it was. Re-running a date that is
    # already done is allowed — it resets that one entry and nothing else.
    existing = {entry["date"]: entry for entry in status.get("dates", [])}
    for group in groups:
        existing[group.date] = {
            "date": group.date,
            "state": "pending",
            "file_ids": group.file_ids,
            "report_id": "",
            "flag_count": 0,
            "flags": [],
            "excluded_sheets": [],
            "activity_count": 0,
            "message": "",
        }

    status["state"] = "generating"
    status["detail_level"] = request.detail_level
    status["dates"] = sorted(existing.values(), key=lambda entry: entry["date"])
    _write_status(request.batch_id, status)

    requested = [group.date for group in groups]
    background_tasks.add_task(_run_generation, request.batch_id, request, requested)

    return BackfillGenerateResponse(
        batch_id=request.batch_id,
        queued_dates=[group.date for group in groups],
        message=f"Generating {len(groups)} report(s).",
    )


async def _run_generation(
    batch_id: str,
    request: BackfillGenerateRequest,
    requested_dates: list[str],
) -> None:
    """Worker for /generate. Never raises — every failure lands in status.json."""
    try:
        status = _read_status(batch_id)
    except HTTPException:
        logger.error(f"[backfill/generate] Batch {batch_id} vanished before generation.")
        return

    config = _backfill_settings()
    settings = config["_settings"]
    zip_code = settings.get("default_zip_code", "") if request.fetch_weather else ""

    scope_note = (
        "SCOPE: the 805 tunnel crew's sheets have already been removed from the "
        "transcription below. Everything left is in scope for this report. Do not "
        "add anything back."
    )

    files_by_id = {f["file_id"]: f for f in status.get("files", [])}
    files_dir = os.path.join(_batch_dir(batch_id), "files")

    client = None
    model_name = ""

    wanted = set(requested_dates)
    for entry in status["dates"]:
        work_date = entry["date"]
        if work_date not in wanted:
            continue  # generated by an earlier run — leave it alone
        entry["state"] = "running"
        entry["message"] = "Reading timesheets..."
        _write_status(batch_id, status)

        try:
            if client is None:
                client, model_name = _get_gemini_client()

            timesheet_parts: list[Any] = []
            sub_email_parts: list[list[Any]] = []
            source_files: list[dict[str, str]] = []
            render_notes: list[str] = []

            for file_id in entry["file_ids"]:
                meta = files_by_id.get(file_id)
                if not meta:
                    render_notes.append(f"file {file_id} is not in this batch — skipped")
                    continue

                path = os.path.join(files_dir, meta["stored_name"])
                if not os.path.exists(path):
                    render_notes.append(f"{meta['filename']} is missing from disk — skipped")
                    continue

                with open(path, "rb") as f:
                    file_bytes = f.read()

                pages, page_count, dpi_used = _render_pages(file_bytes, meta["filename"])
                source_files.append({
                    "file_id": file_id,
                    "filename": meta["filename"],
                    "doc_type": meta.get("doc_type", "timesheet"),
                })

                if dpi_used and dpi_used < RENDER_DPI_LADDER[0]:
                    render_notes.append(
                        f"{meta['filename']} rendered at {dpi_used} DPI "
                        f"({page_count} pages) to fit the request size"
                    )

                if meta.get("doc_type") == "sub_email":
                    sub_email_parts.append(_image_parts(pages))
                else:
                    timesheet_parts.extend(_image_parts(pages))

            if not timesheet_parts and not sub_email_parts:
                entry["state"] = "failed"
                entry["message"] = "No readable source files for this date."
                _write_status(batch_id, status)
                continue

            # ── Pass 1: read the pages ──
            pass1_text = ""
            excluded: list[dict[str, str]] = []
            if timesheet_parts:
                pass1_text = await asyncio.to_thread(
                    _read_timesheets, client, model_name, timesheet_parts, work_date
                )
                kept_text, excluded = _apply_scope_rule(pass1_text)
            else:
                kept_text = ""

            # ── Sub emails ──
            sub_email_notes: list[str] = []
            for parts in sub_email_parts:
                entry["message"] = "Reading subcontractor email..."
                _write_status(batch_id, status)
                sub_email_notes.append(
                    await asyncio.to_thread(
                        _read_sub_email, client, model_name, parts, work_date
                    )
                )

            if not kept_text.strip():
                # Every sheet for the day was tunnel work — this date correctly
                # produces no report. Recorded, not silently dropped.
                entry["state"] = "skipped"
                entry["excluded_sheets"] = excluded
                entry["message"] = (
                    "Tunnel-crew work only — no report for this date."
                    if excluded else "Nothing in scope was found on these sheets."
                )
                _write_status(batch_id, status)
                logger.info(f"[backfill/generate] {work_date}: skipped ({entry['message']})")
                continue

            # ── Pass 2: structure it ──
            entry["message"] = "Structuring activities..."
            _write_status(batch_id, status)

            continuity = await _continuity_block(work_date, request.use_continuity)
            parsed = await asyncio.to_thread(
                _structure_timesheets,
                client, model_name, kept_text, work_date,
                request.detail_level, continuity, scope_note,
            )

            for item in excluded:
                parsed.setdefault("excluded_sheets", []).append(item)

            # ── Weather ──
            entry["message"] = "Fetching weather..."
            _write_status(batch_id, status)
            weather = await _weather_for(work_date, zip_code)

            # ── Build + save ──
            report = _build_report(
                work_date=work_date,
                parsed=parsed,
                weather=weather,
                settings=settings if request.project_defaults_from_settings else {},
                batch_id=batch_id,
                source_files=source_files,
                excluded=excluded,
                sub_email_notes=[note for note in sub_email_notes if note.strip()],
            )

            for note in render_notes:
                report["backfill"]["flags"].append(f"source: {note}")
            if not weather and zip_code:
                report["backfill"]["flags"].append("weather: not available for this date")
            if not zip_code and request.fetch_weather:
                report["backfill"]["flags"].append(
                    "weather: skipped — no default ZIP code in Settings"
                )

            from app.services.reports import save_report
            await save_report(report)

            # Persist the transcription next to the batch — it is the audit trail
            # for a disputed reading, and it is expensive to reproduce.
            transcript_path = os.path.join(_batch_dir(batch_id), f"pass1_{work_date}.txt")
            with open(transcript_path, "w", encoding="utf-8") as f:
                f.write(pass1_text)

            entry["state"] = "done"
            entry["report_id"] = report["id"]
            entry["activity_count"] = len(report["activities"])
            entry["flags"] = report["backfill"]["flags"]
            entry["flag_count"] = len(report["backfill"]["flags"])
            entry["excluded_sheets"] = excluded
            entry["message"] = f"{len(report['activities'])} activities"
            _write_status(batch_id, status)

            logger.info(
                f"[backfill/generate] {work_date}: report {report['id']} — "
                f"{len(report['activities'])} activities, "
                f"{len(report['backfill']['flags'])} flags, "
                f"{len(excluded)} sheet(s) excluded"
            )

        except Exception as exc:
            logger.exception(f"[backfill/generate] {work_date} failed: {exc}")
            entry["state"] = "failed"
            entry["message"] = str(exc)
            _write_status(batch_id, status)

    status["state"] = "complete"
    _write_status(batch_id, status)
    logger.info(f"[backfill/generate] Batch {batch_id} complete.")


# ============================================
# ENDPOINT: status / list / file / export
# ============================================

@router.get("")
async def list_batches() -> dict[str, Any]:
    """List batches newest first, so a reload can pick up where it left off."""
    if not os.path.isdir(BACKFILL_DIR):
        return {"batches": []}

    batches: list[dict[str, Any]] = []
    for entry in os.listdir(BACKFILL_DIR):
        status_file = os.path.join(BACKFILL_DIR, entry, "status.json")
        if not os.path.exists(status_file):
            continue
        try:
            with open(status_file, "r", encoding="utf-8") as f:
                status = json.load(f)
        except Exception:
            continue
        dates = status.get("dates", [])
        batches.append({
            "batch_id": status.get("batch_id", entry),
            "created_at": status.get("created_at", ""),
            "updated_at": status.get("updated_at", ""),
            "state": status.get("state", ""),
            "file_count": len(status.get("files", [])),
            "date_count": len(dates),
            "done_count": sum(1 for d in dates if d.get("state") == "done"),
        })

    batches.sort(key=lambda b: b.get("created_at", ""), reverse=True)
    return {"batches": batches}


@router.get("/{batch_id}/status")
async def get_batch_status(batch_id: str) -> dict[str, Any]:
    """Full status.json for a batch — what the Generate step polls."""
    return _read_status(batch_id)


@router.get("/{batch_id}/file/{file_id}")
async def get_batch_file(batch_id: str, file_id: str):
    """Serve a stored source file so the review UI can show it beside the extraction."""
    status = _read_status(batch_id)
    meta = next((f for f in status.get("files", []) if f.get("file_id") == file_id), None)
    if not meta:
        raise HTTPException(status_code=404, detail="File not found in this batch.")

    path = os.path.join(_batch_dir(batch_id), "files", meta["stored_name"])
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File is missing from disk.")

    lowered = meta["filename"].lower()
    if lowered.endswith(".pdf"):
        media_type = "application/pdf"
    elif lowered.endswith(".png"):
        media_type = "image/png"
    elif lowered.endswith((".jpg", ".jpeg")):
        media_type = "image/jpeg"
    else:
        media_type = "application/octet-stream"

    return FileResponse(path, media_type=media_type, filename=meta["filename"])


@router.get("/{batch_id}/export.zip")
async def export_batch(batch_id: str):
    """Every generated report in the batch, as .docx, in one zip."""
    status = _read_status(batch_id)

    done = [d for d in status.get("dates", []) if d.get("state") == "done" and d.get("report_id")]
    if not done:
        raise HTTPException(status_code=404, detail="No generated reports in this batch yet.")

    from app.services.database import get_report
    from app.services.word import generate_word_document

    buffer = io.BytesIO()
    written = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry in done:
            report = get_report(entry["report_id"])
            if not report:
                logger.warning(
                    f"[backfill/export] Report {entry['report_id']} "
                    f"({entry['date']}) is gone — skipping."
                )
                continue
            try:
                stream = generate_word_document(report)
            except Exception as exc:
                logger.error(f"[backfill/export] {entry['date']} failed to render: {exc}")
                continue
            archive.writestr(
                f"Daily Report {entry['date']}.docx", stream.getvalue()
            )
            written += 1

    if not written:
        raise HTTPException(status_code=500, detail="No reports could be exported.")

    buffer.seek(0)
    logger.info(f"[backfill/export] Batch {batch_id}: {written} report(s) zipped.")

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="backfill-{batch_id[:8]}.zip"'},
    )
