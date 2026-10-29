"""
Daily Reporter V3 — Guided interview

The report format asks the questions instead of the inspector remembering what
it wants. Each question is answered by talking, and each recording is parsed on
its own.

WHY ONE QUESTION AT A TIME: the existing bulk dictation asks the model to hear a
whole day and split it into activities, locations, crews and equipment in a
single pass. That works, but every additional job it is doing at once is another
chance to drop a station or merge two segments. Here the model is told exactly
what it is listening for — "this recording answers: which pipe segments were
installed" — and returns one field. A narrow question is a reliable question.

Nothing here invents. If the answer to a question is not in the recording, the
field comes back empty and the interview says so, because a confidently filled
gap is worse than a visible one in a document that can end up as evidence.
"""

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.config import GEMINI_THINKING_LEVEL
from app.routers.ai import (
    _clean_json,
    _decode_audio,
    _finish_reason_problem,
    _gemini_call_with_retry,
    _get_gemini_client,
    _other_day_context,
    _transcribe_audio,
)
from app.routers.ai import _strip_reasoning
from app.services.report_profiles import get_profile, list_profiles
from app.services.summary_format import normalise_time_lines, with_opening_times

logger = logging.getLogger(__name__)
router = APIRouter(prefix='/api/interview', tags=['interview'])


# The house writing rules, in the one place the interview can reach them. These
# match the rules enforced by the proofreader; text produced here should never
# be something Check would immediately flag.
HOUSE_STYLE = """HOW TO WRITE THE ANSWER:
- Plain English. Write the way a field inspector talks, not the way a model
  writes. Short, flat, factual.
- Past tense, third person. Never "we", "I" or "our" - name the party.
- No AI tone: no "delve", "it is worth noting", "seamless", "robust",
  "leverage", "furthermore", "moreover", and never open with "additionally"
  or "overall".
- No corporate words: used not utilized, started not commenced, before not
  prior to, to not in order to.
- No filler adjectives: existing, current, designated, respective, various.
- Do NOT grade the work. Never "good", "properly", "successful", "productive".
  Stating that work conformed to a named plan, spec or submittal is NOT a
  grade - it is the inspection finding, and it is expected.
- Stations are written "Sta XX+XX", keeping every decimal exactly as spoken.
- Times are 12-hour with AM/PM. Never 24-hour.
- Never expand an acronym the reader knows. BMP, not Best Management Practice.

WHAT YOU MUST NOT DO:
- Do not invent a station, a quantity, a time, a name or a count. If the
  speaker did not say it, leave it out and note it in "missing".
- Do not repeat a contractor's claim as a finding. If the recording says work
  was extra, or that a delay was someone's fault, report the underlying fact
  (a crew stood by, a conflict was hit) and drop the argument.
"""


class AnswerRequest(BaseModel):
    """One recording answering one question."""
    profile: str = ''
    section_id: str = ''
    question_id: str = ''
    audio_data: str = ''
    mime_type: str = 'audio/webm'
    duration_seconds: float = 0
    # Typed instead of spoken. Still cleaned to house style so both routes
    # produce the same voice.
    text: str = ''
    report_date: str = ''


class AnswerResponse(BaseModel):
    question_id: str = ''
    # What the model heard, shown to the inspector so a bad recording is
    # visible as wrong text rather than silently becoming wrong report content.
    transcript: str = ''
    # The cleaned answer, ready to drop into the section.
    value: str = ''
    # Structured payload for kinds that have one (segments, crew, equipment).
    rows: list[dict[str, Any]] = []
    # Anything the question wanted that the recording did not contain.
    missing: list[str] = []
    status: str = 'ok'   # ok | empty | suspect | failed
    reason: str = ''


@router.get('/profiles')
async def get_profiles(_user=Depends(require_user)):
    """Every project's format, for the picker that opens a new report."""
    return {'profiles': list_profiles()}


@router.get('/profile/{key}')
async def get_profile_detail(key: str, _user=Depends(require_user)):
    """One profile in full — sections, questions, prompts, empty statements."""
    return get_profile(key).to_dict()


def _find_question(profile_key: str, question_id: str):
    profile = get_profile(profile_key)
    for section in profile.sections:
        for question in section.questions:
            if question.id == question_id:
                return profile, section, question
    return profile, None, None


def _schema_for(kind: str) -> str:
    """What JSON this kind of question returns."""
    if kind == 'segments':
        return (
            '{"rows": [{"mark": "MK-119", "from": "Sta 143+98.31", '
            '"to": "Sta 143+59.06"}], "value": "", "missing": []}'
        )
    if kind == 'crew':
        return (
            '{"rows": [{"trade": "Operator", "qty": 2, "hours": 10, "note": ""}], '
            '"value": "", "missing": []}'
        )
    if kind == 'equipment':
        return (
            '{"rows": [{"name": "CAT 335 Excavator", "qty": 2, "hours": 10, "note": "active"}], '
            '"value": "", "missing": []}'
        )
    if kind == 'list':
        return (
            '{"rows": [{"item": "Main St and 2nd Ave"}, {"item": "Sta 10+50"}], '
            '"value": "", "missing": []}'
        )
    if kind == 'time':
        return '{"value": "7:30 AM", "rows": [], "missing": []}'
    if kind == 'station_range':
        return (
            '{"value": "Sta 143+98.80 to Sta 142+39.77", "rows": [], "missing": []}'
        )
    if kind == 'yesno':
        return '{"value": "yes", "rows": [], "missing": []}'
    # text and narrative
    return '{"value": "the answer, in the inspector\'s voice", "rows": [], "missing": []}'


def _value_from_rows(kind: str, rows: list[dict[str, Any]]) -> str:
    """
    A readable line for rows the model returned without prose.

    WHY THIS MATTERS: a structured answer used to come back with rows filled in
    and "value" empty, so the box on screen went blank the moment the question
    was answered and the progress counter still read zero. The answer was
    captured correctly and looked completely lost, which is indistinguishable
    from a broken app.
    """
    if not rows:
        return ''

    def qty(row):
        n = row.get('qty')
        try:
            n = int(float(str(n)))
        except (TypeError, ValueError):
            n = 0
        return n

    if kind == 'list':
        return '\n'.join(
            str(r.get('item') or r.get('name') or '').strip()
            for r in rows if (r.get('item') or r.get('name'))
        )

    if kind == 'segments':
        out = []
        for r in rows:
            mark = str(r.get('mark', '') or '').strip()
            frm = str(r.get('from', '') or '').strip()
            to = str(r.get('to', '') or '').strip()
            if mark and frm and to:
                out.append(f'{mark}: {frm} to {to}')
            elif mark:
                out.append(mark)
        return '\n'.join(out)

    if kind == 'crew':
        out = []
        for r in rows:
            trade = str(r.get('trade', '') or '').strip()
            if not trade:
                continue
            n = qty(r)
            note = str(r.get('note', '') or '').strip()
            line = f'{n} {trade}' if n else trade
            hours = str(r.get('hours') or '').strip()
            if hours and hours not in ('0', '0.0'):
                line += f' @ {hours}h'
            if r.get('name'):
                line += f" ({r['name']})"
            elif note:
                line += f' ({note})'
            out.append(line)
        return ', '.join(out)

    if kind == 'equipment':
        out = []
        for r in rows:
            name = str(r.get('name', '') or '').strip()
            if not name:
                continue
            n = qty(r)
            note = str(r.get('note', '') or '').strip()
            line = f'{n} {name}' if n else name
            if note:
                line += f' ({note})'
            out.append(line)
        return ', '.join(out)

    return ''


@router.post('/answer', response_model=AnswerResponse)
async def answer_question(request: AnswerRequest, _user=Depends(require_user)):
    """
    Turn one spoken answer into one filled field.

    Transcription and extraction are separate calls on purpose. Asking a model
    to hear audio AND satisfy a JSON schema in one step is what makes it fill
    the schema with plausible invention when the audio is unclear - so pass one
    reads, and pass two works only from text it can actually see.
    """
    profile, section, question = _find_question(request.profile, request.question_id)
    if question is None:
        raise HTTPException(
            status_code=400,
            detail=f'No question {request.question_id!r} in the {profile.key} format.',
        )

    client, model_name = _get_gemini_client()
    transcript = (request.text or '').strip()

    # ── Pass 1: hear it ──
    if not transcript:
        if not request.audio_data:
            return AnswerResponse(
                question_id=question.id, status='empty',
                reason='Nothing was recorded or typed.',
            )
        heard = _transcribe_audio(
            client, model_name,
            _decode_audio(request.audio_data), request.mime_type,
            duration_seconds=float(request.duration_seconds or 0),
            extra_instructions=(
                'This recording answers ONE question from a daily construction '
                'report. Transcribe exactly what is said, including every station '
                'number, quantity and time.\n\nTHE QUESTION WAS: ' + question.prompt
            ),
        )
        transcript = heard.transcription
        if heard.status in ('failed', 'suspect'):
            # Never build a field out of audio we could not read.
            return AnswerResponse(
                question_id=question.id,
                transcript=transcript,
                status=heard.status,
                reason=heard.reason or 'The recording could not be read clearly.',
            )

    if not transcript.strip():
        return AnswerResponse(
            question_id=question.id, status='empty',
            reason='Nothing was heard in that recording.',
        )

    # ── Pass 2: pull out the one field ──
    hint = question.extract_hint or 'Report exactly what was said, nothing more.'
    example = f'\nAN EXAMPLE OF A GOOD ANSWER: {question.example}\n' if question.example else ''

    prompt = (
        'You are filling in ONE field of a Resident Engineer\'s daily report.\n\n'
        f'THE REPORT SECTION: {section.number}. {section.title}\n'
        f'THE QUESTION ASKED: {question.prompt}\n'
        f'WHAT THIS FIELD NEEDS: {hint}\n'
        f'{example}\n'
        f'{HOUSE_STYLE}\n'
        'If the speaker answered something other than what was asked, put what '
        'they did say in "value" and note the mismatch in "missing". If they '
        'clearly said there was nothing to report, return "value": "none".\n\n'
        f'RETURN JSON EXACTLY IN THIS SHAPE:\n{_schema_for(question.kind)}\n\n'
        'THE RECORDING SAID:\n---\n' + transcript + '\n---\n'
        # A spoken "same crew as 8/14" resolves to that day's real rows.
        + _other_day_context(transcript, reference_date=request.report_date)
    )

    from google.genai import types as genai_types

    response = _gemini_call_with_retry(
        client, model_name,
        contents=[prompt],
        config=genai_types.GenerateContentConfig(
            temperature=0.0,
            thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
            response_mime_type='application/json',
            max_output_tokens=8192,
        ),
    )

    raw = (getattr(response, 'text', None) or '').strip()
    if not raw:
        problem = _finish_reason_problem(response)
        logger.warning(f'[interview] {question.id}: empty extraction ({problem})')
        return AnswerResponse(
            question_id=question.id, transcript=transcript, status='failed',
            reason=problem or 'The answer could not be read. The transcript is kept.',
        )

    data = _clean_json(raw)
    value = str(data.get('value', '') or '').strip()
    rows = [r for r in (data.get('rows') or []) if isinstance(r, dict)]
    missing = [str(m) for m in (data.get('missing') or []) if str(m).strip()]

    if value.lower() in ('none', 'nothing', 'n/a', 'na'):
        value = ''

    # Structured kinds routinely come back as rows with no prose. Render them so
    # the answer is visible on screen instead of leaving the box empty.
    if not value and rows:
        value = _value_from_rows(question.kind, rows)

    logger.info(
        f'[interview] {profile.key}/{question.id}: '
        f'{len(transcript)} chars heard, {len(rows)} row(s), {len(missing)} gap(s)'
    )

    return AnswerResponse(
        question_id=question.id,
        transcript=transcript,
        value=value,
        rows=rows,
        missing=missing,
        status='ok' if (value or rows) else 'empty',
        reason='' if (value or rows) else 'Nothing in that recording answered this question.',
    )


# ============================================
# Compose — answers in, a written report out
# ============================================

COMPOSE_PROMPT = """You are the Resident Engineer writing today's daily report.

You are given the answers to the questions the app asked during the shift. Your
job is to WRITE THE REPORT from them. This is composition, not transcription:
the answers are your notes, and the report is the document that goes to the
owner.

HOW EACH SECTION READS
Group what happened into labelled sub-topics and write each as prose. This is
the shape:

  Trench Excavation: Continued trench excavation and advanced the trench line
  from Sta 143+98.80 to Sta 142+39.77. Perched water was encountered from Sta
  143+98.31 to Sta 143+59.06.
  Shoring Installation: Trench shoring boxes were installed progressively as
  excavation advanced. Guardrails were installed on the boxes.
  Pipe Installation: Placed SE-30 sand bedding to grade and installed four
  36-inch water main segments:
  MK-119: Sta 143+98.31 to Sta 143+59.06
  MK-120: Sta 143+59.08 to Sta 143+19.32

Note what that is doing:
- A short label, then complete sentences. NOT "Question: answer".
- Related answers are merged into one sub-topic. Starting station, ending
  station and what was dug are ONE paragraph about excavation, not three lines.
- Lists of numbered items - pipe joints, welds - stay as their own lines under
  the sub-topic that introduces them.
- The label is the work, not the question that was asked.

VOICE - THIS IS THE PART THAT MATTERS MOST
The answers were spoken quickly in the field and read like it. The report does
not. Rewrite every one of them:
- Third person, past tense. NEVER "I", "we", "my" or "our".
  "i wasnt on site when welding finished" becomes "Welding was not complete at
  the end of the inspection period."
  "backfill didnt take place while i was on site" becomes "No backfilling was
  observed during the inspection period."
- Fix spelling and grammar. "there trucks" is "their trucks", "didnt" is
  "did not". Never change a technical term, a proper noun or an abbreviation.
- Plain English. No "delve", "it is worth noting", "seamless", "robust",
  "leverage", "furthermore", "moreover", and never open with "additionally" or
  "overall". No "utilized" for used, "commenced" for started, "prior to" for
  before.
- Do NOT grade the work. Never "properly", "successfully", "good", "adequate".
  Stating that work conformed to a named plan, spec or submittal IS the
  inspection finding and is expected - "installed per the approved plan" is
  correct and must be kept.
- Stations as "Sta XX+XX" keeping every decimal. Times 12-hour with AM/PM.
  Acronyms stay acronyms - BMP, never Best Management Practice.

WHAT YOU MUST NOT DO
- Do NOT invent. Every station, quantity, count, name, time and material must
  come from the answers. If something was not answered, it does not appear.
- Do NOT report an absence as an event. If an answer says something did not
  happen, or was not observed, say so plainly in one sentence - do not build a
  paragraph around it.
- Do NOT repeat a contractor's claim as your finding. Report the fact - a crew
  stood by, a conflict was hit - and leave out the argument.
- Do NOT pad. A section with two facts is two sentences. Length is not quality.

IT MUST READ LIKE A REPORT, NOT LIKE THE NOTES
What you produce is the finished document, and it has to flow:
- Join related facts into a sentence that reads. "Silt was cleared from the
  trench floor from Sta 45+14 to Sta 44+72, and trench boxes were installed
  from Sta 45+28 to Sta 44+58." NOT two stubs on two lines.
- Complete sentences with real verbs. "backfill - none" is not a sentence.
  "No backfilling was performed during the inspection period." is.
- Vary how sentences open. Four in a row starting the same way reads as a form.
- Say it once. A station that appears in two answers appears once in the
  writing.
- Every sentence carries a fact. None exists to introduce, summarise or
  transition into another one.

HOW A SECTION ABOUT WORK AT A LOCATION OPENS AND CLOSES
The reader checks the same things on every report and should not have to hunt
for them, so a location's write-up has a frame:

- OPEN with the shift times for that location, as two labelled lines and
  nothing else on them, in EXACTLY this shape:

      Start Time: 6:30 AM
      End Time: 3:00 PM

  A colon after the label, one space, then the time. Not a dash, not brackets,
  not a sentence. The reader looks for these two lines on every report and
  scans straight to them, which only works if they are the same two lines
  every time. Do not put them in a bullet.
- Then the traffic control that was set, and where.
- Then the work itself, in the order it happened, naming the crew and the plant
  that did it.
- CLOSE with what became of the traffic control: picked up, or left standing
  and why.

If an answer for one of those was not given, leave that part out and write the
rest. Do NOT decide that traffic control was removed because the shift ended,
and do not invent times. A missing fact stays missing.

NEVER WRITE A LABEL WITH NOTHING AFTER IT
"Traffic control" on its own line, or "Start Time:" with no time, is worse than
leaving it out: it reads as a fact that went missing between the field and the
page. If you have nothing to put after a label, do not write the label.

DO NOT MIMIC THE SHAPE FOR ITS OWN SAKE
The sub-topic labels exist because the work has natural groupings, not because
every line needs a label. If a section holds one thing, write the sentence and
stop - do not invent a label to make it match the other sections. A short
section is correct when the day was short on that topic.

PUT EACH FACT IN THE SECTION IT BELONGS TO
Some questions collect several operations at once - the starting and ending
stations name excavation, pipe AND backfill together. Route each fact to the
section that covers it, not the section whose question happened to collect it.
Backfill stations belong in the backfilling section. A fact appears ONCE.

EMPTY SECTIONS
If a section has no answers, or every answer says nothing happened, return the
empty statement given for it, exactly as provided. Do not write around it.

Return JSON ONLY:
{"sections": [{"id": "section_id", "body": "the written section"}]}

Use "\n" between lines inside a body. Every section you were given must appear
exactly once.
"""


class ComposeRequest(BaseModel):
    profile: str = ''
    answers: dict[str, Any] = {}
    report_date: str = ''


class ComposedSection(BaseModel):
    id: str = ''
    number: int = 0
    title: str = ''
    body: str = ''


class ComposeResponse(BaseModel):
    sections: list[ComposedSection] = []
    status: str = 'ok'
    reason: str = ''


@router.post('/compose', response_model=ComposeResponse)
async def compose_report(request: ComposeRequest, _user=Depends(require_user)):
    """
    Turn the interview answers into a written report.

    The step that was missing. Without it the report was the answers echoed
    back with a label in front of each one - a question-and-answer display,
    not a document. The answers are notes; this writes from them.

    Handles both single-day numbered profiles (Morena Pipelines) and
    repeating-location profiles (Morena Conveyance North).
    """
    profile = get_profile(request.profile)
    answers = request.answers or {}

    def _clean_val(raw: Any) -> str:
        val = str(raw or '').strip()
        if val.lower() in ('none', 'nothing', 'n/a', 'na'):
            return ''
        return val

    def _pass_key(qid: str, pass_num: int) -> str:
        return qid if pass_num <= 1 else f'{qid}#{pass_num}'

    def _split_locations(raw: Any) -> list[str]:
        text = str(raw or '').strip()
        if not text:
            return []
        items: list[str] = []
        for part in re.split(r'\r?\n|;', text):
            cleaned = re.sub(r'^[-•\d.)\s]+', '', part).strip()
            if cleaned and cleaned.lower() not in ('none', 'nothing', 'n/a', 'na'):
                items.append(cleaned)
        return items

    blocks: list[str] = []
    wanted: list[dict[str, Any]] = []
    valid_qids: set[str] = set()

    repeating = next((s for s in profile.sections if s.repeats and s.repeat_from), None)

    if repeating is not None:
        # ── Repeating-location profile (Morena Conveyance North) ──
        valid_qids.add(repeating.repeat_from)
        locations = _split_locations(answers.get(repeating.repeat_from, ''))
        if not locations:
            has_pass_one = any(
                _clean_val(answers.get(q.id, ''))
                for q in repeating.questions
                if q.kind != 'yesno'
            )
            if has_pass_one:
                locations = ['Work Performed']

        for idx, loc_name in enumerate(locations):
            pass_num = idx + 1
            loc_start = _clean_val(answers.get(_pass_key('start_time', pass_num), ''))
            loc_stop = _clean_val(answers.get(_pass_key('stop_time', pass_num), ''))
            lines: list[str] = []
            for question in repeating.questions:
                valid_qids.add(question.id)
                if question.kind == 'yesno':
                    continue
                if question.gate:
                    gate_val = _clean_val(answers.get(_pass_key(question.gate, pass_num), '')).lower()
                    if gate_val == 'no':
                        continue
                value = _clean_val(answers.get(_pass_key(question.id, pass_num), ''))
                if not value:
                    continue
                if question.kind in ('crew', 'equipment'):
                    lines.append(
                        f'- {question.prompt} (context only — name the trade or machine '
                        f'naturally in the work sentences where helpful; do NOT list '
                        f'rosters or counts, as counts print in the tables below)\n'
                        f'  ANSWER: {value}'
                    )
                else:
                    lines.append(f'- {question.prompt}\n  ANSWER: {value}')

            sec_id = f'location:{pass_num}'
            wanted.append({
                'id': sec_id,
                'number': pass_num,
                'title': loc_name,
                'empty_statement': repeating.empty_statement,
                'start_time': loc_start,
                'stop_time': loc_stop,
                'has_times': True,
            })
            blocks.append(
                f'SECTION {sec_id} — "Location {pass_num}: {loc_name}" (LOCATION ACTIVITY WRITE-UP)\n'
                'FORMAT FOR THIS SECTION: Write a complete Morena Conveyance North location '
                'activity narrative from the answers below. Open with "Start Time: <time>" and '
                '"End Time: <time>" on their own lines when shift times are provided. Then write '
                'the narrative in chronological order as complete, formal third-person past-tense '
                'sentences (one bullet "• ..." per distinct operation or observation): '
                '(1) the traffic control that was set, street/area, direction of travel, and '
                'lane closures if reported; (2) the work performed in complete sentences with '
                'every station, measurement, quantity, material, and trade/machine from the '
                'answers; (3) any additional site observations, deliveries, testing, or delays; '
                'and (4) whether traffic control was picked up at the end of the shift or left '
                'standing and why.\n'
                + ('\n'.join(lines) if lines
                   else f'(no answers — use exactly: "{repeating.empty_statement}")')
                + f'\nEMPTY STATEMENT IF NOTHING HAPPENED: "{repeating.empty_statement}"'
            )

        day_close = next((s for s in profile.sections if s.id == 'day_close'), None)
        if day_close is not None:
            day_lines: list[str] = []
            for question in day_close.questions:
                valid_qids.add(question.id)
                if question.kind == 'yesno':
                    continue
                if question.gate:
                    gate_val = _clean_val(answers.get(question.gate, '')).lower()
                    if gate_val == 'no':
                        continue
                value = _clean_val(answers.get(question.id, ''))
                if value:
                    day_lines.append(f'- {question.prompt}\n  ANSWER: {value}')
            if day_lines:
                wanted.append({
                    'id': 'general_notes',
                    'number': 0,
                    'title': 'General Notes',
                    'empty_statement': '',
                    'start_time': '',
                    'stop_time': '',
                    'has_times': False,
                })
                blocks.append(
                    'SECTION general_notes — "General Notes (Day-Level Observations)"\n'
                    'FORMAT FOR THIS SECTION: Write complete, formal third-person past-tense '
                    'sentences covering the day-level extra work/T&M, visitors, inspections, '
                    'deliveries, or shift observations below.\n'
                    + '\n'.join(day_lines)
                )
    else:
        # ── Single-day numbered-section profile (Morena Pipelines) ──
        shift_start_val = _clean_val(answers.get('shift_start', ''))
        shift_end_val = _clean_val(answers.get('shift_end', ''))
        valid_qids.update(('shift_start', 'shift_end'))

        for section in profile.sections:
            if not section.number or section.id in ('labor', 'equipment'):
                continue
            lines = []
            if section.id == 'work_summary':
                if shift_start_val:
                    lines.append(f'- What time did the crew start?\n  ANSWER: {shift_start_val}')
                if shift_end_val:
                    lines.append(f'- What time did the crew stop?\n  ANSWER: {shift_end_val}')
            for question in section.questions:
                valid_qids.add(question.id)
                if question.kind == 'yesno':
                    continue
                if question.gate:
                    gate_val = _clean_val(answers.get(question.gate, '')).lower()
                    if gate_val == 'no':
                        continue
                value = _clean_val(answers.get(question.id, ''))
                if value:
                    lines.append(f'- {question.prompt}\n  ANSWER: {value}')
            wanted.append({
                'id': section.id,
                'number': section.number,
                'title': section.title,
                'empty_statement': section.empty_statement,
                'start_time': shift_start_val if section.id == 'work_summary' else '',
                'stop_time': shift_end_val if section.id == 'work_summary' else '',
                'has_times': section.id == 'work_summary',
            })
            blocks.append(
                f'SECTION {section.id} — "{section.number}. {section.title}"\n'
                + (('\n'.join(lines)) if lines
                   else f'(no answers — use exactly: "{section.empty_statement}")')
                + f'\nEMPTY STATEMENT IF NOTHING HAPPENED: "{section.empty_statement}"'
            )

        extra_sec = next((s for s in profile.sections if s.id == 'additional_activity'), None)
        if extra_sec is not None and _clean_val(answers.get('more_activities', '')).lower() == 'yes':
            for p in range(1, 31):
                area = _clean_val(answers.get(_pass_key('extra_activity_area', p), ''))
                extra_start = _clean_val(answers.get(_pass_key('extra_activity_start', p), ''))
                extra_stop = _clean_val(answers.get(_pass_key('extra_activity_stop', p), ''))
                extra_work = _clean_val(answers.get(_pass_key('extra_activity_summary', p), ''))
                if not area and not extra_work:
                    break
                extra_lines: list[str] = []
                for q in extra_sec.questions:
                    valid_qids.add(q.id)
                    val = _clean_val(answers.get(_pass_key(q.id, p), ''))
                    if not val:
                        continue
                    if q.kind in ('crew', 'equipment'):
                        extra_lines.append(
                            f'- {q.prompt} (context only — counts print in Sections 7 & 8)\n'
                            f'  ANSWER: {val}'
                        )
                    else:
                        extra_lines.append(f'- {q.prompt}\n  ANSWER: {val}')
                sec_id = f'extra_activity:{p}'
                wanted.append({
                    'id': sec_id,
                    'number': 0,
                    'title': area or f'Activity {p + 1}',
                    'empty_statement': '',
                    'start_time': extra_start,
                    'stop_time': extra_stop,
                    'has_times': True,
                })
                blocks.append(
                    f'SECTION {sec_id} — "Additional Activity {p}: {area or f"Activity {p + 1}"}"\n'
                    'FORMAT FOR THIS SECTION: Write a complete Morena Pipelines Section 1 '
                    'narrative for this additional activity, opening with "Start Time: <time>" '
                    'and "End Time: <time>" when shift times are provided, followed by '
                    'labelled sub-topics in complete third-person past-tense sentences.\n'
                    + '\n'.join(extra_lines)
                )
                if _clean_val(answers.get(f'__more__:additional_activity:{p}', '')).lower() != 'yes':
                    break

    if not blocks:
        return ComposeResponse(sections=[], status='empty', reason='Nothing was answered.')

    client, model_name = _get_gemini_client()
    from google.genai import types as genai_types

    # Every answer belonging to THIS profile's composed sections, so a fact
    # collected by one section's question can be routed to the section that
    # actually covers it — backfill stations arrive in the combined stations
    # answer but belong in the backfilling section. Foreign keys from other
    # profiles are ignored so another project's answers can never bleed in.
    everything = '\n'.join(
        f'- {k}: {_clean_val(v)}'
        for k, v in answers.items()
        if k.split('#')[0] in valid_qids and _clean_val(v)
    )

    prompt = (
        COMPOSE_PROMPT
        + f'\n\nREPORT DATE: {request.report_date}\n\n'
        + 'EVERY ANSWER GIVEN TODAY (for routing — never state a fact twice):\n'
        + everything
        + '\n\nTHE SECTIONS TO WRITE:\n'
        + '\n\n'.join(blocks)
    )

    response = _gemini_call_with_retry(
        client, model_name,
        contents=[prompt],
        config=genai_types.GenerateContentConfig(
            temperature=0.0,
            thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
            response_mime_type='application/json',
            max_output_tokens=16384,
        ),
    )

    raw = (getattr(response, 'text', None) or '').strip()
    if not raw:
        problem = _finish_reason_problem(response)
        logger.warning(f'[compose] Empty response: {problem}')
        return ComposeResponse(
            sections=[], status='failed',
            reason=problem or 'The report could not be written. Your answers are saved.',
        )

    data = _clean_json(raw)
    # JSON mode keeps planning out of the body in the normal case, but the
    # model can still write its reasoning INTO a body field - that is exactly
    # how "Let's check Section 5" reached a finished report.
    by_id = {
        str(item.get('id', '')): normalise_time_lines(_strip_reasoning(
            str(item.get('body', '') or '').strip(), 'compose'))
        for item in (data.get('sections') or []) if isinstance(item, dict)
    }

    out = []
    for item in wanted:
        sec_id = item['id']
        # A section the model dropped falls back to its empty statement rather
        # than vanishing from the report.
        body = by_id.get(sec_id) or item['empty_statement']
        if item.get('has_times') and body and body != item['empty_statement']:
            body = with_opening_times(item['start_time'], item['stop_time'], body)
        if not body and not item['empty_statement']:
            continue
        out.append(ComposedSection(
            id=sec_id, number=item['number'], title=item['title'], body=body,
        ))

    logger.info(f'[compose] Wrote {len(out)} sections for {request.report_date} (profile={profile.key})')
    return ComposeResponse(sections=out)
