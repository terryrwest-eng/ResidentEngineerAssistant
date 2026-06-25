"""
Daily Reporter V3 — Export Router

Endpoints:
  GET /api/export/{report_id}/word    → Download .docx
  GET /api/export/{report_id}/pmweb   → JSON rows for PMWeb Combined table

Chrome Extension endpoints live in reports.py:
  POST /api/extension/context         → Set active report ID
  GET  /api/extension/context         → Get active report ID
  GET  /api/reports/{report_id}/consolidated → Flat array for extension auto-fill
"""

import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.services.word import generate_word_document, aggregate_for_pmweb
from app.services.reports import get_report

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/{report_id}/word")
async def download_word_report(report_id: str):
    """
    Generate and stream a Word .docx for the given report.
    Returns Content-Disposition: attachment so the browser downloads it.
    """
    report = await get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    try:
        doc_bytes = generate_word_document(report)
    except Exception as exc:
        logger.exception(f"Word generation failed for report {report_id}")
        raise HTTPException(status_code=500, detail="Failed to generate Word document")

    # Build filename:  DailyReport_2026-05-06.docx
    report_date = report.get("general", {}).get("report_date", "unknown")
    filename = f"DailyReport_{report_date}.docx"

    return StreamingResponse(
        doc_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{report_id}/pmweb")
async def get_pmweb_combined(report_id: str):
    """
    Return the PMWeb Combined resource table rows (11 columns).
    Used by:
      - Frontend PMWeb Combined preview panel
      - (Chrome extension uses /api/reports/{id}/consolidated instead)
    """
    report = await get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    rows = aggregate_for_pmweb(report)
    return {"report_id": report_id, "rows": rows, "total": len(rows)}
