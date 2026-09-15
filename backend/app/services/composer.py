"""
Daily Reporter V4 — the composer

The day record knows everything about the shift and nothing about the report.
This turns one into the other: it reads the whole record and produces the
report dict the rest of the app already stores, exports to Word and feeds to
the PMWeb extension. Nothing new is invented downstream of here.

WHY THE WHOLE RECORD GOES TO THE MODEL AT ONCE: the point of the day record is
that something finally holds the entire day. A composer called once per
activity would throw that away and be back to rephrasing fragments, which is
the thing V3 does badly. One call sees every location, so it can write "the
same crew moved to Genesee after lunch" — a sentence no per-activity call can
reach.

WHAT THE MODEL IS AND IS NOT ALLOWED TO DO. It writes prose, and only prose.
Every number, time, station, quantity and name is placed by the code below from
settled slots, never by the model. A model that can write a station number can
write the wrong one, and on a signed document that is the whole ballgame. If a
fact is not in the record it does not appear in the report.

REFUSING TO COMPOSE IS A FEATURE. can_compose() is false while any required
slot is empty, any slot is suspect, or any conflict is unsettled. This raises
rather than writing around the hole, because a report with a confident sentence
covering an unknown is worse than no report.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from app.routers.interview import HOUSE_STYLE
from app.services.day_record import DayRecord
from app.services.summary_format import with_opening_times

logger = logging.getLogger(__name__)

# The repeating section that becomes the report's activities. Held here rather
# than hardcoded at each use so a profile that names it differently needs one
# change, not five.
ACTIVITY_SECTION = 'activity'


class NotReady(Exception):
    """Raised instead of composing around a hole. Carries what is blocking."""

    def __init__(self, blocking: list[dict[str, str]], conflicts: list[dict[str, str]]):
        self.blocking = blocking
        self.conflicts = conflicts
        super().__init__('The record is not complete enough to write from.')


# ── turning slot rows into report rows ────────────────────────────

def _num(value: Any, default: float = 0.0) -> float:
    """Whatever the extractor produced, as a number. Never raises."""
    if value is None or value == '':
        return default
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def _manpower_row(raw: dict[str, Any], start: str, stop: str, hours: float) -> dict[str, Any]:
    """
    One crew row, in the shape the report model and the PMWeb export expect.

    The trade and the person are kept in separate fields because the export
    needs the trade to resolve a PMWeb resource code and the printed report
    names the person. A row that merges them loses one or the other.
    """
    trade = str(raw.get('trade') or raw.get('role') or raw.get('name') or '').strip()
    person = str(raw.get('name') or raw.get('person') or '').strip()
    # Equipment-style rows repeat themselves across both fields; a person whose
    # name IS the trade is not a person.
    if person.lower() == trade.lower():
        person = ''
    return {
        'id': str(uuid.uuid4()),
        'trade': trade,
        'name': person,
        'qty': int(_num(raw.get('qty'), 1)) or 1,
        'hours': _num(raw.get('hours'), hours),
        'company': str(raw.get('company') or '').strip(),
        'classification': str(raw.get('classification') or '').strip(),
        'start_time': str(raw.get('start_time') or start).strip(),
        'stop_time': str(raw.get('stop_time') or stop).strip(),
        'is_extra_work': bool(raw.get('is_extra_work')),
        'is_consultant': bool(raw.get('is_consultant')),
        'is_3rd_party': bool(raw.get('is_3rd_party')),
        'locked': False,
    }


def _equipment_row(raw: dict[str, Any], start: str, stop: str, hours: float) -> dict[str, Any]:
    name = str(raw.get('name') or raw.get('description') or raw.get('item') or '').strip()
    return {
        'id': str(uuid.uuid4()),
        'name': name,
        'description': str(raw.get('description') or '').strip(),
        'qty': int(_num(raw.get('qty'), 1)) or 1,
        'hours': _num(raw.get('hours'), hours),
        'company': str(raw.get('company') or '').strip(),
        'start_time': str(raw.get('start_time') or start).strip(),
        'stop_time': str(raw.get('stop_time') or stop).strip(),
        'is_extra_work': bool(raw.get('is_extra_work')),
        'is_consultant': bool(raw.get('is_consultant')),
        'is_rental': bool(raw.get('is_rental')),
        'locked': False,
    }


# ── reading the record ────────────────────────────────────────────

def _value(record: DayRecord, section: str, question: str, instance: str = '') -> str:
    key = record._slot_key(section, question, instance)
    slot = record.slots.get(key)
    return (slot.value or '').strip() if slot and slot.known else ''


def _rows(record: DayRecord, section: str, question: str, instance: str = '') -> list[dict[str, Any]]:
    key = record._slot_key(section, question, instance)
    slot = record.slots.get(key)
    return list(slot.rows or []) if slot and slot.known else []


def _shift_hours(start: str, stop: str, lunch: bool) -> float:
    """
    Hours per person for a crew row that did not carry its own.

    Falls back to 8 when the times cannot be read, rather than 0 — a row with
    no hours is dropped by every export downstream, so a wrong-but-visible 8
    fails louder than a silently missing crew member.
    """
    from datetime import datetime

    def parse(text: str):
        for fmt in ('%I:%M %p', '%I:%M%p', '%H:%M', '%I %p'):
            try:
                return datetime.strptime(text.strip().upper().replace('.', ''), fmt)
            except (ValueError, AttributeError):
                continue
        return None

    a, b = parse(start), parse(stop)
    if not a or not b:
        return 8.0
    span = (b - a).total_seconds() / 3600
    if span < 0:
        span += 24  # night shift
    if lunch:
        span -= 0.5
    return round(span, 2) if span > 0 else 8.0


def _facts_for_prose(record: DayRecord) -> dict[str, Any]:
    """
    Everything settled, arranged the way a person would tell it.

    Grouped by location and labelled with the question that was asked, because
    a flat list of values is not something prose can be written from — "7:30 AM"
    means nothing without "what time did the crew start".
    """
    by_instance: dict[str, list[dict[str, str]]] = {}
    day_level: list[dict[str, str]] = []

    for slot in record.slots.values():
        if not slot.known:
            continue
        # A slot that is n/a is a fact — the topic came up and there was
        # nothing — but it is not something to write a sentence about.
        if slot.state == 'na':
            continue
        if not slot.value and not slot.rows:
            continue
        entry = {
            'asked': slot.prompt,
            'answer': slot.value,
            'rows': slot.rows,
        }
        if slot.instance:
            by_instance.setdefault(slot.instance, []).append(entry)
        else:
            day_level.append(entry)

    return {'day': day_level, 'locations': by_instance}


# ── the one model call ────────────────────────────────────────────

def _write_prose(client, model_name, record: DayRecord) -> dict[str, str]:
    """
    One narrative per location, written from the settled facts and nothing else.

    Returns {location label: prose}. A location the model omits gets no prose
    rather than invented prose — the caller falls back to what was actually
    said, which is worse writing and better evidence.
    """
    from app.routers.conversation import _call_json

    facts = _facts_for_prose(record)
    labels = record.instances.get(ACTIVITY_SECTION, [])

    prompt = f"""You are writing the work narrative for a Resident Engineer's daily
construction report. Everything below was said by the inspector who was there.

{HOUSE_STYLE}

WHAT YOU ARE WRITING
One paragraph per location listed under LOCATIONS. Describe what was done, in
the order it happened. This is the only prose in the report; the times,
stations, crew and equipment are placed by the system from the same facts, so
do NOT list them again as a roster. Refer to them only where it makes the
account read as an account — "the crew moved to Genesee after lunch" is worth
writing, "8 laborers, 4.25 hours" is not.

YOU SEE THE WHOLE DAY AT ONCE. That is deliberate. If one location follows from
another, say so. Do not write each paragraph as though the others do not exist.

HARD LIMITS
- Every fact must come from below. If it is not here, it does not go in.
- Never state a station, quantity, time, count or company that is not here.
- Do not grade the work, and do not repeat a contractor's claim as a finding.
- No paragraph about a location with nothing recorded. Leave it out entirely.

FACTS ABOUT THE DAY AS A WHOLE:
{json.dumps(facts['day'], indent=2)}

LOCATIONS, IN THE ORDER THEY WERE WORKED:
{json.dumps(labels, indent=2)}

FACTS BY LOCATION:
{json.dumps(facts['locations'], indent=2)}

RETURN JSON EXACTLY:
{{
  "locations": [
    {{"location": "<exactly one of the labels above>", "narrative": "<the paragraph>"}}
  ],
  "day_notes": "<anything that belongs to the day rather than one location, or empty>"
}}"""

    out = _call_json(client, model_name, prompt, 'composer.prose')
    written: dict[str, str] = {}
    for item in (out.get('locations') or []):
        label = str(item.get('location', '')).strip()
        text = str(item.get('narrative', '')).strip()
        if label in labels and text:
            written[label] = text
    written['__day_notes__'] = str(out.get('day_notes', '') or '').strip()
    return written


# ── the composer ──────────────────────────────────────────────────

def compose(record: DayRecord, client, model_name) -> dict[str, Any]:
    """
    The day record as a report, ready to save.

    Raises NotReady while anything required is missing, unclear or contested.
    """
    if not record.can_compose():
        raise NotReady(record.blocking(), record.conflicts)

    prose = _write_prose(client, model_name, record)
    labels = record.instances.get(ACTIVITY_SECTION, [])

    activities: list[dict[str, Any]] = []
    starts: list[str] = []
    stops: list[str] = []

    for label in labels:
        start = _value(record, ACTIVITY_SECTION, 'start_time', label)
        stop = _value(record, ACTIVITY_SECTION, 'stop_time', label)
        lunch = _value(record, ACTIVITY_SECTION, 'lunch_deducted', label).lower() in ('yes', 'true')
        hours = _shift_hours(start, stop, lunch)

        if start:
            starts.append(start)
        if stop:
            stops.append(stop)

        # The model's paragraph where there is one, otherwise the inspector's
        # own words. Never nothing, and never invented.
        narrative = prose.get(label) or _value(record, ACTIVITY_SECTION, 'summary', label)
        narrative = with_opening_times(start, stop, narrative)

        activities.append({
            'id': str(uuid.uuid4()),
            'work_area': label,
            'stations': _value(record, ACTIVITY_SECTION, 'stations', label),
            'summary': narrative,
            'manpower': [
                _manpower_row(r, start, stop, hours)
                for r in _rows(record, ACTIVITY_SECTION, 'crew', label)
            ],
            'equipment': [
                _equipment_row(r, start, stop, hours)
                for r in _rows(record, ACTIVITY_SECTION, 'equipment', label)
            ],
            'extra_work_manpower': [],
            'extra_work_equipment': [],
            'consultant_manpower': [],
            'consultant_equipment': [],
        })

    # Day-level prose that belongs to no single location — visitors, extra work
    # raised at the end of the shift, anything the inspector added after the
    # walk-through.
    notes = prose.get('__day_notes__', '')

    report = {
        'general': {
            'project_name': record.profile.project_name,
            'report_date': record.report_date,
            'start_time': min(starts) if starts else '',
            'end_time': max(stops) if stops else '',
            'notes': notes,
        },
        'activities': activities,
        'photos': [],
        'status': 'draft',
    }

    logger.info(
        '[composer] %s: %d activities, %d crew rows, %d equipment rows',
        record.report_date or '(no date)', len(activities),
        sum(len(a['manpower']) for a in activities),
        sum(len(a['equipment']) for a in activities),
    )
    return report
