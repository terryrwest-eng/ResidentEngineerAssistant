"""
Daily Reporter V3 — Reports Router

CRUD operations for daily field reports.
Every save writes to both SQLite and a JSON file.
"""

import json
import os
import uuid
import logging
from collections import Counter
from datetime import datetime
from typing import Optional

from fastapi import Depends, APIRouter, HTTPException, Query, Request


from app.core.paths import data_dir
from app.models.report import ReportModel, ReportIndexModel
from app.services.database import (
    save_report,
    get_report,
    list_reports,
    delete_report,
    get_report_count,
    find_report_by_date,
)

logger = logging.getLogger(__name__)
from app.core.auth import require_user

# Every route below requires a signed-in user, declared once here rather than on
# each endpoint: a per-endpoint decorator is something you can forget to add,
# and forgetting it on a data route would expose one user's records to another.
# require_user also pins the request to that user's storage, which is what makes
# every path in this file resolve inside their own directory.
router = APIRouter(prefix="/api", tags=["reports"], dependencies=[Depends(require_user)])


def _normalize_activities(report_dict: dict) -> None:
    """
    AI endpoints emit "summary_html"; the model, Word exporter and notes HTML
    all read "summary". Collapse to "summary" on the way in so a report saved
    from any source exports correctly.
    """
    activities = report_dict.get("activities")
    if not isinstance(activities, list):
        return
    for act in activities:
        if isinstance(act, dict) and not act.get("summary") and act.get("summary_html"):
            act["summary"] = act.pop("summary_html")


@router.post("/reports", response_model=dict)
async def create_report(request: Request):
    """
    Create a new daily field report.
    Accepts raw JSON — no Pydantic validation.
    Saves to both SQLite and a JSON file.

    A create NEVER overwrites an existing report. If one already exists for this
    date and project, this returns 409 with its ID and writes nothing at all —
    the caller decides whether to open that report or deliberately keep both.

    WHY 409 rather than silently updating the existing report: clients auto-save
    from the first keystroke, so a report opened by accident on a day that has
    already been written would otherwise replace a finished report with an empty
    one. Losing a day's work is far worse than a duplicate, and neither outcome
    should be chosen on the user's behalf without asking.

    Pass "allow_duplicate": true to create a second report for a day that
    already has one (Save As, or the user answering the warning).
    """
    report_dict = await request.json()
    _normalize_activities(report_dict)
    allow_duplicate = bool(report_dict.pop("allow_duplicate", False))

    # NOTE: do not assign an id here. The duplicate-date guard below only runs
    # when the report has no id yet, so minting one early silently disables it
    # and lets a new report overwrite a day that was already written.

    now = datetime.utcnow().isoformat()

    if not report_dict.get("id"):
        general = report_dict.get("general") or {}
        report_date = general.get("report_date", "")
        project_name = general.get("project_name", "")

        if not allow_duplicate:
            existing = find_report_by_date(report_date, project_name)
            if existing:
                logger.info(
                    f"Refusing to create a second report for {report_date!r} "
                    f"(project {project_name!r}) — {existing['id']} already exists"
                )
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "report_exists_for_date",
                        "existing_id": existing["id"],
                        "report_date": report_date,
                        "project_name": project_name,
                        "message": "A report already exists for this date.",
                    },
                )

        report_dict["id"] = str(uuid.uuid4())
        report_dict["created_at"] = now
    else:
        report_dict.setdefault("created_at", now)

    report_dict["updated_at"] = now

    file_path = save_report(report_dict)
    logger.info(f"Created report {report_dict['id']} → {file_path}")

    return {"id": report_dict["id"], "file_path": file_path, "message": "Report created"}


@router.get("/reports")
async def get_reports(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: Optional[str] = None,
    project: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """
    List reports (lightweight index data, not full content).
    Supports filtering by status, project name, and date range.
    """
    reports = list_reports(
        limit=limit,
        offset=offset,
        status=status,
        project_name=project,
        date_from=date_from,
        date_to=date_to,
    )
    total = get_report_count()

    return {"reports": reports, "total": total}


@router.get("/reports/{report_id}")
async def get_report_by_id(report_id: str):
    """
    Get a full report by ID.
    Reads from the JSON file for complete data.
    """
    report = get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@router.put("/reports/{report_id}")
async def update_report(report_id: str, request: Request):
    """
    Update an existing report.
    Accepts raw JSON — no Pydantic validation.
    Overwrites both the SQLite index and the JSON file.
    """
    # Verify report exists
    existing = get_report(report_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Report not found")

    report_dict = await request.json()
    _normalize_activities(report_dict)
    report_dict["id"] = report_id
    report_dict["created_at"] = existing.get("created_at", datetime.utcnow().isoformat())

    file_path = save_report(report_dict)
    logger.info(f"Updated report {report_id} → {file_path}")

    return {"id": report_id, "file_path": file_path, "message": "Report updated"}


@router.delete("/reports/{report_id}")
async def delete_report_by_id(report_id: str):
    """
    Delete a report from both SQLite and the filesystem.
    """
    success = delete_report(report_id)
    if not success:
        raise HTTPException(status_code=404, detail="Report not found")

    return {"message": "Report deleted", "id": report_id}


@router.get("/reports/stats/summary")
async def get_report_stats():
    """Get summary statistics about all reports."""
    total = get_report_count()
    return {"total_reports": total}


# ============================================
# Chrome Extension Context (in-memory, single-user)
# ============================================

"""
Extension context — which report the Chrome extension should pull.

WHY THIS IS ON DISK AND NOT IN A DICT:

This used to be a module-level `ACTIVE_CONTEXT: dict`. Production runs
`uvicorn --workers 2`, so there were TWO of them, one per process. The web app
POSTs the context to whichever worker answers, and the extension — a separate
browser process, on its own connection — GETs from whichever worker answers it.
Measured against production: of 20 reads after a write, 11 returned the report
just set and 9 returned a stale report ID left in the other worker's memory.

The user's symptom was "the extension isn't pulling data from the report I'm
on"; about half the time it was filling PMWeb from a completely different day.

A file in the data directory is shared by every worker and survives restarts.
The volume is the same one the reports live on, so there is nothing new to
configure.
"""

def _context_path() -> str:
    """Which report the Chrome extension should auto-fill, per user. Was a
    module constant; it now resolves inside the calling user's directory so two
    people using the extension do not overwrite each other's context."""
    return os.path.join(data_dir(), "extension_context.json")


def _read_context() -> dict:
    try:
        with open(_context_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return {"report_id": data.get("report_id") or None}
    except FileNotFoundError:
        return {"report_id": None}
    except Exception as exc:
        logger.warning(f"[extension] Could not read context: {exc}")
        return {"report_id": None}


def _write_context(report_id: str | None) -> None:
    os.makedirs(data_dir(), exist_ok=True)
    tmp = _context_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"report_id": report_id, "updated_at": datetime.utcnow().isoformat()}, f)
    os.replace(tmp, _context_path())


@router.post("/extension/context")
async def set_extension_context(data: dict):
    """
    Sets the active report ID for the Chrome extension.
    Pass report_id=null to clear it (e.g. a new unsaved report).
    """
    report_id = data.get("report_id") or None
    _write_context(report_id)
    if report_id:
        logger.info(f"Extension context set to report: {report_id}")
    else:
        logger.info("Extension context cleared (new report or explicit clear)")
    return {"status": "success", "report_id": report_id}


@router.get("/extension/context")
async def get_extension_context():
    """Which report the extension should pull. Read from disk — see above."""
    return _read_context()


@router.get("/extension/reports")
async def list_reports_for_extension(limit: int = Query(30, ge=1, le=100)):
    """
    Reports for the extension's picker: date, project, status and the actual
    activity names.

    WHY: choosing by date alone is ambiguous when several reports share a date,
    and the whole "active report" handshake above is fragile by design — one
    global pointer, no idea who is asking, silently goes stale. Letting the user
    see the activities and pick directly removes the guesswork.
    """
    index_rows = list_reports(limit=limit, offset=0)
    out = []
    for row in index_rows:
        full = get_report(row.get("id", "")) or {}
        activities = [
            (a.get("work_area") or "").strip() or "Untitled activity"
            for a in (full.get("activities") or [])
        ]
        general = full.get("general") or {}
        out.append({
            "id": row.get("id"),
            "report_date": row.get("report_date") or general.get("report_date") or "",
            "project_name": row.get("project_name") or general.get("project_name") or "",
            "status": row.get("status") or "draft",
            "activity_count": len(activities),
            "activities": activities,
            # Shift times matter here: there is normally one report per day, but
            # a split shift produces two on the same date, and the times are what
            # tell them apart.
            "start_time": general.get("start_time") or "",
            "end_time": general.get("end_time") or "",
            "updated_at": row.get("updated_at") or "",
        })

    # Newest day first, but within a day the EARLIER shift first, so a split
    # shift reads in the order it was worked. Two passes rather than one
    # reversed sort, because the two keys need opposite directions — Python's
    # sort is stable, so the second pass preserves the first's ordering.
    out.sort(key=lambda r: r["start_time"])
    out.sort(key=lambda r: r["report_date"], reverse=True)
    return {"reports": out}


@router.get("/reports/{report_id}/consolidated")
async def get_report_consolidated(report_id: str):
    """
    Returns PMWeb Combined rows for the Chrome extension.
    WHY: Extension popup.js calls /api/reports/{id}/consolidated.
    This is an alias for the same data served by /api/export/{id}/pmweb.
    """
    from app.services.word import aggregate_for_pmweb

    report = get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    rows = aggregate_for_pmweb(report)
    return rows


def _calc_duration_hours(start_str: str, end_str: str) -> float:
    """
    Calculate duration in hours between two time strings (e.g. '7:00 AM', '15:30').
    Returns 8.0 as default if parsing fails.
    """
    from datetime import datetime as dt
    formats = ["%I:%M %p", "%H:%M", "%I:%M%p", "%H:%M:%S"]
    start_dt = end_dt = None
    for fmt in formats:
        if not start_dt:
            try:
                start_dt = dt.strptime(start_str.strip(), fmt)
            except (ValueError, AttributeError):
                pass
        if not end_dt:
            try:
                end_dt = dt.strptime(end_str.strip(), fmt)
            except (ValueError, AttributeError):
                pass
    if start_dt and end_dt:
        diff = (end_dt - start_dt).total_seconds() / 3600
        return diff if diff > 0 else 8.0
    return 8.0


@router.get("/reports/{report_id}/activities-consolidated")
async def get_activities_consolidated(report_id: str):
    """
    Returns PMWeb OnSite Activities rows for the Chrome extension.
    One row per activity with: location, company, title, hours, subcontract, extra_work.

    work_area format: "Location - Company - Activity Title"
    Splits by ' - ' to extract each piece.
    Hours = work duration (shift length from manpower mode), NOT total man-hours.
    """
    report = get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    activities = report.get("activities", [])
    rows = []

    company_aliases = {"OHLA": "OHL NA", "ohla": "OHL NA", "Ohla": "OHL NA"}

    for act in activities:
        work_area = act.get("work_area", "")
        parts = [p.strip() for p in work_area.split(" - ")]

        location = parts[0] if len(parts) >= 1 else work_area
        company = parts[1] if len(parts) >= 2 else ""
        title = parts[2] if len(parts) >= 3 else ""

        # If only 2 parts, second might be the title (no company)
        # But user confirmed format is always Location - Company - Title
        # So we keep the 3-part split

        # Normalize company aliases
        company = company_aliases.get(company, company)

        # Hours = SUM of all manpower and equipment hours for this activity.
        # User requested: "ADD UP ALL HOURS FROM EACH DIFFERENT ACTIVITY, MANPOWER AND EQUIPMENT"
        resource_tables = [
            act.get("manpower", []),
            act.get("equipment", []),
            act.get("extra_work_manpower", []),
            act.get("extra_work_equipment", []),
            act.get("consultant_manpower", []),
            act.get("consultant_equipment", []),
        ]
        
        summed_hours = 0.0
        has_resources = False

        for table in resource_tables:
            for item in table:
                has_resources = True
                try:
                    hrs = float(item.get("hours", 0) or 0)
                    qty = float(item.get("qty", 1) or 1)
                    if hrs > 0 and qty > 0:
                        summed_hours += (hrs * qty)
                except (ValueError, TypeError):
                    pass

        if has_resources and summed_hours > 0:
            total_hours = summed_hours
        elif has_resources and summed_hours == 0:
            total_hours = 0.0
        else:
            # Fallback: use report general start/end time if absolutely no resources exist
            general = report.get("general", {})
            start_str = general.get("start_time", "")
            end_str = general.get("end_time", "")
            total_hours = _calc_duration_hours(start_str, end_str)

        # Build resource_tables for subcontractor/extra work checks
        resource_tables = [
            act.get("manpower", []),
            act.get("equipment", []),
            act.get("extra_work_manpower", []),
            act.get("extra_work_equipment", []),
            act.get("consultant_manpower", []),
        ]

        # Check subcontractor: any resource with is_3rd_party=True
        has_subcontract = False
        for table in resource_tables:
            for item in table:
                if item.get("is_3rd_party"):
                    has_subcontract = True
                    break
            if has_subcontract:
                break

        # Check extra work: has any extra_work resources
        has_extra_work = (
            len(act.get("extra_work_manpower", [])) > 0
            or len(act.get("extra_work_equipment", [])) > 0
        )

        rows.append({
            "location": location,
            "company": company,
            "title": title,
            "hours": round(total_hours, 2),
            "subcontract": has_subcontract,
            "extra_work": has_extra_work,
        })

        logger.debug(
            f"Activity row: loc='{location}', co='{company}', "
            f"title='{title}', hrs={total_hours:.2f}, "
            f"sub={has_subcontract}, ew={has_extra_work}"
        )

    logger.info(f"Activities consolidated: {len(rows)} rows for report {report_id}")
    return rows

