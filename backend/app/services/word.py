"""
Daily Reporter V3 — Word Document Export Service

Generates the exact same report format as the legacy app.
Two pages:
  Page 1: Report detail (header, general info, activities with manpower/equipment)
  Page 2: Consolidated resource table (6 cols - for Word doc)

Separate from the PMWeb Combined table (11 cols - for Chrome extension injection).

WHY SEPARATE: The Word doc uses a 6-col summary for readability.
The PMWeb preview uses all 11 cols (including Start/Finish times) for direct grid injection.
"""

import io
import logging
import re
from datetime import datetime

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor

from app.services.pmweb_mappings import lookup_resource

logger = logging.getLogger(__name__)

# Standard hours threshold for OT split
STANDARD_HOURS = 8.0


# ============================================
# HELPERS
# ============================================

def _format_number(val) -> str:
    """Format number: integer if whole, else 1 decimal."""
    if val == 0:
        return "0"
    if isinstance(val, float) and val.is_integer():
        return str(int(val))
    return str(round(val, 1))


def _extract_plain_text(text: str) -> str:
    """Strip HTML tags from rich text fields (single-line output)."""
    if not text:
        return ""
    # Remove HTML tags
    t = re.sub(r"<[^>]+>", " ", text)
    # Normalize whitespace
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _extract_summary_lines(text: str) -> list[str]:
    """
    Convert HTML or plain-text summary into a list of individual lines.

    Handles:
    - HTML bullet lists:  <li>Item</li> → separate lines
    - HTML line breaks:   <br>, <br/>, </p>, </div> → line breaks
    - Plain newlines:     \n → line breaks
    - Bullet characters:  •, -, * at line start are preserved
    """
    if not text:
        return []

    t = text

    # Convert <li> tags to newlines before stripping tags
    t = re.sub(r"<li[^>]*>", "\n• ", t, flags=re.IGNORECASE)
    # Convert block-closing tags and <br> to newlines
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.IGNORECASE)
    t = re.sub(r"</(?:p|div|li|tr)>", "\n", t, flags=re.IGNORECASE)
    # Remove all remaining HTML tags
    t = re.sub(r"<[^>]+>", "", t)
    # Decode common HTML entities
    t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")

    # Split on newlines, trim each line, drop empties
    lines = [line.strip() for line in t.split("\n")]
    lines = [line for line in lines if line]

    return lines


def _add_cell_text(cell, text: str, bold: bool = False, align=None):
    """Write text into a table cell with standard formatting."""
    p = cell.paragraphs[0]
    run = p.add_run(str(text))
    run.bold = bold
    run.font.name = "Arial Narrow"
    run.font.size = Pt(10)
    if align:
        p.alignment = align


def _get_activity_time_range(manpower_list: list) -> tuple:
    """
    Derive the earliest start and latest stop time from the manpower list.
    Returns (start_str, stop_str) or (None, None) if no times found.
    """
    starts, stops = [], []
    for m in manpower_list:
        for key, bucket in [("start_time", starts), ("stop_time", stops)]:
            raw = m.get(key)
            if raw:
                for fmt in ("%H:%M", "%I:%M %p"):
                    try:
                        bucket.append(datetime.strptime(raw, fmt))
                        break
                    except ValueError:
                        pass

    if not starts or not stops:
        return None, None

    # Use %-I on Linux/Mac; fallback for Windows
    try:
        return min(starts).strftime("%-I:%M %p"), max(stops).strftime("%-I:%M %p")
    except ValueError:
        return min(starts).strftime("%I:%M %p").lstrip("0"), max(stops).strftime("%I:%M %p").lstrip("0")


# ============================================
# WORD DOCUMENT GENERATOR
# ============================================

def generate_word_document(report: dict) -> io.BytesIO:
    """
    Generate a Word document from report data.

    Structure:
      Page 1: DAILY FIELD REPORT header → General info → Notes → Activities detail
      Page 2: Consolidated Resources table (6 columns)

    Returns io.BytesIO ready to stream.
    """
    doc = Document()

    # --- Narrow margins (0.5" all sides) ---
    for section in doc.sections:
        section.top_margin = Inches(0.5)
        section.bottom_margin = Inches(0.5)
        section.left_margin = Inches(0.5)
        section.right_margin = Inches(0.5)

    # --- Default style ---
    style = doc.styles["Normal"]
    style.font.name = "Arial Narrow"
    style.font.size = Pt(10)

    # ────────────────────────────────────────
    # PAGE 1: HEADER
    # ────────────────────────────────────────
    gen = report.get("general", {})

    # Format date MM-DD-YYYY
    report_date = gen.get("report_date", "")
    try:
        if report_date:
            dt = datetime.strptime(report_date, "%Y-%m-%d")
            report_date = dt.strftime("%m-%d-%Y")
    except ValueError:
        pass  # Keep original

    head = doc.add_paragraph()
    head.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = head.add_run(f"DAILY FIELD REPORT - {report_date}")
    run.bold = True
    run.font.size = Pt(14)
    run.font.name = "Arial Narrow"

    # ────────────────────────────────────────
    # GENERAL INFO BLOCK
    # ────────────────────────────────────────
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(12)

    p.add_run(f"Project: {gen.get('project_name', '')}\n").bold = True

    if gen.get("project_location"):
        p.add_run(f"Location: {gen['project_location']}\n")

    if gen.get("inspector_name"):
        p.add_run(f"Prepared By: {gen['inspector_name']}\n")

    p.add_run(f"Resident Engineer: {gen.get('resident_engineer', '')}\n")

    # Weather line
    temp_parts = []
    if gen.get("temperature_high"):
        temp_parts.append(f"High: {gen['temperature_high']}°F")
    if gen.get("temperature_low"):
        temp_parts.append(f"Low: {gen['temperature_low']}°F")
    wind_str = f", Wind: {gen['wind_info']}" if gen.get("wind_info") else ""

    # Sky conditions — handle both list-of-dicts (V3) and list-of-strings (legacy)
    sky_raw = gen.get("sky_conditions", [])
    sky_labels = []
    for s in sky_raw:
        if isinstance(s, dict):
            sky_labels.append(s.get("label", ""))
        elif isinstance(s, str):
            sky_labels.append(s)
    sky_str = ", ".join(filter(None, sky_labels))

    weather_line = ", ".join(temp_parts) + wind_str
    if sky_str:
        weather_line = f"{weather_line}, {sky_str}" if weather_line else sky_str

    p.add_run(f"Weather: {weather_line}\n")
    p.add_run(f"Hours: {gen.get('start_time', '')} - {gen.get('end_time', '')}")

    # ────────────────────────────────────────
    # GENERAL NOTES
    # ────────────────────────────────────────
    notes = _extract_plain_text(gen.get("notes", ""))
    if notes:
        p_head = doc.add_paragraph()
        p_head.paragraph_format.space_before = Pt(8)
        p_head.paragraph_format.space_after = Pt(2)
        run_head = p_head.add_run("General Notes:")
        run_head.bold = True
        run_head.font.color.rgb = RGBColor(0, 50, 100)

        p_notes = doc.add_paragraph(notes)
        p_notes.paragraph_format.space_after = Pt(12)

    # ────────────────────────────────────────
    # ACTIVITIES DETAIL
    # ────────────────────────────────────────
    doc.add_heading("Activities Detail", level=2)

    activities = report.get("activities", [])
    for act in activities:
        # Activity title (blue bold)
        area_p = doc.add_paragraph()
        area_p.paragraph_format.space_before = Pt(8)
        area_p.paragraph_format.space_after = Pt(2)

        title_text = act.get("work_area", "General")
        if act.get("stations"):
            title_text += f" — {act['stations']}"

        title_run = area_p.add_run(title_text)
        title_run.bold = True
        title_run.underline = True
        title_run.font.color.rgb = RGBColor(0, 50, 100)

        # Summary — each line gets its own paragraph to preserve bullets
        summary_lines = _extract_summary_lines(act.get("summary", ""))
        for line_text in summary_lines:
            snippet = doc.add_paragraph(line_text)
            snippet.paragraph_format.space_after = Pt(1)
            snippet.paragraph_format.space_before = Pt(0)
            # Indent bullet lines slightly
            if line_text.startswith(("•", "-", "*", "–")):
                snippet.paragraph_format.left_indent = Inches(0.25)

        # Dynamic time range from manpower
        start_t, stop_t = _get_activity_time_range(act.get("manpower", []))
        if start_t and stop_t:
            p_time = doc.add_paragraph()
            p_time.paragraph_format.space_before = Pt(0)
            p_time.paragraph_format.space_after = Pt(4)
            run_time = p_time.add_run(f"Hours: {start_t} - {stop_t}")
            run_time.italic = True
            run_time.font.size = Pt(9)
            run_time.font.color.rgb = RGBColor(80, 80, 80)

        # Resource list renderer
        def _add_resource_header(text: str):
            ph = doc.add_paragraph()
            ph.paragraph_format.space_before = Pt(4)
            ph.paragraph_format.space_after = Pt(0)
            rh = ph.add_run(text)
            rh.bold = True
            rh.font.size = Pt(9)

        def _process_resource_list(items: list, is_equip: bool, header: str = None):
            if not items:
                return
            if header:
                _add_resource_header(header)

            # Consolidate: group by (resource, hours, company) and sum qty
            # Key: (resource, hours, company, is_rental)
            # Value: {qty, hours, company, is_rental}
            consolidated: dict[tuple, dict] = {}
            for item in items:
                # Determine resource name
                if is_equip:
                    raw = (item.get("name") or item.get("description") or "").strip()
                else:
                    raw = (item.get("trade") or item.get("name") or "").strip()

                qty = float(item.get("qty", 0))
                hours = float(item.get("hours", 0))
                company = (item.get("company") or "OHL NA").strip()

                if qty <= 0 or hours <= 0:
                    continue

                # Map to PMWeb code
                resource = lookup_resource(raw)
                is_rental = bool(is_equip and item.get("is_rental"))

                key = (resource, hours, company, is_rental)
                if key in consolidated:
                    consolidated[key]["qty"] += qty
                else:
                    consolidated[key] = {
                        "resource": resource,
                        "qty": qty,
                        "hours": hours,
                        "company": company,
                        "is_rental": is_rental,
                    }

            # Render consolidated rows
            for row in consolidated.values():
                line = (
                    f"{row['resource']} - QTY {_format_number(row['qty'])} - "
                    f"{_format_number(row['hours'])} HRS EA - {row['company']}"
                )
                if row["is_rental"]:
                    line += " - RENTAL"

                pr = doc.add_paragraph(line)
                pr.paragraph_format.left_indent = Inches(0.25)
                pr.paragraph_format.space_after = Pt(1)

        # Render resource sections
        _process_resource_list(act.get("manpower", []), is_equip=False, header="Manpower:")
        _process_resource_list(act.get("equipment", []), is_equip=True, header="Equipment:")
        _process_resource_list(act.get("extra_work_manpower", []), is_equip=False, header="Extra Work Manpower:")
        _process_resource_list(act.get("extra_work_equipment", []), is_equip=True, header="Extra Work Equipment:")
        _process_resource_list(act.get("consultant_manpower", []), is_equip=False, header="Consultants:")

    # ────────────────────────────────────────
    # PAGE 2: CONSOLIDATED TABLE (Word doc view)
    # ────────────────────────────────────────
    doc.add_page_break()
    doc.add_heading("Consolidated Resources", level=2)

    aggregated = _aggregate_for_word(report)

    if aggregated:
        table = doc.add_table(rows=1, cols=6)
        table.style = "Table Grid"

        headers = ["Resource", "Pay Type", "Class", "Qty", "Company", "Total Hours"]
        for i, h in enumerate(headers):
            _add_cell_text(table.rows[0].cells[i], h, bold=True)

        for row_data in aggregated:
            row = table.add_row().cells
            _add_cell_text(row[0], row_data["resource"])
            _add_cell_text(row[1], row_data["pay_type"])
            _add_cell_text(row[2], row_data["classification"])
            _add_cell_text(row[3], f"{row_data['qty']:g}", align=WD_ALIGN_PARAGRAPH.RIGHT)
            _add_cell_text(row[4], row_data["company"])
            _add_cell_text(row[5], f"{row_data['total_hours']:g}", align=WD_ALIGN_PARAGRAPH.RIGHT)

            # Bold Extra Work rows
            if str(row_data.get("pay_type", "")).startswith("EW"):
                for cell in row:
                    for para in cell.paragraphs:
                        for r in para.runs:
                            r.font.bold = True
    else:
        doc.add_paragraph("No resources found.")

    # Save to bytes
    doc_bytes = io.BytesIO()
    doc.save(doc_bytes)
    doc_bytes.seek(0)
    logger.info(f"Generated Word document ({len(doc_bytes.getvalue())} bytes)")
    return doc_bytes


# ============================================
# AGGREGATION (Word consolidated view - 6 cols)
# ============================================

def _aggregate_for_word(report: dict) -> list:
    """
    Flatten all resources across all activities for the Word consolidated table.
    Applies OT split (>8 hrs → Regular + Overtime rows).

    CONSOLIDATION RULES:
      - Deduplicate exact duplicate rows within each activity
      - Group ONLY within the same activity (different activities stay separate)
      - Group only if same resource, same hours per unit, same company, same work type
      - Sum quantities for matching rows
      - total_hours = consolidated_qty × hours_per_unit
    """
    all_rows: list[dict] = []
    prime = "OHL NA"
    company_aliases = {"OHLA": prime, "ohla": prime, "Ohla": prime}

    activities = report.get("activities", [])
    for act in activities:
        # Per-activity consolidation bucket
        # Key: (resource, pay_type, classification, company, hours_per_unit)
        # Value: consolidated row dict
        activity_consolidated: dict[tuple, dict] = {}

        def _add_to_bucket(resource: str, pay_type: str, classification: str,
                           company: str, qty: float, hours_per_unit: float):
            key = (resource, pay_type, classification, company, hours_per_unit)
            if key in activity_consolidated:
                activity_consolidated[key]["qty"] += qty
                activity_consolidated[key]["total_hours"] += qty * hours_per_unit
            else:
                activity_consolidated[key] = {
                    "resource": resource,
                    "pay_type": pay_type,
                    "classification": classification,
                    "qty": qty,
                    "total_hours": qty * hours_per_unit,
                    "company": company,
                }

        def _process(items: list, is_equip: bool, force_flags: dict = None):
            for item in items:
                if force_flags:
                    item = {**item, **force_flags}

                if is_equip:
                    raw = (item.get("name") or item.get("description") or "").strip()
                else:
                    raw = (item.get("trade") or item.get("name") or "").strip()

                resource = lookup_resource(raw)
                qty = float(item.get("qty", 0))
                hours = float(item.get("hours", 0))

                if qty <= 0 or hours <= 0:
                    continue

                raw_company = item.get("company", "") or ""
                company = company_aliases.get(raw_company, raw_company) or prime

                is_ew = item.get("is_extra_work", False)
                pay_type = "EW - Extra Work" if is_ew else "CS - Cost"

                # OT split for manpower only
                if not is_equip and hours > STANDARD_HOURS:
                    _add_to_bucket(resource, pay_type, "LR - Labor Regular Time",
                                   company, qty, STANDARD_HOURS)
                    _add_to_bucket(resource, pay_type, "LO - Labor Overtime",
                                   company, qty, hours - STANDARD_HOURS)
                else:
                    _add_to_bucket(resource, pay_type, "LR - Labor Regular Time",
                                   company, qty, hours)

        _process(act.get("manpower", []), is_equip=False)
        _process(act.get("equipment", []), is_equip=True)
        _process(act.get("extra_work_manpower", []), is_equip=False, force_flags={"is_extra_work": True})
        _process(act.get("extra_work_equipment", []), is_equip=True, force_flags={"is_extra_work": True})
        _process(act.get("consultant_manpower", []), is_equip=False, force_flags={"is_consultant": True})

        # Append this activity's consolidated rows to the final list
        logger.info(
            f'[word-consolidate] Activity "{act.get("work_area", "?")[:40]}": '
            f'input={len(act.get("manpower", []))}mp+{len(act.get("equipment", []))}eq → '
            f'consolidated={len(activity_consolidated)} rows'
        )
        for key, row in activity_consolidated.items():
            logger.info(
                f'[word-consolidate]   {row["resource"]} | {row["pay_type"]} | '
                f'qty={row["qty"]:g} | hrs={row["total_hours"]:g} | {row["company"]}'
            )
        all_rows.extend(activity_consolidated.values())

    logger.info(f'[word-consolidate] TOTAL: {len(all_rows)} consolidated rows')
    return all_rows


# ============================================
# PMWEB COMBINED AGGREGATION (11 cols for Chrome extension)
# ============================================

def aggregate_for_pmweb(report: dict) -> list:
    """
    Flatten all resources for the PMWeb Combined table.
    Returns 11-column rows matching PMWeb grid columns exactly:
    Resource, Pay Type, Classification, Specialist, Remarks,
    Subcontractor, Qty, Company, Hours (total), Start Time, Finish Time

    This is the data used by the Chrome extension to auto-fill PMWeb.
    """
    rows = []
    prime = "OHL NA"
    company_aliases = {"OHLA": prime, "ohla": prime, "Ohla": prime}

    general = report.get("general", {})
    default_start = general.get("start_time", "7:00 AM")
    default_stop = general.get("end_time", "3:30 PM")

    activities = report.get("activities", [])
    for act in activities:

        def _process(items: list, is_equip: bool, force_flags: dict = None):
            for item in items:
                if force_flags:
                    item = {**item, **force_flags}

                if is_equip:
                    raw = (item.get("name") or item.get("description") or "").strip()
                else:
                    raw = (item.get("trade") or item.get("name") or "").strip()

                resource = lookup_resource(raw)
                qty = float(item.get("qty", 0))
                hours = float(item.get("hours", 0))

                if qty <= 0 or hours <= 0:
                    continue

                is_ew = item.get("is_extra_work", False)
                is_consultant = item.get("is_consultant", False)
                is_3rd_party = item.get("is_3rd_party", False)

                pay_type = "EW - Extra Work" if is_ew else "CS - Cost"
                raw_company = item.get("company", "") or ""
                company = company_aliases.get(raw_company, raw_company)
                if not is_3rd_party and not company:
                    company = prime

                remarks = ""
                if is_equip and item.get("is_rental"):
                    remarks = "Rental"

                item_start = item.get("start_time") or default_start
                item_stop = item.get("stop_time") or default_stop

                # OT split for manpower
                if not is_equip and hours > STANDARD_HOURS:
                    rows.append({
                        "resource": resource,
                        "pay_type": pay_type,
                        "classification": "LR - Labor Regular Time",
                        "specialist": is_consultant,
                        "remarks": remarks,
                        "subcontractor": is_3rd_party,
                        "qty": qty,
                        "company": company,
                        "total_hours": qty * STANDARD_HOURS,
                        "start_time": item_start,
                        "finish_time": item_stop,
                    })
                    rows.append({
                        "resource": resource,
                        "pay_type": pay_type,
                        "classification": "LO - Labor Overtime",
                        "specialist": is_consultant,
                        "remarks": remarks,
                        "subcontractor": is_3rd_party,
                        "qty": qty,
                        "company": company,
                        "total_hours": qty * (hours - STANDARD_HOURS),
                        "start_time": item_start,
                        "finish_time": item_stop,
                    })
                else:
                    rows.append({
                        "resource": resource,
                        "pay_type": pay_type,
                        "classification": "LR - Labor Regular Time",
                        "specialist": is_consultant,
                        "remarks": remarks,
                        "subcontractor": is_3rd_party,
                        "qty": qty,
                        "company": company,
                        "total_hours": qty * hours,
                        "start_time": item_start,
                        "finish_time": item_stop,
                    })

        _process(act.get("manpower", []), is_equip=False)
        _process(act.get("equipment", []), is_equip=True)
        _process(act.get("extra_work_manpower", []), is_equip=False, force_flags={"is_extra_work": True})
        _process(act.get("extra_work_equipment", []), is_equip=True, force_flags={"is_extra_work": True})
        _process(act.get("consultant_manpower", []), is_equip=False, force_flags={"is_consultant": True})

    return rows

