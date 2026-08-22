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
from app.services.report_profiles import get_profile, list_profiles

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

    Crew and equipment are excluded here: they are rows, printed as counts by
    the export, and prose about them would duplicate the tables.
    """
    profile = get_profile(request.profile)
    answers = request.answers or {}

    blocks: list[str] = []
    wanted: list[Any] = []
    for section in profile.sections:
        if section.id in ('labor', 'equipment'):
            continue
        lines = []
        for question in section.questions:
            if question.kind == 'yesno':
                continue
            value = str(answers.get(question.id, '') or '').strip()
            if value:
                lines.append(f'- {question.prompt}\n  ANSWER: {value}')
        wanted.append(section)
        blocks.append(
            f'SECTION {section.id} — "{section.number}. {section.title}"\n'
            + (('\n'.join(lines)) if lines
               else f'(no answers — use exactly: "{section.empty_statement}")')
            + f'\nEMPTY STATEMENT IF NOTHING HAPPENED: "{section.empty_statement}"'
        )

    if not blocks:
        return ComposeResponse(sections=[], status='empty', reason='Nothing was answered.')

    client, model_name = _get_gemini_client()
    from google.genai import types as genai_types

    # Every answer, so a fact collected by one section's question can be routed
    # to the section that actually covers it — backfill stations arrive in the
    # combined stations answer but belong in the backfilling section.
    everything = '\n'.join(
        f'- {k}: {v}' for k, v in answers.items() if str(v or '').strip()
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
    by_id = {
        str(item.get('id', '')): str(item.get('body', '') or '').strip()
        for item in (data.get('sections') or []) if isinstance(item, dict)
    }

    out = []
    for section in wanted:
        # A section the model dropped falls back to its empty statement rather
        # than vanishing from the report.
        body = by_id.get(section.id) or section.empty_statement
        out.append(ComposedSection(
            id=section.id, number=section.number, title=section.title, body=body,
        ))

    logger.info(f'[compose] Wrote {len(out)} sections for {request.report_date}')
    return ComposeResponse(sections=out)
