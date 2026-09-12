"""
Daily Reporter V3 — Word Document Export Service

Generates the exact same report format as the legacy app: a header, the
general info, and the activities with their manpower and equipment.

Resource rows are listed exactly as they were entered — one line per person,
one line per machine. They are NOT merged. Eight labourers on a shift are
eight people with names, and two traffic control trucks are two trucks;
collapsing them into "QTY 8" discarded the names and read, to the person who
had just typed them, as the report losing their work.

Separate from the PMWeb Combined table (11 cols - for Chrome extension
injection), which carries Start/Finish times for direct grid injection.
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


def add_hours_to_time(time_str: str, add_hours: float) -> str:
    """Helper to add hours to a 12-hour AM/PM time string."""
    from datetime import timedelta
    try:
        t = datetime.strptime(time_str.strip(), "%I:%M %p")
        t += timedelta(hours=add_hours)
        return t.strftime("%I:%M %p").lstrip("0")
    except Exception:
        return time_str



# ============================================
# HELPERS
# ============================================

def _num(value, default: float = 0.0) -> float:
    """
    Coerce a resource-row number to a float, tolerating null and junk.

    WHY THIS EXISTS: every call site used float(item.get("hours", 0)), and a
    dict default only applies when the key is ABSENT. Rows routinely carry
    `"hours": null` — the key is present, `.get` returns None, and float(None)
    raises TypeError. That crashed the whole Word export with a 500 for any
    report containing a single row with a blank hours field, which is most real
    reports.

    Also handles the string values the AI endpoints and the frontend can emit
    ("8", "8.5", "", "  ").
    """
    if value is None:
        return default
    if isinstance(value, bool):  # bool is an int subclass — never a quantity
        return default
    if isinstance(value, (int, float)):
        return float(value)
    try:
        text = str(value).strip()
        return float(text) if text else default
    except (TypeError, ValueError):
        return default


DEFAULT_FILENAME_PREFIX = "Morena Conveyance North"


def build_report_filename(report: dict, prefix: str = "", extension: str = ".docx") -> str:
    """
    Build the saved-report filename in the convention the project already uses:

        <project name> - Daily-TW-07-28-2026.docx

    matching the finished reports in `Daily Reports/`. The date is MM-DD-YYYY,
    zero-padded.

    The name comes from the REPORT'S OWN project name, so renaming the project
    renames the files and there is only one place to change it. `prefix`
    (settings: word_filename_prefix) is only a fallback for reports that have no
    project name set, and DEFAULT_FILENAME_PREFIX backs that up in turn.
    """
    gen = report.get("general") or {}
    raw_date = gen.get("report_date") or ""
    try:
        date_part = datetime.strptime(raw_date, "%Y-%m-%d").strftime("%m-%d-%Y")
    except (ValueError, TypeError):
        date_part = raw_date or "unknown-date"

    project = (gen.get("project_name") or "").strip()
    label = project or (prefix or "").strip() or DEFAULT_FILENAME_PREFIX

    name = f"{label} - Daily-TW-{date_part}{extension}"

    # Strip anything Windows/macOS reject in a filename, so a stray character in
    # the prefix cannot produce an unsaveable name.
    return re.sub(r'[<>:"/\\|?*]', "", name)


def _format_number(val) -> str:
    """Format number: integer if whole, else 1 decimal."""
    val = _num(val)
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

def _resource_line(item: dict, is_equip: bool) -> str:
    """One resource row, rendered exactly as it was entered.

    Shared by the Word report and the PMWeb Notes HTML so the two can never
    drift apart again — they were separate copies of the same merging logic,
    and both had to be found to fix either.

    Returns "" for a row with no quantity or no hours, which is how a
    half-filled row has always been skipped.
    """
    if is_equip:
        raw = (item.get("name") or item.get("description") or "").strip()
        worker = ""
    else:
        raw = (item.get("trade") or item.get("name") or "").strip()
        # Manpower carries the trade in `trade` and the person in `name`.
        # Equipment repeats itself across both, hence the guard.
        worker = (item.get("name") or "").strip()
        if worker.lower() == raw.lower():
            worker = ""

    qty = _num(item.get("qty"))
    hours = _num(item.get("hours"))
    company = (item.get("company") or "OHL NA").strip()

    if qty <= 0 or hours <= 0:
        return ""

    parts = [lookup_resource(raw)]
    if worker:
        parts.append(worker)
    parts.append(f"QTY {_format_number(qty)}")
    # "EA" only means something when the row covers more than one of them.
    parts.append(f"{_format_number(hours)} HRS" + (" EA" if qty > 1 else ""))
    parts.append(company)

    line = " - ".join(parts)
    if is_equip and item.get("is_rental"):
        line += " - RENTAL"
    return line


def generate_word_document(report: dict) -> io.BytesIO:
    """
    Generate a Word document from report data.

    Structure:
      DAILY FIELD REPORT header → General info → Notes → Activities detail

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
        summary_lines = _extract_summary_lines(act.get("summary") or act.get("summary_html", ""))
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

            # One line per row, exactly as entered — see the module docstring
            # for why these are not merged.
            for item in items:
                line = _resource_line(item, is_equip)
                if not line:
                    continue
                pr = doc.add_paragraph(line)
                pr.paragraph_format.left_indent = Inches(0.25)
                pr.paragraph_format.space_after = Pt(1)

        # Render resource sections
        _process_resource_list(act.get("manpower", []), is_equip=False, header="Manpower:")
        _process_resource_list(act.get("equipment", []), is_equip=True, header="Equipment:")
        _process_resource_list(act.get("extra_work_manpower", []), is_equip=False, header="Extra Work Manpower:")
        _process_resource_list(act.get("extra_work_equipment", []), is_equip=True, header="Extra Work Equipment:")
        _process_resource_list(act.get("consultant_manpower", []), is_equip=False, header="Consultants:")

    # Save to bytes
    doc_bytes = io.BytesIO()
    doc.save(doc_bytes)
    doc_bytes.seek(0)
    logger.info(f"Generated Word document ({len(doc_bytes.getvalue())} bytes)")
    return doc_bytes


def generate_notes_html(report: dict) -> str:
    """
    Generate the report content as HTML for PMWeb Notes.
    Same content as the Word report — NO tables.
    
    Returns an HTML string ready to paste into PMWeb's RadEditor iframe.
    """
    gen = report.get("general", {})

    # Format date MM-DD-YYYY
    report_date = gen.get("report_date", "")
    try:
        if report_date:
            dt = datetime.strptime(report_date, "%Y-%m-%d")
            report_date = dt.strftime("%m-%d-%Y")
    except ValueError:
        pass

    html_parts = []

    # ── TITLE ──
    html_parts.append(
        f'<p align="center"><b style="font-size:14pt;">DAILY FIELD REPORT - {report_date}</b></p>'
    )

    # ── GENERAL INFO BLOCK ──
    info_lines = []
    info_lines.append(f"<b>Project:</b> {gen.get('project_name', '')}")
    if gen.get("project_location"):
        info_lines.append(f"<b>Location:</b> {gen['project_location']}")
    if gen.get("inspector_name"):
        info_lines.append(f"<b>Prepared By:</b> {gen['inspector_name']}")
    info_lines.append(f"<b>Resident Engineer:</b> {gen.get('resident_engineer', '')}")

    # Weather line
    temp_parts = []
    if gen.get("temperature_high"):
        temp_parts.append(f"High: {gen['temperature_high']}°F")
    if gen.get("temperature_low"):
        temp_parts.append(f"Low: {gen['temperature_low']}°F")
    wind_str = f", Wind: {gen['wind_info']}" if gen.get("wind_info") else ""

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

    info_lines.append(f"<b>Weather:</b> {weather_line}")
    info_lines.append(f"<b>Hours:</b> {gen.get('start_time', '')} - {gen.get('end_time', '')}")

    html_parts.append("<p>" + "<br>".join(info_lines) + "</p>")

    # ── GENERAL NOTES ──
    notes = _extract_plain_text(gen.get("notes", ""))
    if notes:
        html_parts.append(
            '<p style="margin-top:8px;"><b style="color:#003264;">General Notes:</b></p>'
        )
        html_parts.append(f"<p>{notes}</p>")

    # ── ACTIVITIES DETAIL ──
    html_parts.append('<h3 style="color:#003264;">Activities Detail</h3>')

    activities = report.get("activities", [])
    for act in activities:
        # Activity title
        title_text = act.get("work_area", "General")
        if act.get("stations"):
            title_text += f" — {act['stations']}"

        html_parts.append(
            f'<p style="margin-top:8px;margin-bottom:2px;">'
            f'<b style="color:#003264;text-decoration:underline;">{title_text}</b></p>'
        )

        # Summary lines
        summary_lines = _extract_summary_lines(act.get("summary") or act.get("summary_html", ""))
        for line_text in summary_lines:
            if line_text.startswith(("•", "-", "*", "–")):
                html_parts.append(
                    f'<p style="margin:1px 0;padding-left:18px;">{line_text}</p>'
                )
            else:
                html_parts.append(f'<p style="margin:1px 0;">{line_text}</p>')

        # Time range
        start_t, stop_t = _get_activity_time_range(act.get("manpower", []))
        if start_t and stop_t:
            html_parts.append(
                f'<p style="margin:0 0 4px 0;"><i style="font-size:9pt;color:#505050;">'
                f'Hours: {start_t} - {stop_t}</i></p>'
            )

        # Resource list renderer (HTML version)
        def _render_resources(items: list, is_equip: bool, header: str):
            if not items:
                return
            html_parts.append(
                f'<p style="margin:4px 0 0 0;"><b style="font-size:9pt;">{header}</b></p>'
            )
            # One line per row, matching the Word report exactly.
            for item in items:
                line = _resource_line(item, is_equip)
                if not line:
                    continue
                html_parts.append(
                    f'<p style="margin:1px 0;padding-left:18px;">{line}</p>'
                )

        _render_resources(act.get("manpower", []), False, "Manpower:")
        _render_resources(act.get("equipment", []), True, "Equipment:")
        _render_resources(act.get("extra_work_manpower", []), False, "Extra Work Manpower:")
        _render_resources(act.get("extra_work_equipment", []), True, "Extra Work Equipment:")
        _render_resources(act.get("consultant_manpower", []), False, "Consultants:")

    return "\n".join(html_parts)


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
                qty = _num(item.get("qty"))
                hours = _num(item.get("hours"))

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
                    # Calculate the split time based on standard 8 hours + 0.5 lunch
                    split_time = add_hours_to_time(item_start, STANDARD_HOURS + 0.5)

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
                        "finish_time": split_time,
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
                        "start_time": split_time,
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



def generate_report_document(report: dict) -> io.BytesIO:
    """
    Build the right document for whichever project the report belongs to.

    Every caller should use this rather than a specific renderer. The format is
    a property of the project, not of the call site, so adding a third job
    means adding a profile and a renderer - not hunting down export routes.

    An unknown project falls through to the classic layout, so a report written
    before profiles existed prints exactly as it always did.
    """
    from app.services.report_profiles import profile_for_report

    project = (report.get("general") or {}).get("project_name") or ""
    profile = profile_for_report(report)

    if profile.renderer == "tecolote":
        from app.services.word_tecolote import generate_tecolote_document
        logger.info(f"[word] {project!r} (profile {profile.key}) -> narrative format")
        return generate_tecolote_document(report)

    return generate_word_document(report)


def build_report_preview(report: dict) -> dict:
    """
    Exactly what the document will contain, before Word formatting.

    Read by the on-screen preview so the inspector checks the real content
    rather than a second rendering of it. A preview built independently drifts
    from the document the first time either changes, and the drift stays
    invisible until someone compares a printed report against the screen it was
    approved on.
    """
    from app.services.report_profiles import get_profile

    gen = report.get("general") or {}
    profile = get_profile(gen.get("project_name") or "")

    if profile.renderer == "tecolote":
        from app.services.word_tecolote import build_tecolote_content
        return build_tecolote_content(report)

    # ── Classic per-activity layout ──
    header = [
        {"label": "Report Date", "value": gen.get("report_date", "")},
        {"label": "Project", "value": gen.get("project_name", "")},
        {"label": "Resident Engineer", "value": gen.get("resident_engineer", "")},
        {"label": "Inspector", "value": gen.get("inspector_name", "")},
        {"label": "Shift", "value": f"{gen.get('start_time', '')} to {gen.get('end_time', '')}".strip(" to")},
    ]

    sections = []
    if (gen.get("notes") or "").strip():
        sections.append({
            "number": 0, "title": "General Notes",
            "lines": [l.strip() for l in gen["notes"].split("\n") if l.strip()],
            "is_empty": False,
        })

    activities = report.get("activities") or []
    for i, act in enumerate(activities, 1):
        lines = []
        if act.get("stations"):
            lines.append(f"Stations: {act['stations']}")
        lines.extend(
            line.strip() for line in str(act.get("summary") or "").split("\n") if line.strip()
        )
        for label, key, field in (
            ("Manpower", "manpower", "trade"),
            ("Equipment", "equipment", "name"),
        ):
            rows = act.get(key) or []
            parts = []
            for row in rows:
                name = str(row.get(field) or "").strip()
                if not name:
                    continue
                qty = row.get("qty") or ""
                hours = row.get("hours") or ""
                bit = f"{qty} {name}".strip()
                if hours:
                    bit += f" @ {hours}h"
                parts.append(bit)
            if parts:
                lines.append(f"{label}: {', '.join(parts)}")

        sections.append({
            "number": i,
            "title": act.get("work_area") or f"Activity {i}",
            "lines": lines or ["Nothing recorded for this activity."],
            "is_empty": not lines,
        })

    if not activities:
        sections.append({
            "number": 1, "title": "Work Performed",
            "lines": ["No activities have been added to this report yet."],
            "is_empty": True,
        })

    return {"title": "Daily Inspection Report", "header": header, "sections": sections}
