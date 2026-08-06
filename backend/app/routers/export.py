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
from fastapi import Depends, APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from datetime import datetime
from app.services.word import (
    generate_word_document,
    aggregate_for_pmweb,
    generate_notes_html,
    build_report_filename,
)
from app.services.reports import get_report

logger = logging.getLogger(__name__)
from app.core.auth import require_user

# Every route below requires a signed-in user, declared once here rather than on
# each endpoint: a per-endpoint decorator is something you can forget to add,
# and forgetting it on a data route would expose one user's records to another.
# require_user also pins the request to that user's storage, which is what makes
# every path in this file resolve inside their own directory.
router = APIRouter(prefix="/api/export", tags=["export"], dependencies=[Depends(require_user)])


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

    # Filename follows the project's existing filing convention:
    #   Morena Conveyance North - Daily-TW-07-28-2026.docx
    # The backend owns this so the browser download, the desktop auto-save and
    # the batch export cannot drift apart.
    from app.routers.settings import _load as _load_settings

    try:
        prefix = (_load_settings() or {}).get("word_filename_prefix", "")
    except Exception:
        prefix = ""
    filename = build_report_filename(report, prefix)

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


@router.get("/{report_id}/notes-html")
async def get_notes_html(report_id: str):
    """
    Return the report content as HTML for PMWeb Notes tab.
    Same content as Word doc — minus ALL tables.
    Used by Chrome extension for Notes auto-fill.
    """
    report = await get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    try:
        html = generate_notes_html(report)
        return {"report_id": report_id, "html": html}
    except Exception as exc:
        logger.exception(f"Notes HTML generation failed for report {report_id}")
        raise HTTPException(status_code=500, detail="Failed to generate notes HTML")


@router.get("/{report_id}/pmweb-full")
async def get_pmweb_full(report_id: str):
    """
    Return ALL data the Chrome extension needs in ONE call.
    Replaces 3+ separate API calls with 1.
    """
    report = await get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    gen = report.get("general", {})

    # Compute average temperature
    temp_high = gen.get("temperature_high")
    temp_low = gen.get("temperature_low")
    temp_avg = None
    if temp_high is not None and temp_low is not None:
        try:
            temp_avg = round((float(temp_high) + float(temp_low)) / 2, 1)
        except (ValueError, TypeError):
            pass

    # Compute day of week and working day status
    report_date = gen.get("report_date", "")
    day_of_week = ""
    is_working_day = True
    if report_date:
        try:
            dt = datetime.strptime(report_date, "%Y-%m-%d")
            day_of_week = dt.strftime("%A")  # "Monday", "Tuesday", etc.
            is_working_day = dt.weekday() < 5  # Mon-Fri = working day
        except ValueError:
            pass

    # Map sky conditions to PMWeb display names
    sky_conditions_mapped = []
    sky_map = {
        "clear": "Clear", "sunny": "Sunny", "partly_cloudy": "Partly Cloudy",
        "cloudy": "Cloudy", "overcast": "Overcast", "fog": "Fog",
        "drizzle": "Drizzle", "rain": "Rain", "thunderstorm": "Thunderstorm",
        "snow": "Snow", "hail": "Hail", "windy": "Windy",
    }
    for s in gen.get("sky_conditions", []):
        if isinstance(s, dict):
            val = s.get("id", s.get("label", ""))
        elif isinstance(s, str):
            val = s
        else:
            continue
        mapped = sky_map.get(val, val.replace("_", " ").title())
        if mapped:
            sky_conditions_mapped.append(mapped)

    # Convert times to military format for PMWeb
    def to_military(time_str):
        """Convert '6:30 AM' → '630', '3:30 PM' → '1530'."""
        if not time_str:
            return ""
        import re as _re
        match = _re.match(r'(\d+):(\d+)\s*(AM|PM)', time_str, _re.IGNORECASE)
        if not match:
            return time_str
        hours = int(match.group(1))
        mins = match.group(2)
        period = match.group(3).upper()
        if period == 'PM' and hours != 12:
            hours += 12
        if period == 'AM' and hours == 12:
            hours = 0
        return f"{hours}{mins}"

    # Generate notes HTML
    try:
        notes_html = generate_notes_html(report)
    except Exception:
        logger.exception("Notes HTML generation failed, returning empty")
        notes_html = ""

    # Generate PMWeb Combined rows for L&E tab (reuse existing)
    resources = aggregate_for_pmweb(report)

    # ── Activities consolidated (inline — same logic as reports.py endpoint) ──
    # One row per activity: location, company, title, hours, subcontract, extra_work
    # This is for Phase 2: the OnSite Activities grid
    company_aliases = {"OHLA": "OHL NA", "ohla": "OHL NA", "Ohla": "OHL NA"}
    activities_rows = []
    for act in report.get("activities", []):
        work_area = act.get("work_area", "")
        parts = [p.strip() for p in work_area.split(" - ")]
        location = parts[0] if len(parts) >= 1 else work_area
        company = parts[1] if len(parts) >= 2 else ""
        title = parts[2] if len(parts) >= 3 else ""
        company = company_aliases.get(company, company)

        # Sum ALL hours (manpower + equipment) across all resource tables
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
        elif not has_resources:
            # Fallback: use report general start/end time
            start_str = gen.get("start_time", "")
            end_str = gen.get("end_time", "")
            try:
                from datetime import datetime as _dt
                _fmts = ["%I:%M %p", "%H:%M"]
                _s = _e = None
                for _f in _fmts:
                    if not _s:
                        try: _s = _dt.strptime(start_str.strip(), _f)
                        except: pass
                    if not _e:
                        try: _e = _dt.strptime(end_str.strip(), _f)
                        except: pass
                total_hours = ((_e - _s).total_seconds() / 3600) if _s and _e else 8.0
            except Exception:
                total_hours = 8.0
        else:
            total_hours = 0.0

        # Check subcontractor/extra work flags
        has_subcontract = any(
            item.get("is_3rd_party")
            for table in resource_tables
            for item in table
        )
        has_extra_work = (
            len(act.get("extra_work_manpower", [])) > 0
            or len(act.get("extra_work_equipment", [])) > 0
        )

        activities_rows.append({
            "location": location,
            "company": company,
            "title": title,
            "hours": round(total_hours, 2),
            "subcontract": has_subcontract,
            "extra_work": has_extra_work,
        })

    return {
        "general": {
            "report_date": gen.get("report_date", ""),
            "project_name": gen.get("project_name", ""),
            "project_location": gen.get("project_location", ""),
            "resident_engineer": gen.get("resident_engineer", ""),
            "start_time": gen.get("start_time", ""),
            "end_time": gen.get("end_time", ""),
            "start_time_military": to_military(gen.get("start_time", "")),
            "end_time_military": to_military(gen.get("end_time", "")),
            "temperature_high": temp_high,
            "temperature_low": temp_low,
            "temperature_avg": temp_avg,
            "sky_conditions": gen.get("sky_conditions", []),
            "sky_conditions_pmweb": ",".join(sky_conditions_mapped),
            "wind_info": gen.get("wind_info", ""),
            "day_of_week": day_of_week,
            "is_working_day": is_working_day,
        },
        "notes_html": notes_html,
        "resources": resources,
        "activities": activities_rows,
    }
