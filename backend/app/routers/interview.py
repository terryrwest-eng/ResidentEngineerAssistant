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
            '{"rows": [{"trade": "Operator", "qty": 2, "note": ""}], '
            '"value": "", "missing": []}'
        )
    if kind == 'equipment':
        return (
            '{"rows": [{"name": "CAT 335 Excavator", "qty": 2, "note": "active"}], '
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
