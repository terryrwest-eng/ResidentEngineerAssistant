"""
Daily Reporter V3 — Tecolote Channel export

Prints the Construction Daily Progress Report: a header block, then eight
numbered narrative sections, then rolled-up labor and equipment.

Structurally different from the classic export, which is per-activity tables.
Here the activities feed the narrative and the crew rows are aggregated, so the
same underlying report data drives both formats and nothing about the entry
side has to change per project.

A section with nothing in it still prints, with the profile's plain statement
underneath. A heading followed by "No time and material work was performed this
shift." records that the topic was considered and had nothing, which is a
different fact from a section that was never filled in — and on a report that
can be read back months later, that difference matters.
"""

import io
import logging
import re
from datetime import datetime
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

from app.services.report_profiles import MORENA_PIPELINES_EQUIPMENT_GROUPS, profile_for_report

logger = logging.getLogger(__name__)

_GENERIC_WORK_AREAS = {
    '',
    'daily progress',
    'morena pipelines',
    'morena pipeline',
    'tecolote channel',
    'tecolote',
}



def _weather_line(report: dict) -> str:
    """
    The weather, from general info first and the captured summary second.

    General info is where every other view reads it and where the inspector can
    correct it, so a hand-edited temperature must win over the reading captured
    when the report was opened.
    """
    gen = report.get('general') or {}
    high = str(gen.get('temperature_high') or '').strip()
    low = str(gen.get('temperature_low') or '').strip()
    wind = str(gen.get('wind_info') or '').strip()
    sky = gen.get('sky_conditions') or []
    condition = ''
    if isinstance(sky, list) and sky:
        first = sky[0]
        condition = str((first or {}).get('label') or '').strip() if isinstance(first, dict) else str(first)

    bits = []
    if condition:
        bits.append(condition)
    if high and low:
        bits.append(f'{low}-{high}F')
    elif high:
        bits.append(f'{high}F')
    if wind:
        bits.append(wind)

    if bits:
        return ' - '.join(bits)
    return str((report.get('weather') or {}).get('summary') or '').strip()


def _display_name(raw: str) -> str:
    """
    A resource name as a person reads it.

    Trades and equipment are stored with their PMWeb resource code - "LL-04-
    Operators", "LE-109- Excavator" - because that is what the PMWeb sync needs
    to match against. The daily report is read by the owner, not by PMWeb, and a
    code in front of every line is noise to them.

    The code is stripped for printing only; the stored row keeps it, so the
    PMWeb export is unaffected.
    """
    return re.sub(r'^[A-Za-z]{1,3}-\d+\s*-\s*', '', str(raw or '').strip()).strip()

def _fmt_date(raw: str) -> str:
    try:
        return datetime.strptime(raw, '%Y-%m-%d').strftime('%m-%d-%Y') if raw else ''
    except ValueError:
        return raw



def _fmt_time(raw: str) -> str:
    """
    A clock time as the report writes them: 12-hour with AM/PM.

    The arrival time printed as "06:30" because it comes from the settings
    default, which is stored 24-hour. Every other time in this document is
    12-hour, and one that is not reads as a different kind of value.
    """
    text = re.sub(r'^(?:start|stop|end)\s*[-:]\s*', '', str(raw or '').strip(), flags=re.IGNORECASE).strip()
    if not text:
        return ''
    for fmt in ('%H:%M', '%I:%M %p', '%I:%M%p'):
        try:
            return datetime.strptime(text.upper(), fmt).strftime('%-I:%M %p')
        except (ValueError, TypeError):
            try:
                return datetime.strptime(text.upper(), fmt).strftime('%I:%M %p').lstrip('0')
            except (ValueError, TypeError):
                continue
    return text

def _as_int(value: Any) -> int:
    """Counts arrive as int, str or blank depending on where the row came from."""
    try:
        return int(float(str(value).strip() or 0))
    except (TypeError, ValueError):
        return 0


def _answers(report: dict) -> dict[str, Any]:
    """
    Interview answers, keyed by question id.

    Stored under the report rather than inside an activity: these answers
    describe the day, and several of them have no activity to belong to.
    """
    return (report.get('interview') or {}).get('answers') or {}


def _aggregate_crew_for_activity(activity: dict, fallback_rows: list[dict] | None = None) -> list[tuple[str, int, str]]:
    """
    Roll one activity's manpower rows up to one line per trade.
    """
    totals: dict[str, int] = {}
    notes: dict[str, str] = {}

    all_rows = (
        (activity.get('manpower') or [])
        + (activity.get('extra_work_manpower') or [])
        + (activity.get('consultant_manpower') or [])
    )
    for row in all_rows:
        trade = (row.get('trade') or row.get('name') or '').strip()
        if not trade:
            continue
        totals[trade] = totals.get(trade, 0) + max(_as_int(row.get('qty')), 1)
        note = (row.get('classification') or '').strip()
        if note and trade not in notes:
            notes[trade] = note

    for row in (fallback_rows or []):
        trade = (row.get('trade') or '').strip()
        if not trade or trade in totals:
            continue
        totals[trade] = _as_int(row.get('qty'))
        if row.get('note'):
            notes[trade] = str(row['note'])

    rank = {'foreman': 0, 'operator': 1, 'laborer': 2, 'labourer': 2}

    def sort_key(trade: str):
        lowered = trade.lower()
        for word, position in rank.items():
            if word in lowered:
                return (position, lowered)
        return (len(rank), lowered)

    return [
        (_plural(_display_name(t), totals[t]), totals[t], notes.get(t, ''))
        for t in sorted(totals, key=sort_key)
    ]


def _plural(trade: str, qty: int) -> str:
    """
    "Operators: 2", not "Operator: 2".

    Only the trailing word is pluralised, so "General Foreman" becomes "General
    Foremen" rather than "General Foremans". Irregulars that actually occur on a
    crew sheet are listed; anything else takes an s.
    """
    if qty <= 1:
        return trade
    irregular = {'foreman': 'foremen', 'journeyman': 'journeymen'}
    head, _, last = trade.rpartition(' ')
    lowered = last.lower()
    if lowered in irregular:
        # Preserve the original capitalisation of the word being replaced.
        plural = irregular[lowered].capitalize() if last[:1].isupper() else irregular[lowered]
    elif lowered.endswith('s'):
        return trade
    else:
        plural = last + 's'
    return f'{head} {plural}'.strip()


def _group_equipment_for_activity(activity: dict, fallback_rows: list[dict] | None = None) -> list[tuple[str, list[str]]]:
    """Equipment lines for one activity under the format's three headings."""
    totals: dict[str, int] = {}
    notes: dict[str, str] = {}

    all_rows = (
        (activity.get('equipment') or [])
        + (activity.get('extra_work_equipment') or [])
    )
    for row in all_rows:
        name = (row.get('name') or row.get('description') or '').strip()
        if not name:
            continue
        totals[name] = totals.get(name, 0) + max(_as_int(row.get('qty')), 1)
        note = (row.get('description') or '').strip()
        if note and name not in notes:
            notes[name] = note

    for row in (fallback_rows or []):
        name = (row.get('name') or '').strip()
        if not name or name in totals:
            continue
        totals[name] = _as_int(row.get('qty'))
        if row.get('note'):
            notes[name] = str(row['note'])

    grouped: dict[str, list[str]] = {label: [] for label, _ in MORENA_PIPELINES_EQUIPMENT_GROUPS}
    for name in totals:
        lowered = name.lower()
        placed = False
        for label, keywords in MORENA_PIPELINES_EQUIPMENT_GROUPS:
            if keywords and any(k in lowered for k in keywords):
                grouped[label].append(_equipment_line(name, totals[name], notes.get(name, '')))
                placed = True
                break
        if not placed:
            grouped[MORENA_PIPELINES_EQUIPMENT_GROUPS[-1][0]].append(
                _equipment_line(name, totals[name], notes.get(name, ''))
            )

    return [(label, lines) for label, lines in grouped.items() if lines]


def _equipment_line(name: str, qty: int, note: str) -> str:
    name = _display_name(name)
    # "2 Excavators (Excavator)" - the description field often just repeats the
    # name, and printing both reads as a mistake.
    stripped = note.strip().lower()
    if stripped in ('', name.lower(), name.rstrip('s').lower()):
        note = ''
    # "Concrete Boom Pump (Pump)" - the note is a word already in the name.
    elif stripped in {w.lower().rstrip('s') for w in name.split()}:
        note = ''
    # "4 Dump Trucks", not "4 Dump Truck". Same rule the crew section follows —
    # a count and a singular noun reads as a typo in a document that gets sent
    # to the owner.
    label = _plural(name, qty)
    text = f'{qty} {label}' if qty else label
    return f'{text} ({note})' if note else text


def _composed(report: dict) -> dict[str, str]:
    """
    The written sections, keyed by section id.

    Present once the interview has been composed. The report is these words -
    the raw answers are kept only so the wording can be rebuilt later.
    """
    sections = (report.get('interview') or {}).get('composed') or []
    return {
        str(s.get('id', '')): str(s.get('body', '') or '').strip()
        for s in sections if isinstance(s, dict)
    }



_METADATA_LABELS = {
    'start time',
    'end time',
    'starting stations',
    'ending stations',
    'day totals',
    'pipe installed today',
    'looking ahead',
    'dewatering',
    'joints of pipe laid',
    'welds made',
    'welds grouted',
    'concrete and mortar patching',
    'traffic control',
    'activity',
    'stations',
}


def _activity_summary_blocks(activity: dict) -> dict[int, list[str]]:
    """
    Parse one activity's summary into numbered sections (1..6).
    Lines without numbered headings go to section 1 (Work Summary).
    """
    blocks: dict[int, list[str]] = {}
    heading = re.compile(r"^\s*(\d+)\.\s+(\S.*)$")
    summary = str(activity.get("summary") or "").strip()
    if not summary:
        return blocks

    current = 1
    for raw in summary.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        match = heading.match(line)
        if match:
            current = int(match.group(1))
            continue
        cleaned = line.strip().lstrip("\u2022").strip() or line.strip()
        blocks.setdefault(current, []).append(cleaned)

    return blocks


def _is_empty_statement(line: str, empty_statement: str) -> bool:
    a = line.strip().rstrip('.').lower()
    b = (empty_statement or '').strip().rstrip('.').lower()
    return bool(a and b and a == b)


def _derive_activity_title(activity: dict, idx: int, sec1_lines: list[str]) -> str:
    """
    Determine the heading title printed at the top of an activity block.

    Uses `activity['work_area']` when it holds a real name. When `work_area` is
    a generic placeholder ('Daily Progress' or empty), extracts the first
    work sub-topic label from Section 1 (e.g. 'Potholing Operations',
    'Inside-Pipe Grouting', 'Trench Excavation') or falls back to 'Activity N'.
    Appends stationing if present on the activity and not already in the title.
    """
    work_area = str(activity.get('work_area') or '').strip()
    stations = str(activity.get('stations') or '').strip()

    title = ''
    if work_area and work_area.lower() not in _GENERIC_WORK_AREAS:
        title = work_area
    else:
        for line in sec1_lines:
            label, sep, _ = line.partition(': ')
            if (
                sep
                and len(label) < 45
                and label[:1].isupper()
                and '.' not in label
                and label.strip().lower() not in _METADATA_LABELS
            ):
                title = label.strip()
                break
        if not title:
            title = f'Activity {idx}'

    if stations and stations.lower() not in title.lower():
        title = f'{title} — {stations}'

    return title


def _section_body_for_activity(
    activity: dict,
    activity_blocks: dict[int, list[str]],
    section,
    *,
    use_interview_fallback: bool,
    report: dict,
) -> list[str]:
    """
    The lines printed under one section heading for a single activity.
    """
    from_summary = [
        line for line in activity_blocks.get(section.number, [])
        if line.strip() and not _is_empty_statement(line, section.empty_statement)
    ]
    if from_summary:
        return from_summary

    if not use_interview_fallback:
        return []

    written = _composed(report).get(section.id, '')
    written_lines = [
        line.rstrip() for line in written.split('\n')
        if line.strip() and not _is_empty_statement(line, section.empty_statement)
    ]
    if written_lines:
        return written_lines

    answers = _answers(report)
    lines: list[str] = []

    for question in section.questions:
        if question.kind == 'yesno':
            continue
        value = str(answers.get(question.id, '') or '').strip()
        if not value:
            continue

        parts = [part.strip() for part in value.split('\n') if part.strip()]
        label = getattr(question, 'print_label', '')
        if not label:
            lines.extend(parts)
            continue

        if len(parts) == 1:
            lines.append(f'{label}: {parts[0]}')
        else:
            lines.append(f'{label}:')
            lines.extend(f'    {part}' for part in parts)

    return lines


def generate_tecolote_document(report: dict) -> io.BytesIO:
    """
    Build the Construction Daily Progress Report. Returns a stream to send.

    Content comes from build_tecolote_content, the same function the on-screen
    preview reads. This function only decides how it LOOKS. Keeping two copies
    of the content logic is how a header field ends up on one and not the other,
    which is exactly what happened to the weather line.
    """
    content = build_tecolote_content(report)

    doc = Document()
    for s in doc.sections:
        s.top_margin = Inches(0.7)
        s.bottom_margin = Inches(0.7)
        s.left_margin = Inches(0.8)
        s.right_margin = Inches(0.8)

    style = doc.styles['Normal']
    style.font.name = 'Calibri'
    style.font.size = Pt(11)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run(content['title'])
    run.bold = True
    run.font.size = Pt(16)

    for field in content['header']:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(2)
        p.add_run(f"{field['label']}: ").bold = True
        p.add_run(field['value'])

    doc.add_paragraph()

    for section in content['sections']:
        if section.get('is_activity_header'):
            act_heading = doc.add_paragraph()
            act_heading.paragraph_format.space_before = Pt(18)
            act_heading.paragraph_format.space_after = Pt(6)
            run = act_heading.add_run(section['title'])
            run.bold = True
            run.underline = True
            run.font.size = Pt(14)
            continue

        # A gap before each numbered heading, and a real gap between sub-topics.
        heading = doc.add_paragraph()
        heading.paragraph_format.space_before = Pt(14)
        heading.paragraph_format.space_after = Pt(6)
        heading_text = (
            f"{section['number']}. {section['title']}"
            if section.get('number')
            else section['title']
        )
        run = heading.add_run(heading_text)
        run.bold = True
        run.font.size = Pt(12)

        if section['is_empty']:
            # The heading plus a plain sentence: the topic was considered and
            # had nothing, which is not the same as nobody filling it in.
            for line in section['lines']:
                empty = doc.add_paragraph(line)
                empty.paragraph_format.space_after = Pt(8)
                empty.paragraph_format.line_spacing = 1.12
            continue

        for line in section['lines']:
            # PROSE, not bullets. The format this report follows is written
            # paragraphs led by a bold sub-topic label - "Trench Excavation:
            # ..." - and bulleting every line turned the whole document into a
            # list, which is not what the owner is expecting to read.
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(8)
            p.paragraph_format.line_spacing = 1.12
            # A list of numbered items - pipe joints, welds, crew counts - is
            # indented under the paragraph that introduced it.
            if line.startswith('    '):
                p.paragraph_format.left_indent = Inches(0.35)
                p.paragraph_format.space_after = Pt(2)
                p.add_run(line.strip())
                continue
            label, sep, rest = line.partition(': ')
            if sep and len(label) < 45 and label[:1].isupper() and '.' not in label:
                p.add_run(f'{label}: ').bold = True
                p.add_run(rest)
            else:
                p.add_run(line)

    stream = io.BytesIO()
    doc.save(stream)
    stream.seek(0)
    logger.info(
        f"[morena_pipelines] Built report for {(report.get('general') or {}).get('report_date', '')} "
        f"({len(content['sections'])} blocks, {len(report.get('activities') or [])} activities)"
    )
    return stream


def build_tecolote_content(report: dict) -> dict[str, Any]:
    """
    The report's content, before any Word formatting.

    Structure:
      - Day-level header at the top (Report Date, RE Arrival Time, Contractor, Weather).
      - Then each activity in `report.activities` rendered as its own separate
        block starting with the Activity Title at the top of that activity,
        followed by that activity's sections 1..8 (Work Summary through
        Labor Force Tracking and Equipment Log).
    """
    gen = report.get('general', {}) or {}
    profile = profile_for_report(report)
    answers = _answers(report)

    header = [
        ('Report Date', _fmt_date(gen.get('report_date', ''))),
        ('Resident Engineer (RE) Arrival Time',
         _fmt_time(answers.get('shift_start') or answers.get('start_time')
                   or gen.get('start_time', ''))),
        ('Contractor', gen.get('contractor') or profile.contractor),
    ]
    weather = _weather_line(report)
    if weather:
        header.append(('Weather', weather))

    raw_activities = [
        a for a in (report.get('activities') or [])
        if (
            str(a.get('summary') or '').strip()
            or (a.get('manpower') or [])
            or (a.get('equipment') or [])
            or (a.get('extra_work_manpower') or [])
            or (a.get('extra_work_equipment') or [])
            or (a.get('consultant_manpower') or [])
        )
    ]
    # If no activities exist on the report yet (e.g. only interview answers),
    # synthesize one activity shell so the interview answers still render.
    if not raw_activities:
        raw_activities = [{'work_area': answers.get('work_area', ''), 'summary': ''}]

    numbered_sections = [s for s in profile.sections if s.number > 0]
    first_section = numbered_sections[0] if numbered_sections else None

    sections: list[dict[str, Any]] = []
    notes_lines = [
        line.strip()
        for line in str(gen.get('notes') or '').split('\n')
        if line.strip()
    ]
    if notes_lines:
        sections.append({
            'number': 0,
            'title': 'General Notes',
            'lines': notes_lines,
            'is_empty': False,
        })

    for idx, activity in enumerate(raw_activities, 1):
        activity_blocks = _activity_summary_blocks(activity)
        use_interview_fallback = (
            idx == 1 and not activity_blocks
        )
        sec1_lines = (
            _section_body_for_activity(
                activity, activity_blocks, first_section,
                use_interview_fallback=use_interview_fallback, report=report,
            )
            if first_section else []
        )
        act_title = _derive_activity_title(activity, idx, sec1_lines)

        # Activity title header at the top of this activity
        sections.append({
            'number': 0,
            'title': act_title,
            'lines': [],
            'is_empty': False,
            'is_activity_header': True,
        })

        fallback_crew = (_answers(report).get('crew_rows') or []) if idx == 1 else []
        fallback_equip = (_answers(report).get('equipment_rows') or []) if idx == 1 else []

        for section in numbered_sections:
            if section.id == 'labor':
                lines = [
                    f'{trade}: {qty}' + (f' ({note})' if note else '')
                    for trade, qty, note in _aggregate_crew_for_activity(activity, fallback_crew)
                ]
            elif section.id == 'equipment':
                lines = [
                    f'{label}: {", ".join(items)}'
                    for label, items in _group_equipment_for_activity(activity, fallback_equip)
                ]
            else:
                lines = _section_body_for_activity(
                    activity, activity_blocks, section,
                    use_interview_fallback=use_interview_fallback, report=report,
                )

            sections.append({
                'number': section.number,
                'title': section.title,
                'lines': lines or [section.empty_statement],
                'is_empty': not lines,
            })

    return {
        'title': profile.title,
        'header': [{'label': k, 'value': str(v or '')} for k, v in header],
        'sections': sections,
    }
