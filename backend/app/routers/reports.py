"""
Daily Reporter V3 — Reports Router

CRUD operations for daily field reports.
Every save writes to both SQLite and a JSON file.
"""

import uuid
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from app.models.report import ReportModel, ReportIndexModel
from app.services.database import (
    save_report,
    get_report,
    list_reports,
    delete_report,
    get_report_count,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["reports"])


@router.post("/reports", response_model=dict)
async def create_report(request: Request):
    """
    Create a new daily field report.
    Accepts raw JSON — no Pydantic validation.
    Generates a unique ID and saves to both SQLite and a JSON file.
    """
    report_dict = await request.json()

    if not report_dict.get("id"):
        report_dict["id"] = str(uuid.uuid4())

    now = datetime.utcnow().isoformat()
    report_dict["created_at"] = now
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

ACTIVE_CONTEXT: dict = {"report_id": None}


@router.post("/extension/context")
async def set_extension_context(data: dict):
    """
    Sets the active report ID for the Chrome extension.
    Called by the PMWebPreview panel when user clicks 'Auto-Fill PMWeb'.
    """
    report_id = data.get("report_id")
    if not report_id:
        raise HTTPException(status_code=400, detail="report_id required")

    ACTIVE_CONTEXT["report_id"] = report_id
    logger.info(f"Extension context set to report: {report_id}")
    return {"status": "success", "report_id": report_id}


@router.get("/extension/context")
async def get_extension_context():
    """
    Gets the active report ID for the Chrome extension.
    Extension popup calls this to know which report to fetch.
    """
    return ACTIVE_CONTEXT


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


@router.get("/reports/{report_id}/activities-consolidated")
async def get_activities_consolidated(report_id: str):
    """
    Returns PMWeb OnSite Activities rows for the Chrome extension.
    One row per activity with: location, company, title, hours, subcontract, extra_work.

    work_area format: "Location - Company - Activity Title"
    Splits by ' - ' to extract each piece.
    Hours = sum of all (qty × hours) across manpower + equipment tables.
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

        # Sum total hours across all resource tables
        # Formula: (qty × hours) - (qty × 0.5) per resource
        # The 0.5 is 30 minutes lunch deduction per person
        LUNCH_DEDUCTION_HOURS = 0.5
        total_hours = 0.0
        resource_tables = [
            act.get("manpower", []),
            act.get("equipment", []),
            act.get("extra_work_manpower", []),
            act.get("extra_work_equipment", []),
            act.get("consultant_manpower", []),
        ]
        for table in resource_tables:
            for item in table:
                try:
                    qty = float(item.get("qty", 0) or 0)
                    hrs = float(item.get("hours", 0) or 0)
                    if hrs > 4:
                        total_hours += (qty * hrs) - (qty * LUNCH_DEDUCTION_HOURS)
                    else:
                        total_hours += qty * hrs
                except (ValueError, TypeError):
                    logger.warning(f"Bad qty/hours in activity '{work_area}': {item}")

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

