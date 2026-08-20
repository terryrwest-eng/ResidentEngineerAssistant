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
from datetime import datetime
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

from app.services.report_profiles import TECOLOTE_EQUIPMENT_GROUPS, get_profile

logger = logging.getLogger(__name__)



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

def _fmt_date(raw: str) -> str:
    try:
        return datetime.strptime(raw, '%Y-%m-%d').strftime('%m-%d-%Y') if raw else ''
    except ValueError:
        return raw


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


def _aggregate_crew(report: dict) -> list[tuple[str, int, str]]:
    """
    Roll every manpower row up to one line per trade.

    The report is entered as rows so hours, cross-day copying and timesheet
    reconciliation keep working; section 7 only ever shows totals, so the
    rollup happens here at print time rather than costing the entry side
    anything.
    """
    totals: dict[str, int] = {}
    notes: dict[str, str] = {}

    for activity in report.get('activities', []) or []:
        for row in activity.get('manpower', []) or []:
            trade = (row.get('trade') or '').strip()
            if not trade:
                continue
            totals[trade] = totals.get(trade, 0) + max(_as_int(row.get('qty')), 1)
            note = (row.get('classification') or '').strip()
            if note and trade not in notes:
                notes[trade] = note

    # Anything captured by the interview but never entered as a row.
    for row in _answers(report).get('crew_rows') or []:
        trade = (row.get('trade') or '').strip()
        if not trade or trade in totals:
            continue
        totals[trade] = _as_int(row.get('qty'))
        if row.get('note'):
            notes[trade] = str(row['note'])

    # Crew order follows the trade hierarchy the format uses — foreman, then
    # operators, then laborers — not the alphabet. Anything else keeps its own
    # order after those, alphabetically, rather than being dropped.
    rank = {'foreman': 0, 'operator': 1, 'laborer': 2, 'labourer': 2}

    def sort_key(trade: str):
        lowered = trade.lower()
        for word, position in rank.items():
            if word in lowered:
                return (position, lowered)
        return (len(rank), lowered)

    return [
        (_plural(t, totals[t]), totals[t], notes.get(t, ''))
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


def _group_equipment(report: dict) -> list[tuple[str, list[str]]]:
    """Equipment lines under the format's three headings."""
    totals: dict[str, int] = {}
    notes: dict[str, str] = {}

    for activity in report.get('activities', []) or []:
        for row in activity.get('equipment', []) or []:
            name = (row.get('name') or '').strip()
            if not name:
                continue
            totals[name] = totals.get(name, 0) + max(_as_int(row.get('qty')), 1)
            note = (row.get('description') or '').strip()
            if note and name not in notes:
                notes[name] = note

    for row in _answers(report).get('equipment_rows') or []:
        name = (row.get('name') or '').strip()
        if not name or name in totals:
            continue
        totals[name] = _as_int(row.get('qty'))
        if row.get('note'):
            notes[name] = str(row['note'])

    grouped: dict[str, list[str]] = {label: [] for label, _ in TECOLOTE_EQUIPMENT_GROUPS}
    # Entry order, NOT alphabetical. The inspector lists the yard the way they
    # walked it, and re-sorting it is the app overruling them for no reason.
    for name in totals:
        lowered = name.lower()
        placed = False
        for label, keywords in TECOLOTE_EQUIPMENT_GROUPS:
            if keywords and any(k in lowered for k in keywords):
                grouped[label].append(_equipment_line(name, totals[name], notes.get(name, '')))
                placed = True
                break
        if not placed:
            # Catch-all is the last group, so an unrecognised machine is listed
            # rather than silently dropped off the report.
            grouped[TECOLOTE_EQUIPMENT_GROUPS[-1][0]].append(
                _equipment_line(name, totals[name], notes.get(name, ''))
            )

    return [(label, lines) for label, lines in grouped.items() if lines]


def _equipment_line(name: str, qty: int, note: str) -> str:
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


def _section_body(report: dict, section) -> list[str]:
    """
    The lines printed under one section heading.

    Built from the interview answers for that section's questions, in the order
    the questions were asked, so the printed report follows the format rather
    than the order things happened to be entered.
    """
    # Written prose wins over the answers. Printing "Label: answer" for each
    # question is a question-and-answer display, not a report.
    written = _composed(report).get(section.id, '')
    if written:
        return [line.rstrip() for line in written.split('\n') if line.strip()]

    answers = _answers(report)
    lines: list[str] = []

    for question in section.questions:
        if question.kind == 'yesno':
            continue  # a gate, not content
        value = str(answers.get(question.id, '') or '').strip()
        if not value:
            continue

        parts = [part.strip() for part in value.split('\n') if part.strip()]
        label = getattr(question, 'print_label', '')
        if not label:
            # Narrative answers already read as sentences.
            lines.extend(parts)
            continue

        # A short answer is a bare value — "Sta 143+98.80" — and a column of
        # those under a heading tells the reader nothing about which station is
        # which. The label turns it into a statement.
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
        heading = doc.add_paragraph()
        heading.paragraph_format.space_before = Pt(10)
        heading.paragraph_format.space_after = Pt(4)
        run = heading.add_run(f"{section['number']}. {section['title']}")
        run.bold = True
        run.font.size = Pt(12)

        if section['is_empty']:
            # The heading plus a plain sentence: the topic was considered and
            # had nothing, which is not the same as nobody filling it in.
            for line in section['lines']:
                doc.add_paragraph(line)
            continue

        for line in section['lines']:
            p = doc.add_paragraph(style='List Bullet')
            p.paragraph_format.space_after = Pt(2)
            # An indented continuation line keeps its indent rather than
            # becoming a bullet of its own.
            if line.startswith('    '):
                p.style = doc.styles['Normal']
                p.paragraph_format.left_indent = Inches(0.5)
                p.add_run(line.strip())
            else:
                p.add_run(line)

    stream = io.BytesIO()
    doc.save(stream)
    stream.seek(0)
    logger.info(
        f"[tecolote] Built report for {(report.get('general') or {}).get('report_date', '')} "
        f"({len(content['sections'])} sections)"
    )
    return stream


def build_tecolote_content(report: dict) -> dict[str, Any]:
    """
    The report's content, before any Word formatting.

    Both the document and the on-screen preview read this, so what the
    inspector checks is what the owner receives. A preview built separately
    drifts from the document the first time either is edited, and the drift is
    invisible until someone compares a printed report against the screen it was
    approved on.
    """
    gen = report.get('general', {}) or {}
    profile = get_profile(gen.get('project_name', ''))
    answers = _answers(report)

    header = [
        ('Report Date', _fmt_date(gen.get('report_date', ''))),
        ('Resident Engineer (RE) Arrival Time',
         answers.get('shift_start') or answers.get('start_time') or gen.get('start_time', '')),
        ('Contractor', gen.get('contractor') or profile.contractor),
    ]
    weather = _weather_line(report)
    if weather:
        header.append(('Weather', weather))

    sections: list[dict[str, Any]] = []
    for section in profile.sections:
        if section.id == 'labor':
            lines = [
                f'{trade}: {qty}' + (f' ({note})' if note else '')
                for trade, qty, note in _aggregate_crew(report)
            ]
        elif section.id == 'equipment':
            lines = [f'{label}: {", ".join(items)}' for label, items in _group_equipment(report)]
        else:
            lines = _section_body(report, section)

        sections.append({
            'number': section.number,
            'title': section.title,
            'lines': lines or [section.empty_statement],
            # The preview marks these differently so a section that genuinely
            # had nothing is not mistaken for one the inspector forgot.
            'is_empty': not lines,
        })

    return {
        'title': profile.title,
        'header': [{'label': k, 'value': str(v or '')} for k, v in header],
        'sections': sections,
    }
