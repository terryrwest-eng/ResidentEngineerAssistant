"""
Daily Reporter V4 — the conversation

One endpoint, called once per exchange. It hears what was said, works out what
that told us, writes it into the day record, and decides what to ask next.

WHY THIS REPLACES THE FIXED INTERVIEW: V3 walks a list. It asks question 7
whether or not question 7 was already answered in passing during question 2,
and it cannot follow a thread. Here the next question comes from the difference
between what the report needs and what the record already holds, so the
interview shortens itself as you talk and never asks twice.

A GAP IS WORK, NOT A RESULT. If something is missing, this asks for it. It does
not note it and move on. The only gaps that survive to the end are the ones the
inspector could not answer or three attempts could not settle — and those show
on the page, because an empty field is honest and a filled-in guess is not.

THREE CALLS, ONE JOB EACH. Transcribe, then extract, then decide what to say.
V3 learned this the hard way: a model asked to hear audio AND satisfy a schema
in one step fills the schema with plausible invention when the audio is unclear.
Splitting them costs seconds and buys the only thing that matters here.

SPEED IS NOT A GOAL. Every call runs at the configured thinking level and is
allowed to take as long as it takes. A pause that produces a sharper question
pays for itself; a fast wrong station number does not.
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
    _gemini_call_with_retry,
    _get_gemini_client,
    _strip_reasoning,
    _transcribe_audio,
)
from app.routers.interview import HOUSE_STYLE
from app.services.composer import NotReady, compose
from app.services.day_record import DayRecord

logger = logging.getLogger(__name__)
router = APIRouter(prefix='/api/conversation', tags=['conversation'])


# How the assistant talks. Deliberately NOT the house style — that governs what
# goes in the report. This governs what goes in your ear, and the two must not
# bleed: a report written in this voice would be unusable, and an interview
# conducted in the report's voice is an interrogation.
INTERVIEWER_VOICE = """HOW YOU TALK:
- Like a colleague who has done this job, not a form. Short. Plain.
- One thing at a time, unless two things obviously go together
  ("what time did they start and stop?").
- Pick up what the person actually said. If they mention the contractor was a
  problem, that is worth a sentence before you move on - it is also probably a
  delay or an extra, which the report needs.
- Never read a question ID or a section number out loud.
- Do not grade, praise or sympathise at length. A few words, then the question.
- Never say "great" or "perfect" about the work. You are recording it.

WHAT YOU NEVER DO:
- Never suggest an answer. Not "was that around 7:30?" unless 7:30 is
  something they already said. Offering a number is how a wrong number gets
  agreed to.
- Never move on from something you did not understand. Ask again, and ask
  specifically about the part that was unclear.
- Never accept a claim as a fact. "The GC held us up" is something to ask
  about (what happened, how long, who was standing by), not something to
  write down as a finding.
"""


class TurnRequest(BaseModel):
    profile: str = 'morena'
    report_date: str = ''
    # The record as it stands. Empty on the first turn.
    record: dict[str, Any] | None = None
    # Prior exchanges: [{"role": "assistant"|"inspector", "text": "..."}]
    history: list[dict[str, str]] = []
    # What was just said. Audio or typed - both land in the same place.
    audio_data: str = ''
    mime_type: str = 'audio/webm'
    duration_seconds: float = 0
    text: str = ''
    # Which slots the last question was aimed at, so a short answer
    # ("seven thirty") can be attached to the thing that was asked.
    asked_keys: list[str] = []


class TurnResponse(BaseModel):
    transcript: str = ''
    reply: str = ''
    record: dict[str, Any] = {}
    updated: list[dict[str, Any]] = []
    asked_keys: list[str] = []
    conflicts: list[dict[str, str]] = []
    progress: dict[str, int] = {}
    gaps: list[dict[str, Any]] = []
    ready_to_write: bool = False
    status: str = 'ok'      # ok | repeat | done
    reason: str = ''


def _load(request: TurnRequest) -> DayRecord:
    if request.record:
        try:
            return DayRecord.from_dict(request.record)
        except Exception as exc:
            logger.warning('[conversation] could not restore record: %s', exc)
    return DayRecord(request.profile, request.report_date)


def _slot_menu(record: DayRecord) -> str:
    """
    Every slot the model is allowed to write, with its id and what it wants.

    Handing over the whole menu — not just the one thing we asked — is what lets
    a single sentence fill four fields. "We started at 7 on Nobel, two operators
    and a foreman" answers start_time and crew in one go, and a system that only
    listens for the answer to its own question throws the rest away.
    """
    lines = []
    for slot in record.slots.values():
        if slot.state == 'na':
            continue
        mark = {'ok': 'known', 'suspect': 'UNCLEAR', 'empty': 'needed'}[slot.state]
        detail = f' — currently: {slot.value[:60]}' if slot.value else ''
        where = f' @ {slot.instance}' if slot.instance else ''
        lines.append(f'  {slot.key}  [{slot.kind}]{where}  ({mark}){detail}\n      asks: {slot.prompt}')
    return '\n'.join(lines)


def _history_text(history: list[dict[str, str]], limit: int = 12) -> str:
    out = []
    for turn in history[-limit:]:
        who = 'You' if turn.get('role') == 'assistant' else 'Inspector'
        out.append(f'{who}: {turn.get("text", "").strip()}')
    return '\n'.join(out)


def _call_json(client, model_name, prompt: str, where: str) -> dict[str, Any]:
    from google.genai import types as genai_types
    response = _gemini_call_with_retry(
        client, model_name,
        contents=[prompt],
        config=genai_types.GenerateContentConfig(
            thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
            max_output_tokens=8192,
        ),
    )
    return _clean_json(_strip_reasoning(response.text or '', where))


def _extract(client, model_name, record: DayRecord, transcript: str,
             history: list[dict[str, str]], asked_keys: list[str]) -> dict[str, Any]:
    """
    Work out what the utterance told us, and write nothing else.

    The state on each update is the model's own judgement of how well it heard,
    and it is the most important field it returns. "suspect" costs one follow-up
    question. Guessing "ok" costs a wrong number in a signed document.
    """
    aimed = ', '.join(asked_keys) if asked_keys else '(nothing specific — an open turn)'
    prompt = f"""You are keeping the record for a Resident Engineer's daily construction report.
The inspector just said something. Work out which fields it answers.

{HOUSE_STYLE}

THE CONVERSATION SO FAR:
{_history_text(history) or '(this is the first thing said)'}

THE LAST QUESTION WAS AIMED AT: {aimed}

WHAT THEY JUST SAID:
---
{transcript}
---

FIELDS YOU MAY WRITE TO (write to nothing else, invent no new keys):
{_slot_menu(record)}

RULES:
1. Only write a field the utterance ACTUALLY addresses. Saying nothing about
   equipment is not the same as saying there was no equipment.
2. Judge how well you heard each one:
   - "ok"      they said it plainly and you are sure
   - "suspect" you heard something but a number, name or station is unclear,
               or two readings are possible. Say which in "reason".
   - "na"      they clearly said this did not happen today. Put why in "reason".
   Never mark "ok" to avoid a follow-up question. An unclear value that gets
   written as certain is the worst outcome available to you.
3. Stations keep every decimal exactly as spoken. Times are 12-hour with AM/PM.
3a. A field of kind "crew" or "equipment" is answered with "rows", not "value".
   Use these keys and leave out what was not said - a missing key is honest,
   an invented value is not:
     crew       {{"trade": "LL-03- Laborers", "name": "Dan Griffin", "qty": 1,
                 "hours": 4.25, "company": "Payco", "is_3rd_party": false}}
     equipment  {{"name": "LE-161- Traffic Control Truck", "qty": 1,
                 "hours": 4.25, "company": "Payco"}}
   One row per person and per machine. Do NOT total them into a single row
   with a quantity: eight labourers are eight people with names.
   Write the resource exactly as spoken. Do not map it to a code yourself.
4. If what they said DISAGREES with a field already marked known, do not
   overwrite it. Report it in "conflicts" and let the inspector settle it.
5. A contractor's complaint is not a finding. If they say the GC held them up,
   that is a lead to follow, not a value to write.

RETURN JSON EXACTLY:
{{
  "updates": [
    {{"key": "activity::Nobel Dr::start_time", "state": "ok",
      "value": "7:30 AM", "rows": [], "reason": ""}}
  ],
  "conflicts": [
    {{"key": "...", "known": "what the record says",
      "heard": "what they just said", "note": "why these disagree"}}
  ],
  "hooks": ["anything they mentioned that the report probably needs and no field covers yet"]
}}"""
    return _call_json(client, model_name, prompt, 'conversation.extract')


def _plan(client, model_name, record: DayRecord, transcript: str,
          history: list[dict[str, str]], hooks: list[str], opening: bool) -> dict[str, Any]:
    """
    Decide what to say next.

    It is given the ranked list of what is still unknown, but it chooses — a
    hook the inspector raised themselves is usually worth following before the
    next item on a list, because they are already thinking about it.
    """
    targets = record.next_targets(8)
    if opening:
        situation = 'This is the very start. Open the conversation and ask how the day went.'
    elif not targets and not record.conflicts:
        situation = 'Everything the report needs is known. Say so, and offer to write it up.'
    else:
        situation = 'Keep going. Get what is still missing.'

    target_lines = '\n'.join(
        f'  {t.key}  ({"UNCLEAR - " + (t.reason or "re-ask specifically") if t.state == "suspect" else "not yet asked"})'
        f'{" @ " + t.instance if t.instance else ""}\n'
        f'      wants: {t.prompt}'
        + (f'\n      they said: "{t.heard[:120]}"' if t.state == 'suspect' and t.heard else '')
        for t in targets
    ) or '  (nothing outstanding)'

    conflict_lines = '\n'.join(
        f'  {c.get("key","")}: record says "{c.get("known","")}", just heard "{c.get("heard","")}"'
        for c in record.conflicts
    ) or '  (none)'

    prompt = f"""You are interviewing a Resident Engineer about his day so you can write his
daily construction report. You are talking out loud - this text will be spoken.

{INTERVIEWER_VOICE}

SITUATION: {situation}

THE CONVERSATION SO FAR:
{_history_text(history) or '(nothing yet)'}

WHAT HE JUST SAID:
{transcript or '(nothing yet)'}

THINGS HE RAISED THAT NOTHING COVERS YET:
{chr(10).join('  - ' + h for h in hooks) or '  (none)'}

DISAGREEMENTS TO SETTLE FIRST:
{conflict_lines}

STILL UNKNOWN, most useful first:
{target_lines}

HOW TO CHOOSE:
- A disagreement gets settled before anything else. Ask which is right.
- Something marked UNCLEAR is asked again SPECIFICALLY - name the two things it
  could have been, using his own words. Never re-read the original question.
- A hook he raised himself usually beats the top of the list. He is already
  thinking about it.
- Otherwise take the top item, and fold in a second only if they naturally
  belong in one breath.
- If nothing is outstanding, say the report is ready and ask if he wants it.

RETURN JSON EXACTLY:
{{
  "reply": "what you say out loud - one or two sentences",
  "asked_keys": ["the slot keys this question is aimed at"],
  "done": false
}}"""
    return _call_json(client, model_name, prompt, 'conversation.plan')


@router.post('/turn', response_model=TurnResponse)
async def take_turn(request: TurnRequest, _user=Depends(require_user)):
    """One exchange: hear it, record it, decide what to ask next."""
    record = _load(request)
    client, model_name = _get_gemini_client()
    transcript = (request.text or '').strip()
    opening = not transcript and not request.audio_data and not request.history

    # ── 1. hear it ──
    if not opening and not transcript:
        if not request.audio_data:
            raise HTTPException(status_code=400, detail='Nothing was said and nothing was typed.')
        heard = _transcribe_audio(
            client, model_name,
            _decode_audio(request.audio_data), request.mime_type,
            duration_seconds=float(request.duration_seconds or 0),
            extra_instructions=(
                'This is one turn of a spoken conversation about a day of construction '
                'work. Transcribe exactly what is said, including every station number, '
                'quantity, time and company name. Do not tidy it up.'
            ),
        )
        transcript = (heard.transcription or '').strip()
        if heard.status in ('failed', 'suspect') or not transcript:
            # Do not extract from audio we could not read. Ask for it again -
            # that is one more sentence, and the alternative is a guess.
            return TurnResponse(
                transcript=transcript,
                reply="Sorry, I didn't catch that - say it again?",
                record=record.to_dict(),
                progress=record.progress(),
                gaps=[g.to_dict() for g in record.gaps()],
                status='repeat',
                reason=heard.reason or 'The recording could not be read clearly.',
            )

    # ── 2. work out what it told us ──
    updated: list[dict[str, Any]] = []
    hooks: list[str] = []
    if transcript:
        try:
            found = _extract(client, model_name, record, transcript, request.history, request.asked_keys)
        except Exception as exc:
            logger.exception('[conversation] extract failed: %s', exc)
            raise HTTPException(status_code=502, detail=f'Could not read that answer: {exc}')

        for upd in (found.get('updates') or []):
            key = str(upd.get('key', '')).strip()
            state = str(upd.get('state', '')).strip().lower()
            if key not in record.slots or state not in ('ok', 'suspect', 'na'):
                logger.info('[conversation] ignored update to unknown slot %r (%s)', key, state)
                continue
            slot = record.apply(
                key, state=state,
                value=str(upd.get('value', '') or ''),
                rows=list(upd.get('rows') or []),
                heard=transcript,
                reason=str(upd.get('reason', '') or ''),
            )
            if slot:
                updated.append({'key': key, 'state': state, 'value': slot.value,
                                'instance': slot.instance, 'reason': slot.reason})

        for c in (found.get('conflicts') or []):
            record.conflicts.append({k: str(c.get(k, '')) for k in ('key', 'known', 'heard', 'note')})
        hooks = [str(h) for h in (found.get('hooks') or []) if str(h).strip()]

        # Naming the locations is what brings the repeating section into
        # existence. Until it happens there is nothing to ask about the work.
        for section in record.profile.sections:
            src = getattr(section, 'repeat_from', '')
            if not getattr(section, 'repeats', False) or not src:
                continue
            named = next((s for s in record.slots.values()
                          if s.question_id == src and s.state == 'ok'), None)
            if named and not record.instances.get(section.id):
                labels = [str(r.get('item') or r.get('name') or '').strip()
                          for r in named.rows] or \
                         [l.strip() for l in named.value.splitlines() if l.strip()]
                if labels:
                    record.set_instances(section.id, labels)
                    logger.info('[conversation] %s -> %d instances', section.id, len(labels))

    record.apply_gates()

    # ── 3. decide what to say ──
    try:
        plan = _plan(client, model_name, record, transcript, request.history, hooks, opening)
    except Exception as exc:
        logger.exception('[conversation] plan failed: %s', exc)
        raise HTTPException(status_code=502, detail=f'Could not work out what to ask next: {exc}')

    reply = str(plan.get('reply', '') or '').strip()
    asked = [k for k in (plan.get('asked_keys') or []) if k in record.slots]
    record.mark_asked(asked)

    ready = record.can_compose()
    return TurnResponse(
        transcript=transcript,
        reply=reply,
        record=record.to_dict(),
        updated=updated,
        asked_keys=asked,
        conflicts=record.conflicts,
        progress=record.progress(),
        gaps=[g.to_dict() for g in record.gaps()],
        ready_to_write=ready,
        status='done' if ready and bool(plan.get('done')) else 'ok',
    )


class ComposeRequest(BaseModel):
    profile: str = 'morena'
    report_date: str = ''
    record: dict[str, Any] | None = None


@router.post('/compose')
async def compose_report(request: ComposeRequest, _user=Depends(require_user)):
    """
    Turn a finished day record into a report, ready to save.

    Returns 409 with what is blocking rather than writing around a hole. The
    caller is a conversation that can still ask - handing it the list of what
    is missing is more useful than handing it a report with a confident
    sentence covering an unknown.
    """
    record = _load(TurnRequest(profile=request.profile,
                               report_date=request.report_date,
                               record=request.record))
    client, model_name = _get_gemini_client()

    try:
        report = compose(record, client, model_name)
    except NotReady as exc:
        raise HTTPException(status_code=409, detail={
            'error': 'record_not_ready',
            'blocking': exc.blocking,
            'conflicts': exc.conflicts,
            'progress': record.progress(),
        })
    except Exception as exc:
        logger.exception('[conversation] compose failed: %s', exc)
        raise HTTPException(status_code=502, detail=f'Could not write the report: {exc}')

    return {'report': report, 'progress': record.progress()}


@router.post('/gaps')
async def show_gaps(request: TurnRequest, _user=Depends(require_user)):
    """
    What is still unknown, without spending a turn.

    For the screen that shows the state of the report while the conversation is
    running. Reads the record and nothing else - no model call.
    """
    record = _load(request)
    record.apply_gates()
    return {
        'progress': record.progress(),
        'gaps': [g.to_dict() for g in record.gaps()],
        'blocking': record.blocking(),
        'conflicts': record.conflicts,
        'ready_to_write': record.can_compose(),
    }
