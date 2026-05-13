"""
Daily Reporter V3 — Reports Router

CRUD operations for daily field reports.
Every save writes to both SQLite and a JSON file.
"""

import uuid
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

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
async def create_report(report: ReportModel):
    """
    Create a new daily field report.
    Generates a unique ID and saves to both SQLite and a JSON file.
    """
    if not report.id:
        report.id = str(uuid.uuid4())

    now = datetime.utcnow().isoformat()
    report_dict = report.model_dump()
    report_dict["created_at"] = now
    report_dict["updated_at"] = now

    file_path = save_report(report_dict)
    logger.info(f"Created report {report.id} → {file_path}")

    return {"id": report.id, "file_path": file_path, "message": "Report created"}


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
async def update_report(report_id: str, report: ReportModel):
    """
    Update an existing report.
    Overwrites both the SQLite index and the JSON file.
    """
    # Verify report exists
    existing = get_report(report_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Report not found")

    report_dict = report.model_dump()
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
