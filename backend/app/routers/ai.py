"""
Daily Reporter V3 — AI Router (Scanning + Dictation)

Endpoints:
  POST /api/ai/scan-notes          → Scan timesheet / handwritten notes
  POST /api/ai/scan-extra-work     → Scan Extra Work Ticket (EW flag set)
  POST /api/ai/scan-consultant     → Scan Consultant Site Visit Record
  POST /api/ai/transcribe          → Voice dictation (base64 audio → activities)

Uses Gemini 2.5 Pro for all vision and transcription tasks.
Prompts are ported from the legacy app verbatim — they are battle-tested.

WHY: The legacy app's prompts were iterated over many field sessions and
     tuned specifically for OHL construction documents. Do NOT simplify them.
"""

import io
import json
import logging
import os
import re
import time
from typing import Any

from fastapi import Depends, APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.config import GEMINI_API_KEY, GEMINI_MODEL_NAME, GEMINI_THINKING_LEVEL

logger = logging.getLogger(__name__)
from app.core.auth import require_user

# Every route below requires a signed-in user, declared once here rather than on
# each endpoint: a per-endpoint decorator is something you can forget to add,
# and forgetting it on a data route would expose one user's records to another.
# require_user also pins the request to that user's storage, which is what makes
# every path in this file resolve inside their own directory.
router = APIRouter(prefix="/api/ai", tags=["ai"], dependencies=[Depends(require_user)])


def _gemini_call_with_retry(client: Any, model_name: str, max_retries: int = 3, **kwargs: Any) -> Any:
    """
    Wrapper around client.models.generate_content() with retry on 503/429.

    WHY: Gemini returns 503 UNAVAILABLE during high demand spikes.
    These are transient — a simple retry with exponential backoff fixes it.
    """
    from google.genai.errors import ServerError, ClientError

    last_error: Exception | None = None
    for attempt in range(max_retries):
        try:
            return client.models.generate_content(model=model_name, **kwargs)
        except ServerError as exc:
            last_error = exc
            wait = 2 ** (attempt + 1)  # 2s, 4s, 8s
            logger.warning(
                f'[gemini-retry] Attempt {attempt + 1}/{max_retries} got {exc.code}. '
                f'Retrying in {wait}s...'
            )
            time.sleep(wait)
        except ClientError as exc:
            # 429 Too Many Requests — also retryable
            if exc.code == 429:
                last_error = exc
                wait = 2 ** (attempt + 1)
                logger.warning(
                    f'[gemini-retry] Attempt {attempt + 1}/{max_retries} got 429. '
                    f'Retrying in {wait}s...'
                )
                time.sleep(wait)
            else:
                raise  # Non-retryable client error
    # All retries exhausted
    raise last_error  # type: ignore[misc]


# ============================================
# LAZY IMPORT — Only initialize Gemini when needed
# ============================================

def _get_gemini_client(model_name: str = GEMINI_MODEL_NAME):
    """Initialize the Gemini client on first use."""
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured. Set it in .env")
    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        return client, model_name
    except ImportError:
        raise HTTPException(status_code=500, detail="google-genai package not installed. Run: pip install google-genai")


# ============================================
# SHARED EXTRACTION RULES (All scan types use these)
# WHY: Same field names across all endpoints = no silent data drops on frontend.
# ============================================

STANDARD_EXTRACTION_RULES = """
STANDARD OUTPUT SCHEMA — EVERY RESPONSE MUST USE THESE EXACT FIELD NAMES:

For each activity:
{
    "work_area": "Location(s) - Company(s) - Basic Description",
    "summary_html": "• One bullet point per distinct thought or action. Use as many bullets as needed to fully and accurately capture every detail — do not summarize, skip, or compress.",
    "manpower": [
        {
            "trade": "Laborer",
            "classification": "",
            "name": "",
            "company": "ABC Contractors",
            "qty": 2,
            "hours": 8,
            "start_time": "7:00 AM",
            "stop_time": "3:30 PM",
            "ot_hours": 0,
            "is_extra_work": false,
            "is_3rd_party": false,
            "is_consultant": false
        }
    ],
    "equipment": [
        {
            "name": "Mini Excavator",
            "description": "Mini Excavator",
            "company": "XYZ Rentals",
            "qty": 1,
            "hours": 8,
            "start_time": "7:00 AM",
            "stop_time": "3:30 PM",
            "is_extra_work": false,
            "is_3rd_party": false,
            "is_rental": true
        }
    ]
}

WORK AREA FORMAT — CRITICAL:
- Format: "Location(s) - Company(s) - Basic Description"
- Example: "Station 10+50 - OHL - Grading"
- Example: "Main St & 2nd Ave - OHL Construction - Pipe Installation"
- The location is EXACTLY as written in the source (station numbers, street names, etc.)
- The company is the contractor/sub performing the work
- The basic description is a SHORT label (Grading, Paving, Demob & Restore, Pipe Installation, etc.)
- If company is unknown, omit it: "Station 10+50 - Grading"

FIELD RULES:
1. MANPOWER:
   - "trade" = The craft/role (Laborer, Operator, Foreman, Carpenter, Electrician, Ironworker, Mason, Finisher, Pipefitter, Teamster, Journeyman, Apprentice, Superintendent, PM, PE, GF, Welder, Safety Manager, Survey Crew)
   - "classification" = Classification level if mentioned — leave empty string if unknown
   - "name" = Person's name if mentioned — leave empty string if unknown
   - "company" = Company/contractor name if mentioned — leave empty string if unknown
   - "qty" = Number of this resource (integer)
   - "hours" = The person's TOTAL hours for the day. Timesheets often list per-task hours — ALWAYS use the "Total" or "Daily Total" column. If no total column, SUM all task-row hours for that person.
   - "start_time" = Actual start time listed — MUST populate if on document
   - "stop_time" = Actual stop time listed — MUST populate if on document
   - "ot_hours" = Overtime hours if mentioned (number, default 0)
   - "is_extra_work" = true if T&M, Extra Work, EW, Ticket scope (NOT overtime pay rate)
   - "is_3rd_party" = true if Sub, Subcontractor, 3rd Party
   - "is_consultant" = true if Consultant, Inspector, Monitor

2. EQUIPMENT:
   - "name" = Equipment identifier (e.g. "F-250", "Bobcat", "CAT 330") — the specific unit
   - "description" = Equipment TYPE (e.g. "Pickup Truck", "Skid Steer", "Excavator") — what it IS

   TRUCK CLASSIFICATION RULES:
   - F-150, F-250, Ram 1500/2500, Silverado/Sierra 1500/2500 = "Pickup Truck"
   - F-350+, Ram 3500+, Silverado/Sierra 3500+ = "Crew Truck"
   - The "name" gets the model, "description" gets the classification
   - "qty" = Number of this resource (integer)
   - "hours" = Total hours worked
   - "start_time" and "stop_time" = Populate if on document
   - "is_extra_work" = true if T&M scope
   - "is_3rd_party" = true if sub/3rd party
   - "is_rental" = true if Rental/Rented or company name contains "Rentals"

3. SCOPE vs PAY RATE — THEY ARE INDEPENDENT:
   - "Extra Work", "EW", "T&M", "Ticket" = SCOPE (out of contract). Set is_extra_work: true
   - "OT", "Overtime", "Double Time", "Premium" = PAY RATE. Set ot_hours for that portion
   - Do NOT mark overtime pay as extra work scope — they are unrelated

STYLE — MANDATORY:
1. Use DIRECT field language. "The crew excavated from Sta 10+00 to 12+50" NOT "The construction workforce proceeded with excavation activities."
2. NO adjectives YOU added: "efficiently," "successfully," "smoothly" — DELETE. But NEVER delete a conformance statement the speaker made ("per plan," "per spec," "in accordance with the approved submittal"): the author is the Resident Engineer and that verdict is the point of the report. Keep those verbatim. Only "properly"/"correctly" standing alone, with no plan or spec named, should go.
3. NO corporate vocabulary: "utilized" → "used," "commenced" → "started," "implemented" → "installed."
4. STATION FORMAT: Always use "Sta XX+XX" (e.g. "Sta 10+50 to 12+00").
5. FIRST PERSON TO THIRD PERSON — ONLY when the sentence uses a first-person pronoun (we/I/our/us/my). Use the real subject (company, trade) when known. ALWAYS use "The crew" instead of "crews" when referring to a group of workers. Do NOT prepend "The crew" to bullets already in third person.
6. Fix spelling, grammar, punctuation. Do NOT change technical terms or proper nouns.
7. Use "• " (bullet character) for ALL bullets in summary_html. NEVER use * or -. Do NOT use HTML tags (<ul>, <li>, <p>, etc.). Use PLAIN TEXT.
8. Use periods between thoughts, NOT semicolons.
9. Everything in past tense. "Placed concrete" NOT "Performing concrete work."
10. DO NOT fabricate or guess content. Only extract what is explicitly in the document.
11. Output ONLY the JSON. No commentary, no "Here is your report."
"""

NOTE_SCAN_PROMPT = f"""You are an expert construction field assistant helping to digitize handwritten notes.

Your input could be:
1. Handwritten field notes (notebook style)
2. A contractor's daily timesheet or T&M tag
3. A printed prior daily report
4. PDF Documents (Timesheets, typed reports)
5. Photos of contractor notes

TASK:
Extract work activities from the uploaded documents. One activity may be in one location or multiple locations.
Each upload group should become a single activity. Extract the entire summary per group — if more than one block of text
is found summarizing work, add all of them to the summary as one.
Fix misspellings, unstructured sentences, missing words, and punctuation.
You can modify sentences enough to make them full thoughts — do not add context, do not remove context.

- Combine ALL work descriptions into a SINGLE activity.
- Use the most dominant or general location as the 'work_area'.
- Aggregate ALL manpower and equipment into this single activity.
- Return a list containing EXACTLY ONE activity.

{STANDARD_EXTRACTION_RULES}

DOCUMENT SCANNING SPECIFIC:
- PRESERVE ORIGINAL TEXT: do NOT substitute synonyms ("manway" stays "manway", NOT "manhole")
- DO NOT summarize ("patch interior pipe joint grouting" is NOT "repairs")
- Keep the user's original key terms, stations, etc.
- If a station range is given (e.g. Station 10+00 to 12+00), include the total footage (200 LF)
- DO NOT spell out acronyms. "BMP" stays "BMP."

HOURS LOOKUP PRIORITY — READ THIS CAREFULLY:
Timesheets often have a table where one person works across MULTIPLE tasks, with hours per-task AND a separate "Total" column.
ALWAYS use the TOTAL HOURS column for each person — NOT a single task-row value.
1. FIRST — look for "Total", "Total Hours", "Daily Total", or "Sum" column → USE IT
2. SECOND — if no total column, SUM all individual task-row hours for that person
3. THIRD — check the scanned summary text for any hours mentioned
4. FALLBACK — use start/stop time difference

CRITICAL — DO NOT SKIP PAGES:
- Process EVERY page of the document.
- If a page has data (names, hours, dates, descriptions), it MUST appear in the output.
- Output ALL tasks for ALL pages into the single activity.

Return JSON format:
{{
    "activities": [
        {{
            "work_area": "Station 10+50 - OHL - Grading",
            "summary_html": "• Bullet point description.\\n• Another bullet.",
            "manpower": [...],
            "equipment": [...]
        }}
    ]
}}
"""

EXTRA_WORK_PROMPT = """You are analyzing an EXTRA WORK TICKET form (handwritten or printed).

TASK: Extract all labor and equipment entries from this Extra Work form.
CRITICAL: Mark ALL entries with "is_extra_work": true.

ABBREVIATION & ROLE PARSING RULES:
- "FM" → Foreman
- "JM" → Journeyman (e.g. Journeyman Operator, Journeyman Laborer)
- "LB" → Laborer
- "OP" → Operator
- If "Operator" is followed by "FM", it's a Foreman.
- If "Operator" is followed by "JM", it's a Journeyman Operator.

RETURN JSON:
{
    "summary_html": "• Summary of the extra work performed.",
    "manpower": [
        {"trade": "Operator", "name": "John Doe (JM)", "company": "", "qty": 1, "hours": 8,
         "start_time": "7:00 AM", "stop_time": "3:30 PM", "is_extra_work": true, "is_3rd_party": false}
    ],
    "equipment": [
        {"name": "CAT 330", "description": "Excavator", "company": "", "qty": 1, "hours": 8,
         "start_time": "7:00 AM", "stop_time": "3:30 PM", "is_extra_work": true, "is_rental": false}
    ]
}
"""

CONSULTANT_PROMPT = """You are analyzing a CONSULTANT SITE VISIT RECORD form (handwritten or printed).

TASK: Extract all consultant entries from this form.

CRITICAL:
- Mark ALL entries with "is_consultant": true
- CALCULATE hours from time blocks (e.g., "7:00 AM to 11:00 AM" = 4 hours)

EXTRACT:
1. Consultant name or role (Native American Monitor, Inspector, Geotechnical, Environmental, etc.)
2. Time in / Time out → Calculate hours
3. Brief description of what they observed or did

RETURN JSON:
{
    "description": "Summary of consultant activities",
    "manpower": [
        {"name": "Native American Monitor", "trade": "Native American Monitor", "qty": 1, "hours": 4, "is_consultant": true},
        {"name": "Geotechnical Inspector", "trade": "Geotechnical Inspector", "qty": 1, "hours": 8, "is_consultant": true}
    ]
}

NOTE: Consultants only go in the manpower list, not equipment.
"""


# ============================================
# HELPERS
# ============================================

def _clean_json(text: str) -> dict[str, Any]:
    """Strip markdown fencing and extract the JSON object."""
    text = re.sub(r'```json\s*', '', text)
    text = re.sub(r'```\s*', '', text)
    if '{' in text:
        text = text[text.find('{'):]
    if '}' in text:
        text = text[:text.rfind('}') + 1]
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        # "Extra data" means valid JSON followed by more text.
        # Extract the first complete top-level JSON object via brace counting.
        logger.warning(f'[_clean_json] Initial parse failed ({e}), trying brace-count extraction')
        start = text.find('{')
        if start == -1:
            raise
        depth = 0
        in_string = False
        escape = False
        for i in range(start, len(text)):
            c = text[i]
            if escape:
                escape = False
                continue
            if c == '\\':
                escape = True
                continue
            if c == '"' and not escape:
                in_string = not in_string
                continue
            if in_string:
                continue
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return json.loads(text[start:i + 1])
        raise


def _clean_summary_bullets(text: str) -> str:
    """
    Ensures summary text uses plain text bullet points starting with '• ' instead of HTML tags (<ul>, <li>, etc.).
    Converts <li>, <p>, <br> to newline bullets and strips all remaining HTML tags.
    """
    if not text or not isinstance(text, str):
        return ""

    t = text

    # Convert <li> tags to newlines with bullet character
    t = re.sub(r"<li[^>]*>", "\n• ", t, flags=re.IGNORECASE)
    # Convert block-closing tags and <br> to newlines
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.IGNORECASE)
    t = re.sub(r"</(?:p|div|li|tr|ul|ol)>", "\n", t, flags=re.IGNORECASE)
    # Remove all remaining HTML tags
    t = re.sub(r"<[^>]+>", "", t)
    # Decode common HTML entities
    t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&quot;", '"')

    # Process lines: trim each line and ensure bullet format
    raw_lines = [line.strip() for line in t.split("\n")]
    cleaned_lines = []
    for line in raw_lines:
        if not line:
            continue
        # Strip existing bullet markers (•, -, *, –) or numbered lists (e.g. 1., 2.)
        line_content = re.sub(r"^[•\-\*\–\d+\.]\s*", "", line).strip()
        if line_content:
            cleaned_lines.append(f"• {line_content}")

    return "\n".join(cleaned_lines)


def _convert_heic_to_jpeg(content: bytes) -> bytes:
    """Convert HEIC/HEIF to JPEG for Gemini compatibility."""
    try:
        import pillow_heif
        from PIL import Image
        pillow_heif.register_heif_opener()
        img = Image.open(io.BytesIO(content))
        out = io.BytesIO()
        img.save(out, format='JPEG', quality=90)
        return out.getvalue()
    except Exception as e:
        logger.warning(f"HEIC conversion failed: {e} — sending original bytes")
        return content


def _aggregate_extra_work(raw: dict[str, Any]) -> dict[str, Any]:
    """
    Merge duplicate workers on the same Extra Work ticket.
    Same Name + Trade → sum hours, keep qty = 1.
    WHY: Tickets often list the same person across multiple task rows.
    """
    aggregated_mp: dict[str, Any] = {}
    for entry in raw.get('manpower', []):
        trade = (entry.get('trade') or entry.get('name') or 'Unknown').strip()
        name = (entry.get('name') or '').strip()
        key = f"{trade}|{name}"
        if key in aggregated_mp:
            aggregated_mp[key]['hours'] += float(entry.get('hours', 0))
            aggregated_mp[key]['qty'] = 1  # Always 1 per named person
        else:
            entry['is_extra_work'] = True
            entry['qty'] = 1
            aggregated_mp[key] = entry

    aggregated_eq: dict[str, Any] = {}
    for entry in raw.get('equipment', []):
        name = (entry.get('name') or entry.get('description') or 'Unknown').strip()
        if name in aggregated_eq:
            aggregated_eq[name]['hours'] += float(entry.get('hours', 0))
        else:
            entry['is_extra_work'] = True
            aggregated_eq[name] = entry

    return {
        'summary_html': _clean_summary_bullets(raw.get('summary_html', raw.get('description', ''))),
        'manpower': list(aggregated_mp.values()),
        'equipment': list(aggregated_eq.values()),
    }


# ============================================
# ENDPOINT: Scan Notes / Timesheet
# ============================================

class ScanResponse(BaseModel):
    activities: list[dict[str, Any]]


class ScanRequest(BaseModel):
    merge: bool = True


class TranscribeRequest(BaseModel):
    audio_data: str    # base64-encoded audio
    mime_type: str = 'audio/webm'
    context: dict[str, Any] = {}


class TranscribeResponse(BaseModel):
    activities: list[dict[str, Any]]
    raw_transcription: str = ''


@router.post('/scan-notes', response_model=ScanResponse)
async def scan_notes(
    images: list[UploadFile] = File(...),
    merge: bool = Form(True),
):
    """
    Scan handwritten notes, timesheets, PDFs — any construction field document.
    merge=True  → all files in one call → one combined activity (default)
    merge=False → one Gemini call per file → one activity per file (split mode)
    Supports: JPEG, PNG, PDF, HEIC/HEIF.
    """
    if not images:
        raise HTTPException(status_code=400, detail='No files provided')

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        # Pre-read and normalise all uploads
        file_parts: list[tuple[str, genai_types.Part]] = []
        for upload in images:
            content = await upload.read()
            mime_type = upload.content_type or 'image/jpeg'

            if mime_type in ('image/heic', 'image/heif') or \
               (upload.filename or '').lower().endswith(('.heic', '.heif')):
                logger.info(f'[scan-notes] Converting HEIC: {upload.filename}')
                content = _convert_heic_to_jpeg(content)
                mime_type = 'image/jpeg'

            if (upload.filename or '').lower().endswith('.pdf'):
                mime_type = 'application/pdf'

            file_parts.append((
                upload.filename or 'file',
                genai_types.Part.from_bytes(data=content, mime_type=mime_type),
            ))

        logger.info(f'[scan-notes] merge={merge}, files={[n for n, _ in file_parts]}')

        def _run_gemini(parts_list: list) -> list[dict[str, Any]]:
            resp = _gemini_call_with_retry(
                client,
                model_name,
                contents=[NOTE_SCAN_PROMPT] + parts_list,
                config=genai_types.GenerateContentConfig(
                    thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                    response_mime_type='application/json',
                    max_output_tokens=65536,
                ),
            )
            data = _clean_json(resp.text)
            result = data.get('activities', [])
            logger.info(f'[scan-notes] call returned {len(result)} activities')
            if not result:
                logger.warning(f'[scan-notes] zero activities, raw: {resp.text[:300]}')
            return result

        if merge:
            # All files together → one combined activity
            activities = _run_gemini([part for _, part in file_parts])
        else:
            # Each file separately → one activity per file
            activities = []
            for fname, part in file_parts:
                logger.info(f'[scan-notes] split: {fname}')
                activities.extend(_run_gemini([part]))

        logger.info(f'[scan-notes] total activities: {len(activities)}')
        return ScanResponse(activities=activities)

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[scan-notes] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Scan Extra Work Ticket
# ============================================

@router.post('/scan-extra-work')
async def scan_extra_work(
    file: UploadFile = File(...),
    target_date: str = Form(None),
):
    """
    Scan an Extra Work Ticket form.
    All entries are flagged is_extra_work=True.
    If target_date (YYYY-MM-DD) is provided, only processes matching date.
    Aggregates duplicate workers by name+trade (same person, multiple task rows).
    """
    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        content = await file.read()
        mime_type = file.content_type or 'image/jpeg'

        if (file.filename or '').lower().endswith('.pdf'):
            mime_type = 'application/pdf'

        date_clause = f'\nTarget Report Date: {target_date}\n\nDATE FILTERING: Only process tickets matching {target_date}. If date does not match, skip that ticket.\n' if target_date else '\nNo date filter — extract all entries.\n'

        prompt = EXTRA_WORK_PROMPT + date_clause

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[prompt, genai_types.Part.from_bytes(data=content, mime_type=mime_type)],
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type='application/json',
            ),
        )

        raw = _clean_json(response.text)
        result = _aggregate_extra_work(raw)

        logger.info(f'[scan-extra-work] Extracted {len(result["manpower"])} manpower, {len(result["equipment"])} equipment')
        return result

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[scan-extra-work] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Scan Consultant Site Visit Record
# ============================================

@router.post('/scan-consultant')
async def scan_consultant(file: UploadFile = File(...)):
    """
    Scan a Consultant Site Visit Record.
    All entries flagged is_consultant=True.
    Hours calculated from time-in/time-out blocks.
    """
    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        content = await file.read()
        mime_type = file.content_type or 'image/jpeg'

        if (file.filename or '').lower().endswith('.pdf'):
            mime_type = 'application/pdf'

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[CONSULTANT_PROMPT, genai_types.Part.from_bytes(data=content, mime_type=mime_type)],
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type='application/json',
            ),
        )

        data = _clean_json(response.text)

        # Enforce is_consultant=True on all returned entries
        for entry in data.get('manpower', []):
            entry['is_consultant'] = True

        logger.info(f'[scan-consultant] Extracted {len(data.get("manpower", []))} consultant entries')
        return data

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[scan-consultant] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Voice Dictation → Activities
# ============================================

@router.post('/transcribe', response_model=TranscribeResponse)
async def transcribe(request: TranscribeRequest):
    """
    Transcribe base64-encoded voice recording and extract structured activities.

    TWO-PASS APPROACH (prevents hallucination):
      Pass 1 — TEXT MODE: Transcribe the audio faithfully using the battle-tested
               DICTATION_SYSTEM_PROMPT. No JSON forcing = model focuses on accuracy.
      Pass 2 — JSON MODE: Take the verified transcription text and parse it into
               structured activities (work_area, manpower, equipment).

    WHY NOT ONE PASS: Forcing JSON output while transcribing audio causes the model
    to prioritize filling the JSON schema over faithful transcription. It hallucinates
    plausible-sounding construction content instead of transcribing what was said.
    """
    if not request.audio_data:
        raise HTTPException(status_code=400, detail='No audio data provided')

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        audio_bytes = _decode_audio(request.audio_data)
        logger.info(f'[transcribe] Audio: {len(audio_bytes)} bytes, mime: {request.mime_type}')

        context = request.context or {}
        project_name = context.get('project_name', 'this project')
        report_date = context.get('report_date', 'today')

        # ─── PASS 1: Faithful transcription (shared hardened helper) ───
        # Text mode, retry, finish-reason checks and the short-transcript
        # sanity gate all live in _transcribe_audio, so every audio flow in
        # this file fails the same way instead of fabricating.
        pass1 = _transcribe_audio(
            client, model_name, audio_bytes, request.mime_type,
            duration_seconds=float(context.get('duration_seconds') or 0),
            extra_instructions=(
                f'PROJECT CONTEXT:\n- Project: {project_name}\n- Date: {report_date}'
            ),
        )

        raw_transcription = pass1.transcription
        logger.info(f'[transcribe] Pass 1 ({pass1.status}, {len(raw_transcription)} chars)')

        if pass1.status == 'failed':
            return TranscribeResponse(
                activities=[],
                raw_transcription=raw_transcription or pass1.reason
                or 'Could not understand the recording. Please try again.',
            )
        if pass1.status == 'suspect':
            logger.warning(f'[transcribe] Suspect transcription: {pass1.reason}')
            return TranscribeResponse(activities=[], raw_transcription=raw_transcription)

        # ─── PASS 2: Parse transcription into structured activities (JSON mode) ───
        # Now we have verified text. Parse it into the activity schema.
        pass2_prompt = f"""You are a construction field data parser. You will receive a text transcription of field notes.

TASK: Parse the transcription below into structured JSON activities.

RULES:
1. DO NOT add any information that is not in the transcription.
2. DO NOT fabricate details, names, equipment, or hours that were not explicitly mentioned.
3. If the transcription mentions multiple work areas or locations, create a separate activity for each.
4. If no manpower or equipment is mentioned, leave those arrays empty.
5. The summary_html should use the EXACT text from the transcription (organized into bullets), not a rewrite.
6. Use "•" (bullet character) for all bullets. Never use asterisks or dashes.

{STANDARD_EXTRACTION_RULES}

TRANSCRIPTION TO PARSE:
\"\"\"
{raw_transcription}
\"\"\"

Return JSON:
{{
    "activities": [
        {{
            "work_area": "Location - Company - Work Type",
            "summary_html": "• Bullet from transcription.\\n• Another bullet from transcription.",
            "manpower": [...],
            "equipment": [...]
        }}
    ]
}}
"""

        logger.info('[transcribe] Pass 2: Structuring into activities (JSON mode)...')
        pass2_response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[pass2_prompt],
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type='application/json',
                max_output_tokens=32768,
            ),
        )

        data = _clean_json(pass2_response.text)
        activities = data.get('activities', [])

        logger.info(f'[transcribe] Pass 2 result: {len(activities)} activities extracted')
        for i, act in enumerate(activities):
            logger.info(f'[transcribe]   Activity {i}: work_area="{act.get("work_area", "")}", '
                        f'manpower={len(act.get("manpower", []))}, '
                        f'equipment={len(act.get("equipment", []))}')

        return TranscribeResponse(activities=activities, raw_transcription=raw_transcription)

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[transcribe] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# CONSTRUCTION VOCABULARY (shared by smart dictation + AI assistant)
# Ported verbatim from legacy app — field-tuned over many sessions.
# ============================================

CONSTRUCTION_VOCAB = """
PREFERRED TERMINOLOGY:
- Excavation, Backfill, Embedment, Shoring, Trench Box
- Restrained Joint, Thrust Block, Line and Grade, Invert Elevation
- CLSM (Control Low Strength Material), Slurry, Paving
- Dewatering, Sump Pump, BMPs (Best Management Practices)
- High Line, Lateral, Tie-in, Coupling
- RFI (Request for Information), Submittal, Non-Compliance

Pipe types: RCP, HDPE, PVC, DIP (ductile iron), VCP, CMP, CIPP, steel casing
Activities: trenching, pipe laying, pipe pull, bell-and-spigot, fusion welding, tie-in,
  tap, tapping sleeve, air test, hydrostatic test, CCTV inspection, manhole installation,
  vault construction, shoring, dewatering, backfill, compaction, subgrade prep, paving,
  AC overlay, slurry seal, traffic control, potholing, SUE
Equipment context: excavator in trench = trenching/pipe install; loader = backfill/material;
  boom truck near manhole = manhole setting; dewatering pump = dewatering
Specs: lifts, bedding material, pipe zone, trench width, invert elevation, CLSM, slurry,
  native material, imported material
Testing: compaction test, proctor, nuclear density gauge, air test, pressure test,
  hydro test, mandrel test, video inspection, deflection test

TRADE ABBREVIATIONS:
- FM → Foreman, JM → Journeyman, LB → Laborer, OP → Operator
"""

# ============================================
# DICTATION SYSTEM PROMPT
# Ported verbatim — DO NOT simplify.
# WHY: This prompt was iterated over field sessions to produce authentic
#      construction-industry prose without AI filler or fabricated details.
# ============================================

DICTATION_SYSTEM_PROMPT = """You are an expert Pipeline Construction Inspector writing for a formal Daily Inspection Report.

TASK: You will receive an AUDIO RECORDING of a field inspector describing work for a daily report.

YOUR JOB IS SIMPLE — TRANSCRIBE AND POLISH. That's it.

WHAT YOU MUST DO:
1. Transcribe EVERYTHING the user says — every detail, every piece of information.
2. Clean up sentence structure and grammar so it reads professionally.
3. Apply proper punctuation (periods, commas, semicolons).
4. Use correct pipeline/construction industry terminology where appropriate.
5. Rearrange words only when needed for clarity — do NOT change the meaning.

OUTPUT FORMAT — ORGANIZE INTO SECTIONS:
Separate the transcribed content into three labeled sections. Only include a section if the user mentioned relevant details.
IMPORTANT: Use the ACTUAL bullet character "•" for ALL bullet points. NEVER use asterisks (*) or dashes (-) as bullet markers.

WORK DESCRIPTION:
STATIONS: [Station range if mentioned, e.g. "Sta 100+00 to 101+50" — put on its own line]
• [Bullet points describing traffic control, work performed, observations, progress, etc.]

MANPOWER:
• [Trade/Role] - [Name if mentioned] - [Quantity] - [Hours] - [Company if mentioned] - [Start Time if mentioned] - [Stop Time if mentioned] - [Pay rate if mentioned (ST/OT/DT)] - [Flags: Extra Work / 3rd Party / Consultant if mentioned]
• Example: Laborer - 4 - 8 hrs - OHL - 7:00 AM - 3:30 PM - Straight Time
• Example: Operator - Joe - 1 - 10 hrs - Kiewit - 6:00 AM - 4:30 PM - Double Time - Extra Work
• Example: Survey Crew - 2 - 8 hrs - Psomas - 7:00 AM - 3:30 PM - 3rd Party

EQUIPMENT:
• [Equipment type] - [Description/Name if mentioned] - [Quantity] - [Hours] - [Company if mentioned] - [Start Time if mentioned] - [Stop Time if mentioned] - [Flags: Rental / Extra Work / 3rd Party if mentioned]
• Example: Excavator - CAT 330 - 1 - 8 hrs - OHL - 7:00 AM - 3:30 PM
• Example: Dump Truck - 2 - 6 hrs - Kiewit - 6:00 AM - 12:00 PM - Rental
• Example: Vac Truck - Badger - 1 - 8 hrs - Clean Earth - 7:00 AM - 3:30 PM - 3rd Party, Rental

CRITICAL — WHAT YOU MUST NOT DO:
- DO NOT summarize or compress. If the user spoke 8 sentences of detail, output 8 sentences (or more) of detail.
- DO NOT remove context. If they described traffic control setup, manpower counts, equipment used, work performed — ALL of it must appear in your output.
- DO NOT add context, facts, or details the user did not say.
- DO NOT collapse multiple distinct points into a single short sentence.
- DO NOT use vague generalizations to replace specific details the user provided.
- DO NOT remove quantities, counts, hours, station numbers, pipe sizes, or any numerical detail.
- DO NOT mix manpower/equipment into the work description. They go in their own sections.

WHAT YOU ARE ALLOWED TO DO:
- You CAN rearrange text and add connecting words to make the spoken notes make sense and read properly.

TERMINOLOGY PREFERENCES:
- excavation, trench excavation, shoring installed/set, trench box, bedding placed, embedment placed
- pipe was set to line and grade, joint alignment verified, restrained joint, thrust block placed
- backfill placed in lifts and compacted, compaction verified, spoils hauled/off-hauled
- dewatering performed, sump pump utilized, trench safety per Cal/OSHA
- stationing format: Sta 100+00 to 101+50

PAY RATE vs SCOPE — IMPORTANT DISTINCTION:
- "Double Time", "OT", "Overtime" = Pay Rate detail. NOT Extra Work.
- "Extra Work", "T&M" = Scope change. Only label as such if user explicitly says those words.

HANDLING UNINTELLIGIBLE WORDS:
If a specific word or phrase is unintelligible:
- DO NOT guess or fabricate it.
- Keep the words around it and put "_____" where the word should be.
- Do NOT add a sentence asking for it. The blank is the marker; the inspector is
  asked about it later, before the report is written.
- Example: "• The trench was excavated to 5 feet. We encountered a _____ pipe. We stopped work immediately."

IF THE INSPECTOR TALKS TO YOU INSTEAD OF DICTATING:
Mid-recording they may stop describing work and address you directly — asking what
something is called, telling you to look something up, or thinking out loud about
how to word it.
- Do NOT answer, and do NOT treat it as work that happened.
- Transcribe what they asked, on its own line, prefixed exactly: "[ASIDE] "
- Example: "[ASIDE] I can't remember what that valve assembly is called, look into that."
- Everything else in the recording is still transcribed normally.

If the entire audio is completely silent or unintelligible, output EXACTLY this:
| Please try again, I couldn't hear you.
"""


# ============================================
# ENDPOINT: Smart Dictation (per-activity, structured JSON)
# Button: "Dictate" inside an open activity
# WHY SEPARATE FROM /transcribe: This returns structured JSON (summary_html +
#   manpower[] + equipment[]) that auto-fills the activity tables.
#   The plain /transcribe returns formatted text for the user to review first.
# ============================================

class SmartDictationRequest(BaseModel):
    audio_data: str       # base64
    mime_type: str = 'audio/webm'
    context: dict[str, Any] = {}


class SmartDictationResponse(BaseModel):
    summary_html: str = ''
    work_area: str = ''
    manpower: list[dict[str, Any]] = []
    equipment: list[dict[str, Any]] = []
    # What the model actually heard. Surfaced so a bad recording shows up as
    # visibly wrong text instead of silently becoming invented activity data.
    raw_transcription: str = ''


@router.post('/transcribe-smart', response_model=SmartDictationResponse)
async def transcribe_smart(request: SmartDictationRequest):
    """
    Smart dictation: audio → structured JSON for a SINGLE activity.
    Used by the "Dictate" button inside an open activity editor.
    Returns summary_html + manpower/equipment arrays that populate directly.

    TWO-PASS APPROACH (prevents hallucination):
      Pass 1 — TEXT MODE: Transcribe the audio faithfully. No JSON forcing.
      Pass 2 — JSON MODE: Parse the verified transcription into structured fields.

    WHY NOT ONE PASS: Forcing JSON output while transcribing audio causes the model
    to prioritize filling the JSON schema over faithful transcription. It fabricates
    plausible-sounding construction content instead of transcribing what was said.
    """
    if not request.audio_data:
        raise HTTPException(status_code=400, detail='No audio data provided')

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        audio_bytes = _decode_audio(request.audio_data)
        logger.info(f'[transcribe-smart] Audio: {len(audio_bytes)} bytes, mime: {request.mime_type}')

        ctx = request.context or {}
        work_area = ctx.get('work_area', '')
        project_name = ctx.get('project_name', 'this project')
        report_date = ctx.get('report_date', 'today')

        # ─── PASS 1: Faithful transcription (shared hardened helper) ───
        pass1 = _transcribe_audio(
            client, model_name, audio_bytes, request.mime_type,
            duration_seconds=float(ctx.get('duration_seconds') or 0),
            extra_instructions=(
                f'PROJECT CONTEXT:\n- Project: {project_name}\n- Date: {report_date}\n'
                f"- Current work area: {work_area or 'Not specified'}\n\n"
                'VERBOSITY RULE: Capture EVERY detail the speaker mentions. Do NOT '
                'summarize or compress. If they speak 10 sentences of detail, output '
                '10 sentences of detail. More is better than less.'
            ),
        )

        raw_transcription = pass1.transcription
        logger.info(f'[transcribe-smart] Pass 1 ({pass1.status}, {len(raw_transcription)} chars)')

        # Never parse audio we could not read — that is where fabrication starts.
        if pass1.status in ('failed', 'suspect'):
            if pass1.status == 'suspect':
                logger.warning(f'[transcribe-smart] Suspect transcription: {pass1.reason}')
            return SmartDictationResponse(
                summary_html='', work_area='', manpower=[], equipment=[],
                raw_transcription=raw_transcription or pass1.reason,
            )

        # ─── PASS 2: Parse transcription into SINGLE activity JSON ───
        # NOTE: Using string concat (not f-string) because raw_transcription
        # may contain literal { } that break f-string parsing.
        pass2_prompt = (
            'You are a construction field data parser. Parse the transcription below into a SINGLE activity JSON object.\n\n'
            'CRITICAL RULES:\n'
            '1. This is for ONE activity only. Do NOT create multiple activities.\n'
            '2. DO NOT add any information that is not in the transcription. DO NOT fabricate details.\n'
            '3. The summary_html MUST contain EVERY detail from the transcription — do NOT summarize or compress.\n'
            '   If the transcription has 8 bullet points of detail, the summary_html must have at least 8 bullet points.\n'
            '4. EXTRACT manpower and equipment into their JSON arrays. Remove resource counts from summary_html.\n'
            '5. Use the \u2022 (bullet) character for all bullets in summary_html. Never asterisks or dashes.\n'
            '6. Keep ALL station numbers, measurements, quantities, pipe sizes, and specific details.\n'
            '7. Do NOT use HTML tags (<p>, <ul>, <li>, etc.). Use PLAIN TEXT with \u2022 bullet characters separated by newlines.\n'
            '8. COMPANY NAMES ARE CRITICAL: When the speaker mentions a company, contractor, or subcontractor name, ALWAYS include it in the "company" field of EVERY manpower and equipment row for that company. Never leave company blank if it was spoken.\n'
            '9. TIME FORMAT: Use standard 12-hour AM/PM format (e.g., "7:00 AM", "3:30 PM"). NEVER use military/24-hour time (e.g., NOT "15:00" or "0700").\n\n'
            'TRANSCRIPTION TO PARSE:\n'
            '---\n'
            + raw_transcription + '\n'
            '---\n\n'
            'Return a JSON object with exactly these fields:\n'
            '- "work_area": string (Location - Company - Work Type, e.g. "Station 10+50 - OHL - Pipe Installation"). Use: "' + (work_area or 'Not specified') + '"\n'
            '- "summary_html": string (PLAIN TEXT, not HTML. Each detail on its own line starting with \u2022 character. Example: "\u2022 Crew excavated from Sta 10+00 to 12+50\\n\u2022 Installed 200 LF of 12-inch DIP")\n'
            '- "manpower": array of objects, each with: trade (string), name (string), company (string — MUST include if speaker mentioned it), qty (number), hours (number), start_time (string, AM/PM format), stop_time (string, AM/PM format), is_extra_work (boolean), is_3rd_party (boolean), is_consultant (boolean)\n'
            '- "equipment": array of objects, each with: name (string, specific unit), description (string, equipment type), company (string — MUST include if speaker mentioned it), qty (number), hours (number), start_time (string, AM/PM format), stop_time (string, AM/PM format), is_extra_work (boolean), is_3rd_party (boolean), is_rental (boolean)\n'
        )

        logger.info('[transcribe-smart] Pass 2: Parsing into single activity JSON...')
        pass2_response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[pass2_prompt],
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type='application/json',
                max_output_tokens=32768,
            ),
        )

        data = _clean_json(pass2_response.text)
        logger.info(f'[transcribe-smart] Pass 2 result: '
                    f'summary={len(data.get("summary_html", ""))} chars, '
                    f'manpower={len(data.get("manpower", []))}, '
                    f'equipment={len(data.get("equipment", []))}')

        return SmartDictationResponse(**{k: data.get(k, v) for k, v in SmartDictationResponse().model_dump().items()})

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[transcribe-smart] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: AI Assistant — Step 1: Analyze Notes
# Button: "AI Assistant" → first call
# WHY: Checks what's already filled in the activity (manpower, date, location)
#      and asks ONLY about what's missing. Avoids redundant questions.
# ============================================

class AnalyzeRequest(BaseModel):
    text: str
    work_area: str = ''
    context: dict[str, Any] = {}   # has_who, has_when, has_where, manpower_summary, etc.
    chat_history: list[dict[str, str]] = []  # [{"role": "user"|"assistant", "content": "..."}]


@router.post('/analyze-questions')
async def analyze_questions(request: AnalyzeRequest):
    """
    AI Assistant Step 1 — Identify what's missing from the notes.
    Returns targeted questions for ONLY the missing elements (who/where/when/what).
    If everything is filled, returns an empty questions array immediately (no LLM call).
    """
    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        ctx = request.context or {}

        # Evaluate what's already filled
        filled: list[str] = []
        missing: list[str] = []

        if ctx.get('has_who'):
            filled.append(f"WHO: {ctx.get('manpower_summary', 'manpower entered')}, {ctx.get('equipment_summary', 'equipment entered')}")
        else:
            missing.append('who')

        if ctx.get('has_when'):
            filled.append(f"WHEN: {ctx.get('report_date', 'date set')}, {ctx.get('start_time', '')} – {ctx.get('end_time', '')}")
        else:
            missing.append('when')

        if ctx.get('has_where') or request.work_area:
            filled.append(f"WHERE: {request.work_area or 'work area set'}")
        else:
            missing.append('where')

        if ctx.get('has_what') and len((request.text or '').strip()) > 20:
            filled.append('WHAT: notes describe the work')
        else:
            missing.append('what')

        # Fast path — everything is filled
        if not missing:
            logger.info('[analyze-questions] All elements filled — skipping LLM')
            return {'status': 'success', 'missing_elements': [], 'analysis_summary': 'All information is present. Ready to generate.', 'questions': [], 'photo_reminder': False}

        filled_str = '\n'.join(filled) if filled else 'None'
        missing_str = ', '.join(missing)

        system_prompt = """You are a Construction Resident Engineer reviewing field notes.
TASK: Identify ONLY the missing elements and ask short targeted questions.

ABSOLUTE RULES:
1. The "ALREADY FILLED" section lists elements that EXIST in the database — do NOT ask about them.
2. ONLY ask about elements listed in "MISSING ELEMENTS".
3. If "MISSING ELEMENTS" is empty, return an empty questions array.
4. Keep analysis_summary under 50 words. Keep questions short and field-appropriate.
5. WHO is filled if manpower/equipment is entered. Do NOT ask about crew if WHO is filled.
6. WHEN is filled if a report date exists. Do NOT ask about time/date if WHEN is filled."""

        user_prompt = f"""ALREADY FILLED (DO NOT ASK ABOUT):
{filled_str}

MISSING ELEMENTS (ASK ONLY ABOUT THESE): {missing_str}

Work Area: {request.work_area or 'Not specified'}
Notes: "{request.text}"

Return JSON:
{{"missing_elements": [...], "analysis_summary": "short summary", "questions": [{{"id": "q1", "element": "manpower|equipment|time|work_area", "question": "short question", "shortLabel": "LABEL"}}], "photo_reminder": true/false}}"""

        # Build contents with conversation history for multi-turn memory
        contents = [system_prompt]
        for msg in request.chat_history:
            role = 'user' if msg.get('role') == 'user' else 'model'
            contents.append(genai_types.Content(role=role, parts=[genai_types.Part.from_text(text=msg.get('content', ''))]))
        contents.append(user_prompt)

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type='application/json',
                max_output_tokens=1000,
            ),
        )

        data = _clean_json(response.text)

        # Safety filter: remove any question the LLM generated about already-filled elements
        filled_types = set()
        if ctx.get('has_who'):
            filled_types.update(['who', 'manpower', 'equipment'])
        if ctx.get('has_when'):
            filled_types.update(['when', 'time', 'date'])
        if ctx.get('has_where') or request.work_area:
            filled_types.update(['where', 'work_area', 'location'])
        if ctx.get('has_what'):
            filled_types.update(['what', 'description', 'work'])

        filtered_q = [q for q in data.get('questions', []) if q.get('element', '').lower() not in filled_types]
        data['questions'] = filtered_q
        data['status'] = 'success'

        logger.info(f'[analyze-questions] {len(filtered_q)} questions returned, missing={missing}')
        return data

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[analyze-questions] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: AI Assistant — Step 2: Generate Report Text
# Button: "AI Assistant" → second call (after user answers questions)
# WHY: Takes rough notes + user answers and produces polished bullet-point text.
#      Persona is a 20-year inspector — factual, not corporate.
# ============================================

class GenerateReportRequest(BaseModel):
    original_text: str
    answers: dict[str, str] = {}
    work_area: str = ''
    context: dict[str, Any] = {}
    chat_history: list[dict[str, str]] = []  # [{"role": "user"|"assistant", "content": "..."}]


@router.post('/generate-report')
async def generate_report(request: GenerateReportRequest):
    """
    AI Assistant Step 2 — Generate polished report text from rough notes + answers.
    Does NOT fabricate details. Only structures what the user explicitly provided.
    """
    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        answers_text = '\n'.join(f'- {k}: {v}' for k, v in (request.answers or {}).items() if v.strip())

        system_prompt = """You are a 20+ year pipeline and water conveyance inspector with hands-on field experience. You are also a professional at writing construction daily reports for Resident Engineers.

Your task: take the inspector's rough notes (some produced with voice-to-text, so errors may be present) and create a polished, professional report entry.

FORMAT REQUIREMENTS:
- Use bullet points (• character)
- Be concise but complete without adding any assumed information.
- Include quantities, measurements, station numbers, and reference numbers you receive. Do NOT add anything not provided.
- Use proper construction terminology
- Write in past tense
- Focus on WHAT was accomplished, not WHO or WHEN (those are in separate fields)

STYLE:
- Professional, neutral tone
- No subjective opinions or evaluations
- Factual and precise
- Include all relevant technical details you were provided

BANNED WORDS AND PHRASES:
- NEVER use: "to facilitate", "in order to", "for the purpose of", "to ensure"
- NEVER use: "utilized" (say "used"), "commenced" (say "started"), "implement" (say "did/installed"), "establish" (say "set up")
- NEVER add filler adjectives: "existing", "current", "designated", "respective", "aforementioned"
- NEVER say something was done "properly", "correctly", "successfully", or "per specifications" unless quoting the user
- NEVER spell out acronyms the audience knows — "BMP" NOT "Best Management Practice (BMP)"

OUTPUT FORMAT — CRITICAL:
- Output ONLY bullet points starting with "• ". Zero conversational text.
- Do NOT write any introduction, preamble, or closing statement.
- Use periods at the end of every bullet.
- Write entirely in past tense."""

        user_prompt = f"""CREATE A PROFESSIONAL REPORT ENTRY FROM:

ORIGINAL NOTES:
{request.original_text}

ADDITIONAL ANSWERS:
{answers_text or '(none)'}

CONTEXT:
- Location: {request.work_area or 'Not specified'}
- Manpower: {request.context.get('manpower_summary', '')}
- Equipment: {request.context.get('equipment_summary', '')}

Generate the professional report text now (bullet points, past tense, factual):"""

        # Build contents with conversation history for multi-turn memory
        contents = [system_prompt]
        for msg in request.chat_history:
            role = 'user' if msg.get('role') == 'user' else 'model'
            contents.append(genai_types.Content(role=role, parts=[genai_types.Part.from_text(text=msg.get('content', ''))]))
        contents.append(user_prompt)

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                max_output_tokens=8192,
            ),
        )

        report_text = response.text.strip()
        # Strip any accidental markdown fencing
        report_text = re.sub(r'```[a-z]*\n?', '', report_text).strip()

        logger.info(f'[generate-report] Generated {len(report_text)} chars')
        return {'status': 'success', 'report_text': report_text}

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[generate-report] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Activity Manager Co-Pilot
# Button: "AI Manager" in the Activity List
# WHY: Allows users to modify multiple activities using natural language
# ============================================

class ActivityManagerRequest(BaseModel):
    message: str
    activities: list[dict[str, Any]]
    chat_history: list[dict[str, str]] = []

class ActivityManagerResponse(BaseModel):
    reply: str
    modified_activities: list[dict[str, Any]] | None = None

@router.post('/activity-manager', response_model=ActivityManagerResponse)
async def activity_manager(request: ActivityManagerRequest):
    """
    AI Co-Pilot that can read all activities and apply modifications based on natural language.
    Returns a conversation reply and optionally a modified activities array.
    """
    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        system_prompt = """You are the 'Activity Manager Co-Pilot', an expert AI embedded directly in a construction daily reporting app.
Your job is to help the user manipulate their daily report activities via natural language.
You receive the full list of activities currently in the report.

CRITICAL INSTRUCTIONS:
1. If the user asks a question, clarify something, or asks for advice, provide a helpful text response in the "reply" field.
2. If the user asks to modify the activities (e.g., move manpower, merge, delete, copy, create new, edit text), you must output a JSON object with two fields:
   - "reply": A short message explaining what you did (e.g. "I moved 2 laborers to activity 3.")
   - "modified_activities": The full array of activities with the requested changes applied.
3. If no modifications are made (e.g., just answering a question), return:
   {"reply": "Your message", "modified_activities": null}

RULES FOR MODIFICATION:
- Maintain all existing data that wasn't asked to be changed.
- The user can do ANYTHING: create, delete, move equipment, change hours, etc.
- If you create a new activity, follow the standard JSON schema for activities.
- Always output valid JSON matching the exact schema.

OUTPUT SCHEMA:
{
  "reply": "string",
  "modified_activities": null or [ { ...activity... }, ... ]
}
"""

        user_prompt = f"""CURRENT ACTIVITIES JSON:
{json.dumps(request.activities, indent=2)}

USER MESSAGE:
{request.message}

Return JSON:"""

        contents = [system_prompt]
        
        # Add chat history
        for msg in request.chat_history:
            role = "user" if msg.get("role") == "user" else "model"
            contents.append(genai_types.Content(role=role, parts=[genai_types.Part.from_text(text=msg.get("content", ""))]))
            
        contents.append(user_prompt)

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type='application/json',
                max_output_tokens=32768,
            ),
        )

        data = _clean_json(response.text)
        
        logger.info(f'[activity-manager] replied: {data.get("reply", "")[:50]}...')
        if data.get("modified_activities") is not None:
            logger.info(f'[activity-manager] returned modified activities')
            
        return ActivityManagerResponse(
            reply=data.get('reply', ''),
            modified_activities=data.get('modified_activities')
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[activity-manager] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Report Chat (Full Report AI Assistant)
# WHY: Single conversational interface that can manipulate the ENTIRE report
#      (general info + activities) via text or voice. Replaces standalone
#      dictation as the primary AI workflow.
#
# TWO-PASS AUDIO (prevents hallucination):
#   Pass 1 — TEXT mode: Transcribe the audio faithfully.
#   Pass 2 — JSON mode: Process the transcription as a chat message.
# ============================================

class ReportChatRequest(BaseModel):
    message: str = ''             # Text message (optional if audio_data is provided)
    audio_data: str = ''          # Base64-encoded audio (optional if message is provided)
    mime_type: str = 'audio/webm'
    duration_seconds: float = 0.0  # Enables the short-transcript sanity check
    report: dict[str, Any] = {}   # Full report: { general: {...}, activities: [...] }
    chat_history: list[dict[str, str]] = []


class ReportChatResponse(BaseModel):
    reply: str
    transcription: str = ''       # What the AI heard (only if audio was sent)
    modified_general: dict[str, Any] | None = None
    modified_activities: list[dict[str, Any]] | None = None   # Partial updates keyed by activity ID
    new_activities: list[dict[str, Any]] | None = None        # Brand new activities to add
    deleted_activity_ids: list[str] | None = None             # Activity IDs to remove


@router.post('/report-chat', response_model=ReportChatResponse)
async def report_chat(request: ReportChatRequest):
    """
    Conversational AI assistant that controls the entire daily report.
    Accepts text messages or voice recordings.

    If audio_data is provided:
      1. Transcribes faithfully (text mode, no JSON forcing)
      2. Uses the transcription as the user message
      3. Processes against the report (JSON mode)
    If only text message:
      Processes directly (JSON mode)

    Returns a reply + optional modifications to general info and/or activities.
    """
    if not request.message and not request.audio_data:
        raise HTTPException(status_code=400, detail='Provide either a text message or audio data')

    client, model_name = _get_gemini_client()

    try:
        import base64
        from google.genai import types as genai_types

        user_message = request.message
        transcription = ''

        # ─── AUDIO PROCESSING (two-pass, shared hardened helper) ───
        if request.audio_data:
            audio_bytes = _decode_audio(request.audio_data)
            logger.info(f'[report-chat] Audio received: {len(audio_bytes)} bytes, mime: {request.mime_type}')

            # The short-audio guard lives in _transcribe_audio (MIN_AUDIO_BYTES),
            # so every audio flow rejects an empty recording the same way.
            general = request.report.get('general', {}) if request.report else {}
            pass1 = _transcribe_audio(
                client, model_name, audio_bytes, request.mime_type,
                duration_seconds=float(request.duration_seconds or 0),
                extra_instructions=(
                    f"PROJECT CONTEXT:\n"
                    f"- Project: {general.get('project_name', 'this project')}\n"
                    f"- Date: {general.get('report_date', 'today')}"
                ),
            )
            transcription = pass1.transcription
            logger.info(f'[report-chat] Transcription ({pass1.status}, {len(transcription)} chars)')

            if pass1.status == 'failed':
                return ReportChatResponse(
                    reply=(
                        "I couldn't understand that recording. "
                        + (pass1.reason or 'Please try again and speak close to the mic.')
                    ),
                    transcription=transcription or '',
                )

            if pass1.status == 'suspect':
                # Report the problem instead of acting on a transcript we do
                # not trust — acting on it could silently rewrite the report.
                return ReportChatResponse(
                    reply=(
                        "I'm not confident I heard that correctly, so I haven't changed anything. "
                        + (pass1.reason or '')
                        + "\n\nHere's what I picked up — if it's right, paste or retype it and I'll apply it."
                    ),
                    transcription=transcription or '',
                )

            # Use the transcription as the user message for Pass 2
            user_message = transcription

        # ─── PROCESS MESSAGE AGAINST REPORT (JSON mode) ───
        report_data = request.report or {}
        general = report_data.get('general', {})
        activities = report_data.get('activities', [])
        schedule = report_data.get('schedule', None)

        system_prompt = """You are the 'Report Assistant', an expert AI embedded in a construction daily reporting app.
Your job is to help the user build and modify their daily field report through natural conversation.

═══════════════════════════════════════════════════════════
FIRST — WHAT KIND OF MESSAGE IS THIS?
═══════════════════════════════════════════════════════════

Decide this BEFORE you touch the report. Every message is one of three things.

1. CONTENT — the user is telling you what happened on site.
   "Two laborers on the north trench, eight hours."
   → Put it in the report.

2. INSTRUCTION — the user is talking ABOUT the report, or about what you just
   proposed. Corrections, redirections, scope changes, clarifications.
   "No, not that one." / "Add it to the second one instead." / "Both of them."
   / "That's not what I meant, I wanted it on the paving activity."
   → These words are ABOUT the report. They are NEVER text FOR the report.
     Work out what they mean, then return the corrected change.

3. CONVERSATION — a question, or thinking out loud.
   "How many hours are on Activity 2?" / "Does that look right to you?"
   → Answer it. Change nothing. All modification fields null.

THE MISTAKE YOU MUST NOT MAKE
The user pushes back on something you proposed, and you write their pushback
into the report as if it were site work.

  User: "no I need you to add the first one to the second one"
  WRONG: create an activity with summary "• Add the first one to the second one"
  RIGHT: look at what you proposed last turn, identify which two things "the
         first one" and "the second one" are, and return that merge.

If a message contains no site work — no trades, no equipment, no quantities, no
description of something that physically happened — it is almost certainly an
INSTRUCTION or a QUESTION. Treat it as one. Never manufacture an activity out of
a sentence about the conversation.

REFERENCES TO EARLIER TURNS
"the first one", "that one", "the one you just added", "both", "the last thing
you said" point at the CONVERSATION, not at the report's activity order.
Resolve them against what you proposed in previous turns. If you genuinely
cannot tell what they point at, ASK — do not guess and do not invent.

═══════════════════════════════════════════════════════════
ADDING vs REPLACING — THE OTHER THING YOU MUST GET RIGHT
═══════════════════════════════════════════════════════════

The app overwrites each field with exactly what you return. There is no merge.
So for a text field, what you return IS the new value in full.

ADD — "add", "also", "include", "and", "put ... in", "don't forget", "plus",
      "on top of that", "one more thing"
  → The existing content STAYS. Return the existing value WITH the new part
    added to it.

REPLACE — "change it to", "replace", "rewrite", "instead", "make it say",
          "take out", "remove", "scrap that"
  → Return only the new value.

WORKED EXAMPLE — this is the exact failure to avoid:
  Summary currently reads:
    • Excavated the north trench
    • Hauled off spoils
    • Set trench plates
  User: "add that they backfilled and compacted"

  WRONG — this DELETES three bullets:
    {"id": "act-1", "summary": "• Backfilled and compacted"}

  RIGHT — all four bullets:
    {"id": "act-1", "summary": "• Excavated the north trench\\n• Hauled off spoils\\n• Set trench plates\\n• Backfilled and compacted"}

The same rule governs manpower, equipment and every other array: adding a crew
member means returning the existing rows PLUS the new one, not the new one
alone.

WHEN YOU CANNOT TELL, ADD. Losing what the user already wrote is far worse than
leaving an extra line they can delete in one tap.

YOU HAVE FULL CONTROL OVER:
1. GENERAL INFO — project name, project number, project location, inspector name, resident engineer,
   report date, start time, end time, sky conditions, temperature high/low, wind info, notes
2. ACTIVITIES — each activity has: id, work_area, stations, summary (plain text bullet points starting with •),
   manpower[] (trade, name, qty, hours, start_time, stop_time, company, classification, is_3rd_party, is_extra_work, is_consultant),
   equipment[] (name, description, qty, hours, start_time, stop_time, company, is_3rd_party, is_extra_work, is_consultant, is_rental),
   extra_work_manpower[], extra_work_equipment[], consultant_manpower[]

WHAT YOU CAN DO:
- Fill in general info fields (weather, project name, dates, times, notes)
- Create new activities from descriptions of work
- Add manpower and equipment to existing activities
- Move resources between activities
- Edit summaries, work areas, hours, quantities
- Delete activities or resources
- Move activities between different reports using the "cross_report_moves" action
- Answer questions about the report
- Anything the user asks regarding the report

═══════════════════════════════════════════════════════════
CRITICAL: SURGICAL UPDATES ONLY — DO NOT REPLACE THE FULL ARRAY
═══════════════════════════════════════════════════════════

You are a SURGICAL instrument. You touch ONLY what the user explicitly asked you to change.
Everything else stays exactly as it is — you do NOT reproduce it, you do NOT return it.

RULES FOR GENERAL INFO:
- Return "modified_general" with ONLY the fields the user asked to change.
- Fields not mentioned by the user = do NOT include them.

RULES FOR EXISTING ACTIVITIES:
- Return "modified_activities" with ONLY the activities that need changes.
- Each entry MUST include the activity's "id" so the app knows which one to update.
- Include ONLY the fields that changed within that activity.
- Example: user says "change company to Picket Fences on Activity 1" →
  return [{"id": "act-1", "manpower": [... full manpower array with company changed ...]}]
- For sub-arrays (manpower, equipment, extra_work_manpower, extra_work_equipment, consultant_manpower):
  If the user's change affects rows inside a sub-array, return the COMPLETE sub-array for that
  resource type with the requested changes applied — but ONLY for the specific activity being modified.
  Sub-arrays the user did NOT mention = do NOT include them.
- Example: user says "change the summary" → return [{"id": "act-1", "summary": "new text"}]
  Do NOT include manpower, equipment, or any other field.

RULES FOR NEW ACTIVITIES:
- Put brand new activities in "new_activities" (NOT in "modified_activities").
- Generate a unique ID using the format "ai-" + current timestamp in milliseconds.
- Include all relevant fields: work_area, stations, summary, manpower[], equipment[], etc.

RULES FOR DELETING ACTIVITIES:
- Put the IDs of activities to remove in "deleted_activity_ids".

RULES FOR QUESTIONS:
- If no modifications are needed (just answering a question), set all modification fields to null.
- If the user's request is ambiguous, ASK a clarifying question. Return all modification fields as null.
  "Which activity should I update?" or "What hours did they work?" — always ask, never guess.

RULES FOR CROSS-REPORT MOVES:
- If the user asks to move an activity to a different report, put the action in "cross_report_moves".
- Provide the "source_activity_id" (from the current report) and the "target_report_id" (from the AVAILABLE REPORTS list below).

FORMATTING RULES:
- Use "•" (bullet character) for summary bullets. Never asterisks or dashes.
- Do NOT use HTML tags (<ul>, <li>, <p>, <br>, etc.). Use PLAIN TEXT with "• " (bullet character) on each line.
- Summary text: professional construction language, past tense, factual, specific.
- For sky_conditions, use objects: {"id": "sunny", "label": "Sunny", "emoji": "☀️"}.
  Valid: sunny, partly-cloudy, cloudy, overcast, rainy, windy, foggy, hot, cold.
- Hours default to 8 if not specified. Start time defaults to "7:00 AM", stop time to "3:30 PM".

PERSONA:
- Talk like a helpful construction colleague, not a corporate AI.
- Keep replies short and direct. "Got it, changed company to Picket Fences on Activity 1." not "I have successfully processed your request..."
- If something is unclear, ask. Do NOT guess.

OUTPUT JSON:
{
  "reply": "Short message about what you did or are asking",
  "modified_general": null or { "field_name": "new_value", ... },
  "modified_activities": null or [ { "id": "existing-id", ...only changed fields... } ],
  "new_activities": null or [ { full new activity objects } ],
  "deleted_activity_ids": null or [ "id-1", "id-2" ],
  "cross_report_moves": null or [ { "source_activity_id": "act-1", "target_report_id": "report-id-here" } ]
}
"""

        # ─── Inject active schedule context if present ───
        if schedule:
            schedule_context = (
                f"\n\nACTIVE SCHEDULE DATA:\n{json.dumps(schedule, indent=2)}\n"
                "Use this data when the user asks about shifts, digout locations, "
                "paving schedule, tonnage, or construction schedule. Reference "
                "specific shift numbers, DO numbers, and dimensions when relevant."
            )
            system_prompt += schedule_context
            logger.info(f'[report-chat] Schedule context injected ({len(json.dumps(schedule))} chars)')

        # ─── Inject cross-report context ───
        from app.services.database import list_reports, get_report, save_report
        all_reports = list_reports(limit=50)
        reports_summary = []
        for r in all_reports:
            reports_summary.append(f"ID: {r.get('id')} | Date: {r.get('report_date')} | Project: {r.get('project_name')}")
        reports_context = "\n".join(reports_summary)

        user_prompt = f"""AVAILABLE REPORTS (For cross-report moves):
{reports_context}

CURRENT REPORT STATE:

GENERAL INFO:
{json.dumps(general, indent=2)}

ACTIVITIES ({len(activities)} total):
{json.dumps(activities, indent=2) if activities else '(none yet)'}

USER MESSAGE:
{user_message}

Before answering: is this CONTENT (site work to record), an INSTRUCTION (about
the report or about what you just proposed), or a QUESTION? If it is an
instruction or a question, its words do not belong in any report field. And if
it asks you to ADD something, the value you return must still contain what is
already there.

Return JSON:"""

        # Build contents with chat history
        contents = [system_prompt]
        for msg in request.chat_history:
            role = 'user' if msg.get('role') == 'user' else 'model'
            contents.append(genai_types.Content(
                role=role,
                parts=[genai_types.Part.from_text(text=msg.get('content', ''))]
            ))
        contents.append(user_prompt)

        logger.info(f'[report-chat] Processing message ({len(user_message)} chars) against report '
                    f'with {len(activities)} activities...')

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type='application/json',
                max_output_tokens=65536,
            ),
        )

        data = _clean_json(response.text)

        reply = data.get('reply', '')
        modified_general = data.get('modified_general')
        modified_activities = data.get('modified_activities')
        new_activities = data.get('new_activities')
        deleted_activity_ids = data.get('deleted_activity_ids')
        cross_report_moves = data.get('cross_report_moves')

        # Execute cross-report moves
        if cross_report_moves:
            if deleted_activity_ids is None:
                deleted_activity_ids = []
            for move in cross_report_moves:
                source_id = move.get('source_activity_id')
                target_id = move.get('target_report_id')
                if source_id and target_id:
                    act_to_move = next((a for a in activities if a.get('id') == source_id), None)
                    if act_to_move:
                        target_report = get_report(target_id)
                        if target_report:
                            target_report.setdefault('activities', []).append(act_to_move)
                            save_report(target_report)
                            logger.info(f"[report-chat] Moved activity {source_id} to report {target_id}")
                            deleted_activity_ids.append(source_id)
                        else:
                            logger.warning(f"[report-chat] Target report {target_id} not found")

        # Sanitize summary bullets to plain text with dot bullets
        if modified_activities is not None:
            for act in modified_activities:
                if isinstance(act, dict):
                    if 'summary' in act and act['summary']:
                        act['summary'] = _clean_summary_bullets(str(act['summary']))
                    if 'summary_html' in act and act['summary_html']:
                        act['summary_html'] = _clean_summary_bullets(str(act['summary_html']))
        if new_activities is not None:
            for act in new_activities:
                if isinstance(act, dict):
                    if 'summary' in act and act['summary']:
                        act['summary'] = _clean_summary_bullets(str(act['summary']))
                    if 'summary_html' in act and act['summary_html']:
                        act['summary_html'] = _clean_summary_bullets(str(act['summary_html']))

        logger.info(f'[report-chat] Reply: {reply[:80]}...')
        if modified_general:
            logger.info(f'[report-chat] Modified general fields: {list(modified_general.keys())}')
        if modified_activities is not None:
            logger.info(f'[report-chat] Modified {len(modified_activities)} existing activities (partial updates)')
        if new_activities is not None:
            logger.info(f'[report-chat] Adding {len(new_activities)} new activities')
        if deleted_activity_ids is not None:
            logger.info(f'[report-chat] Deleting activity IDs: {deleted_activity_ids}')

        return ReportChatResponse(
            reply=reply,
            transcription=transcription,
            modified_general=modified_general,
            modified_activities=modified_activities,
            new_activities=new_activities,
            deleted_activity_ids=deleted_activity_ids,
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[report-chat] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))

# ============================================
# ENDPOINT: Email Summary
# Button: "📧 Email Summary" in Activity List header
# WHY: Takes all activity summaries and combines them into ONE flowing
#      narrative that reads like a professional email update — not bullet
#      fragments from separate activities.
# ============================================

class EmailSummaryRequest(BaseModel):
    activities: list[dict[str, Any]]     # Full activities array
    project_name: str = ''
    report_date: str = ''


@router.post('/email-summary')
async def email_summary(request: EmailSummaryRequest):
    """Combine all activity summaries into one cohesive email-ready narrative."""
    if not request.activities:
        raise HTTPException(status_code=400, detail='No activities to summarize')

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        # Build the input: each activity's work area + summary
        activity_blocks: list[str] = []
        for i, act in enumerate(request.activities, 1):
            work_area = act.get('work_area', f'Activity {i}')
            summary = act.get('summary', '')
            if not summary:
                continue
            activity_blocks.append(f'LOCATION: {work_area}\n{summary}')

        if not activity_blocks:
            return {'status': 'success', 'text': 'No summaries to combine — all activities are empty.'}

        combined_input = '\n\n---\n\n'.join(activity_blocks)

        system_prompt = """You are a SENIOR Pipeline Construction Inspector writing a daily progress update email.

TASK: Take the individual activity summaries below and combine them into ONE cohesive, flowing narrative.
This will be dropped directly into an email to project stakeholders, superintendents, and management.

CRITICAL RULES:
1. PRESERVE ALL CONTENT — every detail, measurement, station number, crew count, quantity, and action from every activity MUST appear in the output. Do NOT summarize, shorten, or omit anything.
2. FLOW AS ONE — the output should read as one continuous update, NOT as separate sections per activity. Transition naturally between locations and topics.
3. ORGANIZE LOGICALLY — group related work together even if it came from different activities. Flow geographically or chronologically, whichever reads better.
4. PROFESSIONAL TONE — past tense, third person, factual. Same style as a Resident Engineer's daily report.
5. NO HEADERS OR BULLETS — write in paragraph form. This is an email body, not a report form.
6. NO GREETINGS OR SIGN-OFFS — output ONLY the body text. The user will add their own greeting and signature.
7. NEUTRAL — no opinions, judgments, or evaluations. Just state what happened.

BANNED:
- "to facilitate," "in order to," "for the purpose of," "to ensure"
- "utilized" (say "used"), "commenced" (say "started")
- Filler adjectives: "existing," "current," "designated," "respective"
- Do NOT add information that isn't in the source summaries."""

        project_context = ''
        if request.project_name:
            project_context += f'\nProject: {request.project_name}'
        if request.report_date:
            project_context += f'\nDate: {request.report_date}'

        user_prompt = f"""{project_context}

ACTIVITY SUMMARIES TO COMBINE:

{combined_input}

Write the combined email body now:"""

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[system_prompt, user_prompt],
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                max_output_tokens=16384,
            ),
        )

        text = response.text.strip()
        # Clean any markdown code fences the model might wrap it in
        text = re.sub(r'```[a-z]*\n?', '', text).strip()
        logger.info(f'[email-summary] Generated {len(text)} chars from {len(activity_blocks)} activities')
        return {'status': 'success', 'text': text}

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[email-summary] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: AI Rewrite / Polish
# Button: "✨ AI Rewrite" in the activity summary toolbar
# WHY: Takes rough field notes and rewrites them into RE-quality bullets.
# ============================================

class RewriteRequest(BaseModel):
    text: str
    field_type: str = 'summary'


@router.post('/rewrite')
async def ai_rewrite(request: RewriteRequest):
    """Rewrite rough field notes into professional report bullets."""
    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        system_prompt = """You are a SENIOR Pipeline Construction Inspector with 20+ years creating formal Daily Inspection Reports for major public works and infrastructure projects.

TASK: Transform rough field notes into polished, professional inspection-report bullet points.

QUALITY STANDARDS:
1. COMPLETE SENTENCES: Every bullet is a grammatically complete, professional statement.
2. TECHNICAL PRECISION: Use correct industry terminology (excavation, embedment, restrained joint, CLSM, thrust block, line and grade, etc.).
3. OBJECTIVE TONE: Write in third person past tense. "Excavation was completed..." not "We did excavation..."
4. PRESERVE ALL DATA: Keep ALL stations, measurements, quantities, dates, and times exactly as provided. Never round or approximate.
5. FORMAT: Output ONLY bullet points starting with "• ". One complete thought per bullet.

TONE (CRITICAL):
- The author is a Resident Engineer. Verifying that work conforms to the contract
  documents is their job, and recording that verdict is the point of the report.
- KEEP every conformance statement exactly as given: "per plan", "per spec",
  "in accordance with the approved submittal", "per manufacturer data",
  "conforms", "meets", "verified", "observed", "acceptable", "rejected",
  "deficient", "non-conforming". These are professional findings, not opinions.
  NEVER delete or soften them.
- Do NOT ADD an evaluation the author did not make. If they said what was done,
  say what was done — do not decide it was proper, adequate or successful.
- Drop only bare praise with nothing to check it against: "great job",
  "excellent workmanship", "nice clean weld", "things went well".

BANNED WORDS AND PHRASES:
- NEVER use: "to facilitate," "in order to," "for the purpose of," "to ensure"
- NEVER use: "utilized" (say "used"), "commenced" (say "started"), "implement" (say "did/installed"), "establish" (say "set up")
- NEVER add filler adjectives: "existing," "current," "designated," "respective," "aforementioned"
- NEVER spell out acronyms the audience knows — "BMP" NOT "Best Management Practice (BMP)"

OUTPUT FORMAT — CRITICAL:
- Output ONLY bullet points starting exactly with "• ". Do NOT use asterisks (*) or dashes (-).
- Zero conversational text. No preamble or closing statement.
- Use periods at the end of every bullet point.
- Write entirely in past tense."""

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[
                system_prompt + _vocabulary_block(),
                f'RAW FIELD NOTES TO TRANSFORM:\n{request.text}',
            ],
            config=genai_types.GenerateContentConfig(
                # Thinking tokens are spent out of max_output_tokens. The old 4096
                # budget could be consumed entirely by thinking, leaving no answer
                # at all, so keep the output ceiling well clear of the thinking.
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                max_output_tokens=16384,
            ),
        )

        raw_text = response.text
        if not raw_text or not raw_text.strip():
            # Empty candidate — usually MAX_TOKENS or a safety block, both of
            # which used to surface as an AttributeError on None.
            finish_reason = 'unknown'
            try:
                finish_reason = str(response.candidates[0].finish_reason)
            except (AttributeError, IndexError, TypeError):
                pass
            logger.error(f'[rewrite] Model returned no text (finish_reason={finish_reason})')
            raise HTTPException(
                status_code=502,
                detail=f'The AI returned an empty response (reason: {finish_reason}). Try again.',
            )

        text = re.sub(r'```[a-z]*\n?', '', raw_text.strip()).strip()
        cleaned_text = _clean_summary_bullets(text)
        if not cleaned_text:
            logger.error(f'[rewrite] Cleaner emptied a {len(text)}-char response')
            raise HTTPException(
                status_code=502,
                detail='The AI response could not be formatted into bullets. Try again.',
            )

        logger.info(f'[rewrite] Polished {len(cleaned_text)} chars')
        return {'status': 'success', 'text': cleaned_text}

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[rewrite] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Proofread
# Button: "Check" in the activity summary toolbar
# WHY: Everything in a summary may have come from dictation, OCR or the AI
# itself, and all three produce text that reads wrong in ways the writer stops
# seeing — machine phrasing, present tense, first person, and evaluative words
# that do not belong in an inspection record. This flags them and proposes a
# fix, but changes nothing on its own: Rewrite replaces your words, this shows
# you what is wrong with them so you decide.
# ============================================

PROOFREAD_SYSTEM_PROMPT = """You are a senior Resident Engineer reviewing a daily inspection report before it is submitted to the owner. You are looking for text that would embarrass the author or create liability.

Return ONLY issues you can point at in the text. If the text is clean, return an empty list. Do NOT invent problems to seem useful — a false flag costs the writer more time than it saves.

ISSUE TYPES — use exactly these values for "issue_type":

"ai_language" — Phrasing that reads as machine-written rather than as a field inspector: "delve into", "it is worth noting", "showcasing", "seamless", "robust", "leverage", "navigate the challenges", "plays a crucial role", "stands as a testament", "in the realm of", "furthermore", "moreover", "additionally" as a sentence opener, "overall" as a summary opener. Also flag sentences that state the obvious or add no fact.

ALSO flag SPELLED-OUT ACRONYMS. Expanding an acronym the reader already knows is one of the clearest tells that a model wrote the text — an inspector writes "BMP", never "Best Management Practice (BMP)". Flag the expansion and suggest the bare acronym:
  - "Best Management Practice (BMP)" -> "BMP"
  - "Traffic Control Plan (TCP)" -> "TCP"
  - "Request for Information (RFI)" -> "RFI"
  - "asphalt concrete (AC)" -> "AC"
This applies to any industry acronym in the project vocabulary below, and to any acronym written as "Full Words (ABC)".

"judgment" — Praise or opinion with NOTHING to check it against.

READ THIS CAREFULLY. The author is a Resident Engineer. Verifying that work conforms to the contract documents IS THEIR JOB, and recording that verdict is the entire point of the report. Conformance statements are CORRECT and must NEVER be flagged:
  - "Traffic control was installed per plan." — CORRECT, do not flag.
  - "Backfill compacted per spec section 7-3." — CORRECT, do not flag.
  - "Pipe installed in accordance with the approved submittal." — CORRECT, do not flag.
  - "Shoring set per manufacturer data." — CORRECT, do not flag.
Any statement measured against a named plan, spec, submittal, permit, standard, detail or manufacturer instruction is a professional finding. Leave it alone.

Flag ONLY these two cases:
  1. Bare praise with no referent — an aesthetic verdict, not an inspection: "the crew did a great job", "excellent workmanship", "good progress", "nice clean weld", "things went well".
  2. A conformance verdict with the reference MISSING, where naming it would make the statement defensible: "the pipe was installed correctly", "compaction was adequate". Here the suggestion should ADD the reference in the author's own words — use "per plan" or "per spec" as a placeholder they will complete. Severity "low", because the finding is a prompt to cite, not an error.

Do NOT flag: "per plan", "per spec", "per the approved TCP", "in accordance with", "as required", "conforms", "meets", "verified", "confirmed", "observed", "acceptable", "rejected", "deficient", "non-conforming". These are the vocabulary of the job.

"tense" — Anything not in simple past. A daily report records work already performed. Flag present ("crew is placing"), future ("will pour"), and present perfect ("has been completed") where simple past belongs.

"person" — First person: we, I, our, us, my. Report in third person naming the actual party ("OHL", "the pipe crew").

"corporate_vocab" — Inflated words with a plain equivalent: utilized→used, commenced→started, implemented→installed, facilitated→helped, prior to→before, in order to→to, at this time→now, subsequently→then, in the event that→if.

"vague" — Unquantified where a number, station or time belongs: "some pipe", "several loads", "various locations", "a number of", "in the area", "later in the day". Field reports are evidence; quantities matter.

"station_format" — Station references not written as "Sta XX+XX" (e.g. "station 10+50", "10+50", "STA 10 + 50").

"spelling_grammar" — Actual misspellings, subject/verb disagreement, run-ons, missing punctuation. Do NOT flag technical terms, trade jargon, equipment names, abbreviations or proper nouns you do not recognise.

"repetition" — The same fact or phrasing repeated across bullets, which reads as padding.

"contradiction" — Two statements in the text that cannot both be true (conflicting times, quantities, stations, or a crew both on and off site).

RULES:
1. "quote" MUST be copied EXACTLY from the input, character for character, so it can be located. Never paraphrase it. Keep it short — the offending phrase, not the whole bullet.
2. "suggestion" is the corrected version of the quoted span ONLY, in the same style as the surrounding text. It must be a drop-in replacement for the quote. If the right fix is deletion, use an empty string.
3. "why" is ONE short sentence a busy inspector will accept, in plain language. No lecturing.
4. "severity": "high" = creates liability or is factually wrong (judgment, contradiction). "medium" = clearly wrong register or tense (ai_language, tense, person, corporate_vocab). "low" = polish (station_format, vague, repetition, minor spelling).
5. NEVER change or flag: station numbers, quantities, measurements, times, dates, company names, equipment names, or people's names. Preserve all field data exactly.
6. Do not flag bullet characters, line breaks or formatting.
7. NEVER INVENT A FACT THAT IS NOT IN THE TEXT. This is the most important rule here. If fixing an issue would require information you do not have — a quantity, a time, a station, a spec section — return "suggestion": "" and let the author supply it. Writing "3 loads" for "several loads", or "at 14:00" for "later in the day", puts a number the author never said into a legal record. Flag it, explain what is missing in "why", and STOP. An empty suggestion is always better than a plausible invention.

Return JSON ONLY:
{
  "issues": [
    {
      "quote": "exact text from the input",
      "issue_type": "one of the values above",
      "severity": "high|medium|low",
      "why": "one short sentence",
      "suggestion": "drop-in replacement for the quote"
    }
  ]
}"""


def _vocabulary_block() -> str:
    """
    Render the user's vocabulary library as prompt text.

    Injected into everything that writes or checks report prose. Without it the
    model reports real trade names as misspellings and quietly re-words terms
    the owner expects to see verbatim.

    Returns '' when nothing is configured, so prompts stay unchanged for a fresh
    install rather than carrying an empty heading.
    """
    try:
        from app.routers.settings import _load as _load_settings
        vocab = (_load_settings() or {}).get('vocabulary') or {}
    except Exception as exc:  # settings unreadable must never break an AI call
        logger.warning(f'[vocabulary] Could not load: {exc}')
        return ''

    protected = [t for t in (vocab.get('protected_terms') or []) if str(t).strip()]
    acronyms = [a for a in (vocab.get('known_acronyms') or []) if str(a).strip()]
    preferred = [
        p for p in (vocab.get('preferred_terms') or [])
        if isinstance(p, dict) and str(p.get('wrong', '')).strip() and str(p.get('right', '')).strip()
    ]
    banned = [
        b for b in (vocab.get('banned_terms') or [])
        if isinstance(b, dict) and str(b.get('term', '')).strip()
    ]

    if not (protected or acronyms or preferred or banned):
        return ''

    parts = ['\n\nPROJECT VOCABULARY — this overrides your own judgement about wording:']

    if protected:
        parts.append(
            '\nKNOWN TERMS — these are real trades, equipment and companies on this '
            'project. NEVER flag them as misspellings and NEVER reword them:\n'
            + ', '.join(str(t).strip() for t in protected)
        )
    if acronyms:
        parts.append(
            '\nKNOWN ACRONYMS — the reader knows these. Use the acronym alone. NEVER '
            'expand one on first use ("BMP" NOT "Best Management Practice (BMP)"):\n'
            + ', '.join(str(a).strip() for a in acronyms)
        )
    if preferred:
        parts.append('\nHOUSE SPELLING — always write the term on the right:')
        for p in preferred:
            parts.append(f"  - \"{str(p['wrong']).strip()}\" -> \"{str(p['right']).strip()}\"")
    if banned:
        parts.append('\nBANNED WORDS — these must not appear:')
        for b in banned:
            why = str(b.get('why', '') or '').strip()
            parts.append(f"  - \"{str(b['term']).strip()}\"" + (f' ({why})' if why else ''))

    return '\n'.join(parts)


class ProofreadRequest(BaseModel):
    text: str
    field_type: str = 'summary'


class ProofreadIssue(BaseModel):
    quote: str = ''
    issue_type: str = ''
    severity: str = 'medium'
    why: str = ''
    suggestion: str = ''


class ProofreadResponse(BaseModel):
    issues: list[ProofreadIssue] = []
    checked_chars: int = 0


@router.post('/proofread', response_model=ProofreadResponse)
async def ai_proofread(request: ProofreadRequest):
    """Read finished report text and flag anything that reads wrong."""
    text = (request.text or '').strip()
    if not text:
        return ProofreadResponse(issues=[], checked_chars=0)

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[
                PROOFREAD_SYSTEM_PROMPT + _vocabulary_block(),
                f'REPORT TEXT TO REVIEW:\n{text}',
            ],
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
            logger.warning(f'[proofread] Empty response: {problem}')
            raise HTTPException(
                status_code=502,
                detail=problem or 'The proofreader returned nothing. Try again.',
            )

        data = _clean_json(raw)
        issues: list[ProofreadIssue] = []

        for item in data.get('issues', []) or []:
            if not isinstance(item, dict):
                continue
            quote = str(item.get('quote', '') or '').strip()
            # A quote that is not actually in the text cannot be located or
            # applied, and usually means the model paraphrased. Drop it rather
            # than show the user a finding they cannot act on.
            if not quote or quote not in text:
                logger.debug(f'[proofread] Dropping unlocatable quote: {quote[:60]!r}')
                continue
            issues.append(ProofreadIssue(
                quote=quote,
                issue_type=str(item.get('issue_type', '') or 'ai_language'),
                severity=str(item.get('severity', '') or 'medium').lower(),
                why=str(item.get('why', '') or '').strip(),
                suggestion=str(item.get('suggestion', '') or ''),
            ))

        rank = {'high': 0, 'medium': 1, 'low': 2}
        issues.sort(key=lambda i: rank.get(i.severity, 1))

        logger.info(f'[proofread] {len(issues)} issue(s) in {len(text)} chars')
        return ProofreadResponse(issues=issues, checked_chars=len(text))

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[proofread] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Bulk Dictate All Activities
# Button: "🎤 Dictate All Activities" on Activity List page
# WHY: One long recording → AI splits by location into separate activities.
# ============================================

class BulkDictationResponse(BaseModel):
    activities: list[dict[str, Any]] = []
    raw_transcription: str = ''
    locations: str = ''
    general_notes: str = ''
    # Things the parser could not resolve on its own. Surfaced so the user is
    # ASKED before the report is written, rather than finding a "_____" in it
    # afterwards. Empty is the normal case.
    questions: list[dict[str, Any]] = []


class BulkDictateRequest(BaseModel):
    audio_data: str
    mime_type: str = 'audio/webm'
    duration_seconds: float = 0.0


# ============================================
# TWO-STEP DICTATION (transcribe → confirm → parse)
#
# WHY SPLIT: the single-call flow could silently fabricate an entire report.
# If the recording was truncated or the mic was dead, pass 1 returned a short
# or empty transcript, and pass 2 — running in JSON mode at default
# temperature — happily filled the schema with plausible-sounding construction
# work that was never spoken. Splitting lets the user SEE the transcript
# before any activities are built, which turns a silent fabrication into an
# obvious, recoverable error.
# ============================================

# A slow speaker still produces well over this. Used only to flag a
# transcript as suspicious — never to block, since a long recording with a
# lot of silence is legitimately short on text.
MIN_CHARS_PER_SECOND = 3.0
MIN_DURATION_FOR_SANITY_CHECK = 30.0
MIN_AUDIO_BYTES = 2000


class TranscribeAudioResponse(BaseModel):
    status: str = 'ok'            # 'ok' | 'suspect' | 'failed'
    transcription: str = ''
    reason: str = ''              # populated when status != 'ok'
    duration_seconds: float = 0.0


class BulkParseRequest(BaseModel):
    transcription: str
    current_activities: list[dict[str, Any]] = []
    # Answers to the questions a previous parse of THIS transcript returned,
    # keyed by question id. Re-parsing with them is what turns "ask first" into
    # a finished report: the answers are treated as if they had been spoken.
    answers: dict[str, str] = {}


# --- Structured output schema for the parse pass ---
# Enforced by Gemini rather than described in prose, which removes the
# summary/summary_html drift and the string-vs-number coercion on qty/hours.

class DictatedManpower(BaseModel):
    trade: str = ''
    name: str = ''
    company: str = ''
    qty: float = 1
    hours: float = 0
    start_time: str = ''
    stop_time: str = ''
    is_extra_work: bool = False
    is_3rd_party: bool = False
    is_consultant: bool = False


class DictatedEquipment(BaseModel):
    name: str = ''
    description: str = ''
    company: str = ''
    qty: float = 1
    hours: float = 0
    start_time: str = ''
    stop_time: str = ''
    is_extra_work: bool = False
    is_3rd_party: bool = False
    is_rental: bool = False


class DictatedActivity(BaseModel):
    work_area: str = ''
    stations: str = ''
    summary_html: str = ''
    manpower: list[DictatedManpower] = []
    equipment: list[DictatedEquipment] = []


class ParseQuestion(BaseModel):
    """One thing the parser needs answered before the report can be accurate."""
    id: str = ''
    question: str = ''
    # The surrounding words from the transcript, so the question is recognisable
    # without replaying the recording.
    context: str = ''


class BulkParseResult(BaseModel):
    activities: list[DictatedActivity] = []
    locations: str = ''
    general_notes: str = ''
    questions: list[ParseQuestion] = []


def _finish_reason_problem(response: Any) -> str:
    """
    Return a human-readable reason if the model stopped for a bad reason.

    WHY: every endpoint dereferenced response.text unconditionally. On a safety
    block or a MAX_TOKENS truncation .text is None or partial, which surfaced
    as an opaque 500 (or worse, a half-parsed result treated as real).
    """
    try:
        candidates = getattr(response, 'candidates', None) or []
        if not candidates:
            return 'The model returned no candidates (possibly blocked).'
        reason = getattr(candidates[0], 'finish_reason', None)
        if reason is None:
            return ''
        name = getattr(reason, 'name', str(reason)).upper()
        if 'MAX_TOKEN' in name:
            return 'The response hit the output token limit and was truncated.'
        if 'SAFETY' in name or 'BLOCK' in name or 'RECITATION' in name:
            return f'The model stopped early ({name}).'
        return ''
    except Exception:  # never let the guard itself break the request
        return ''


def _decode_audio(audio_data: str) -> bytes:
    """Strip an optional data-URL prefix and base64-decode."""
    import base64
    if 'base64,' in audio_data:
        audio_data = audio_data.split('base64,')[1]
    return base64.b64decode(audio_data)


def _transcribe_audio(
    client: Any,
    model_name: str,
    audio_bytes: bytes,
    mime_type: str,
    duration_seconds: float = 0.0,
    extra_instructions: str = '',
) -> TranscribeAudioResponse:
    """
    Pass 1 for every audio flow: faithful transcription, no JSON forcing.

    Returns a status rather than raising so callers can surface the transcript
    (and the reason it looks wrong) instead of fabricating on top of it.
    """
    import os
    import tempfile
    from google.genai import types as genai_types

    if len(audio_bytes) < MIN_AUDIO_BYTES:
        return TranscribeAudioResponse(
            status='failed',
            reason=f'Recording is too short or empty ({len(audio_bytes)} bytes).',
            duration_seconds=duration_seconds,
        )

    suffix_map = {
        'audio/webm': '.webm', 'audio/mp3': '.mp3', 'audio/mpeg': '.mp3',
        'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.mp4',
        'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
    }
    base_mime = (mime_type or '').split(';')[0].strip() or 'audio/webm'
    suffix = suffix_map.get(base_mime, '.webm')

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        uploaded = client.files.upload(file=tmp_path, config={'mime_type': base_mime})
        logger.info(f'[transcribe] Uploaded {len(audio_bytes)} bytes as {base_mime}')

        prompt = DICTATION_SYSTEM_PROMPT
        if extra_instructions:
            prompt = f'{prompt}\n\n{extra_instructions}'
        prompt += (
            '\n\nListen to the audio and transcribe it now. Organize into '
            'WORK DESCRIPTION, MANPOWER, and EQUIPMENT sections as instructed above.'
        )

        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[
                genai_types.Content(role='user', parts=[
                    genai_types.Part.from_text(text=prompt),
                    genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type=base_mime),
                ]),
            ],
            config=genai_types.GenerateContentConfig(
                temperature=0.0,
                max_output_tokens=32768,
            ),
        )

        problem = _finish_reason_problem(response)
        text = (getattr(response, 'text', None) or '').strip()

        if not text:
            return TranscribeAudioResponse(
                status='failed',
                reason=problem or 'The model returned no transcription.',
                duration_seconds=duration_seconds,
            )

        # The dictation prompt emits this exact marker when it hears nothing.
        if text.startswith('| Please try again'):
            return TranscribeAudioResponse(
                status='failed',
                transcription=text,
                reason="Couldn't make out any speech in the recording.",
                duration_seconds=duration_seconds,
            )

        if problem:
            # Truncated but non-empty — usable, but the user should know.
            return TranscribeAudioResponse(
                status='suspect', transcription=text, reason=problem,
                duration_seconds=duration_seconds,
            )

        # Sanity gate: a multi-minute recording that yields a couple of lines
        # means the audio was bad, and parsing it invites fabrication.
        if duration_seconds >= MIN_DURATION_FOR_SANITY_CHECK:
            expected = duration_seconds * MIN_CHARS_PER_SECOND
            if len(text) < expected:
                logger.warning(
                    f'[transcribe] Short transcript: {len(text)} chars for '
                    f'{duration_seconds:.0f}s of audio (expected ~{expected:.0f}+)'
                )
                return TranscribeAudioResponse(
                    status='suspect',
                    transcription=text,
                    reason=(
                        f'Only {len(text)} characters were transcribed from '
                        f'{int(duration_seconds // 60)}m {int(duration_seconds % 60)}s of audio. '
                        'The recording may have been cut short or the mic may not have '
                        'picked everything up — please check the text below before continuing.'
                    ),
                    duration_seconds=duration_seconds,
                )

        return TranscribeAudioResponse(
            status='ok', transcription=text, duration_seconds=duration_seconds,
        )

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@router.post('/bulk-transcribe', response_model=TranscribeAudioResponse)
async def bulk_transcribe(request: BulkDictateRequest):
    """
    STEP 1 of dictation: transcribe the recording and hand the text back.

    Deliberately does NOT build activities — the user confirms (and can edit)
    the transcript first, then calls /bulk-parse.
    """
    client, model_name = _get_gemini_client()
    try:
        audio_bytes = _decode_audio(request.audio_data)
        logger.info(
            f'[bulk-transcribe] {len(audio_bytes)} bytes, '
            f'{request.duration_seconds:.0f}s, {request.mime_type}'
        )
        return _transcribe_audio(
            client, model_name, audio_bytes, request.mime_type,
            request.duration_seconds,
            extra_instructions=(
                'VERBOSITY RULE: Capture EVERY detail the speaker mentions. Do NOT '
                'summarize or compress. If they speak 10 sentences of detail, output '
                '10 sentences of detail. More is better than less. Include ALL station '
                'numbers, measurements, quantities, pipe sizes, crew counts, and specifics.'
            ),
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[bulk-transcribe] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


@router.post('/bulk-parse', response_model=BulkDictationResponse)
async def bulk_parse(request: BulkParseRequest):
    """
    STEP 2 of dictation: turn a CONFIRMED transcript into activities.

    Text-only and schema-enforced at temperature 0 — no audio in this call, so
    there is nothing for the model to mishear, and the output shape is
    guaranteed rather than described in prose and repaired with regex.
    """
    from google.genai import types as genai_types

    transcription = (request.transcription or '').strip()
    if not transcription:
        raise HTTPException(status_code=400, detail='No transcription text provided.')

    client, model_name = _get_gemini_client()

    # Answers the inspector gave to a previous pass's questions. They are folded
    # in as spoken words rather than as a separate instruction, so rule 3 keeps
    # applying: everything in the report still traces to something a human said.
    answers_block = ''
    if request.answers:
        answered = '\n'.join(
            f'- {qid}: {text.strip()}'
            for qid, text in request.answers.items()
            if (text or '').strip()
        )
        if answered:
            answers_block = (
                '\nANSWERS FROM THE INSPECTOR — treat each of these as if it had been '
                'spoken during the dictation, and fold it into the right activity. '
                'Do NOT ask about these again:\n' + answered + '\n'
            )

    try:
        # String concat, not an f-string: the transcript may contain { }.
        prompt = (
            'You are a construction field data parser. Parse the transcription below '
            'into MULTIPLE activities, split by location.\n\n'
            'CRITICAL RULES:\n'
            '1. Each distinct LOCATION or work area becomes a SEPARATE activity.\n'
            '2. Listen for location changes: "At Station...", "Moving to...", "Over at...", '
            '"Next we have...", "Also at...". Also treat explicit markers like "new task", '
            '"next activity", or "new activity" as a hard split.\n'
            '3. DO NOT add any information that is not in the transcription. '
            'DO NOT fabricate details. If the transcription is too vague to build an '
            'activity from, return an empty activities array rather than inventing one.\n'
            '4. summary_html MUST contain EVERY detail mentioned for that location. '
            'Do NOT summarize or compress. Keep ALL station numbers, measurements, '
            'quantities, and specifics.\n'
            '5. EXTRACT manpower and equipment into their arrays. Remove resource counts '
            'from summary_html.\n'
            '6. Use the • (bullet) character for bullets in summary_html, one detail '
            'per line separated by newlines. PLAIN TEXT only — no HTML tags.\n'
            '7. If all work is at one location, return a SINGLE activity with ALL the detail.\n'
            '8. COMPANY NAMES ARE CRITICAL: when a company, contractor or subcontractor is '
            'named, put it in the "company" field of EVERY manpower and equipment row it '
            'applies to. Never leave company blank if it was spoken.\n'
            '9. TIME FORMAT: 12-hour AM/PM (e.g. "7:00 AM", "3:30 PM"). '
            'NEVER military/24-hour time.\n'
            '10. general_notes: 1-2 sentence HIGH-LEVEL overview of the day '
            '(superintendent elevator pitch). Do NOT repeat station numbers, crew counts, '
            'or equipment details — those belong in the activity summaries.\n\n'

            'ORDERING — THIS IS SPEECH, NOT WRITING:\n'
            'The inspector talks through the day out loud and jumps around. They finish '
            'describing one location, then remember something from hours earlier. Your job '
            'is to make the finished report read in the order the day actually happened, '
            'not the order it was spoken.\n'
            'A. Work out WHEN each thing happened and order the bullets inside each '
            'activity by time of day.\n'
            'B. ONLY reorder when the speaker gave a time cue — a clock time ("7:00 AM"), '
            'or wording like "first thing", "before lunch", "after that", "once they '
            'finished", "at the end of the day", "when we got there". Anything with NO '
            'time cue keeps the order it was spoken in. NEVER invent a sequence you were '
            'not given.\n'
            'C. Worked example: traffic control is mentioned LAST, but described as "set up '
            'first thing in the morning and taken down at the end of the day". The setup '
            'becomes one of the FIRST bullets for that location and the removal one of the '
            'LAST. The words do not change — only where they sit.\n'
            'D. Reordering moves what was said. It NEVER rewords, NEVER merges two details '
            'into one, and NEVER adds a fact. Rule 3 still governs everything.\n\n'

            'CONTINUITY — TRACK THE DAY AS YOU READ:\n'
            'E. Keep track of every location, street name, station, crew, company and piece '
            'of equipment as it is mentioned.\n'
            'F. When the speaker returns to something already described — "back at Main '
            'Street", "same crew as before", "over there", "that same excavator" — attach '
            'it to the activity it belongs to. Do NOT create a second activity for a '
            'location you have already opened.\n'
            'G. One location described across three separate stretches of the recording is '
            'ONE activity containing all three, in time order.\n'
            'H. Resolve references like "they", "there" and "that" to whichever crew or '
            'location was actually being discussed. If you genuinely cannot tell which one '
            'is meant, ASK (below) rather than picking one.\n\n'

            'WHEN YOU CANNOT TELL — ASK. DO NOT GUESS, DO NOT LEAVE A BLANK:\n'
            'I. Two markers may appear in the transcript, both put there because the '
            'transcriber refused to guess:\n'
            '   • "_____" — a word the recording was too unclear to make out.\n'
            '   • a line starting "[ASIDE]" — the inspector stopped dictating and spoke to '
            'the assistant instead (asking what something is called, saying to look '
            'something up).\n'
            'For EITHER marker, and for anything else ambiguous or contradictory: do NOT '
            'write it into the report, do NOT carry "_____" or "[ASIDE]" through into any '
            'summary, and do NOT answer it yourself from your own knowledge. Add an entry '
            'to the "questions" array instead. An [ASIDE] line is never work that happened '
            'and never appears in an activity.\n'
            'J. Each question needs a short stable "id" (q1, q2, ...), the "question" to '
            'put to the inspector, and "context" quoting the words around it so they know '
            'what you are referring to without replaying the audio.\n'
            'K. Ask ONLY about things that block writing the report accurately. Do not ask '
            'about detail that simply was never mentioned — something else handles that.\n'
            'L. Still build activities from everything you DID understand. The questions '
            'sit alongside the activities; they do not replace them.\n\n'

            'TRANSCRIPTION TO PARSE:\n---\n' + transcription + '\n---\n'
            + answers_block
        )

        logger.info(f'[bulk-parse] Parsing {len(transcription)} chars of transcript')
        response = _gemini_call_with_retry(
            client,
            model_name,
            contents=[prompt],
            config=genai_types.GenerateContentConfig(
                temperature=0.0,
                response_mime_type='application/json',
                response_schema=BulkParseResult,
                max_output_tokens=32768,
            ),
        )

        problem = _finish_reason_problem(response)
        raw_text = getattr(response, 'text', None) or ''
        if problem and not raw_text:
            raise HTTPException(status_code=502, detail=f'Parsing failed: {problem}')
        if problem:
            logger.warning(f'[bulk-parse] {problem}')

        data = _clean_json(raw_text)
        activities = data.get('activities', []) or []
        questions = data.get('questions', []) or []

        # An answered question must never come back a second time — the model is
        # told not to re-ask, but a dropped id would strand the user in a loop
        # they cannot clear, so enforce it here too.
        if request.answers:
            answered_ids = {
                qid for qid, text in request.answers.items() if (text or '').strip()
            }
            questions = [q for q in questions if q.get('id') not in answered_ids]

        logger.info(
            f'[bulk-parse] Parsed {len(activities)} activities, '
            f'{len(questions)} question(s) outstanding'
        )
        for i, act in enumerate(activities):
            logger.info(
                f'[bulk-parse] Activity {i}: work_area="{act.get("work_area", "")}", '
                f'manpower={len(act.get("manpower", []))}, '
                f'equipment={len(act.get("equipment", []))}'
            )

        return BulkDictationResponse(
            activities=activities,
            raw_transcription=transcription,
            locations=data.get('locations', ''),
            general_notes=data.get('general_notes', ''),
            questions=questions,
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[bulk-parse] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


@router.post('/bulk-dictate-activities', response_model=BulkDictationResponse)
async def bulk_dictate_activities_v2(request: BulkDictateRequest):
    """
    LEGACY one-shot dictation: transcribe and parse in a single call.

    Kept for the shipped Android APK, which has not been rebuilt against the
    two-step flow. New clients should call /bulk-transcribe, show the text to
    the user, then call /bulk-parse — that is what stops a bad recording from
    turning into a fabricated report.

    This wrapper reuses the same hardened helpers, so it inherits the retry,
    finish-reason checks and schema enforcement. It still cannot show the user
    the transcript before building activities, so on a failed or suspicious
    transcription it returns NO activities rather than guessing.
    """
    client, model_name = _get_gemini_client()

    try:
        audio_bytes = _decode_audio(request.audio_data)
        logger.info(
            f'[bulk-dictate] {len(audio_bytes)} bytes, '
            f'{request.duration_seconds:.0f}s, {request.mime_type}'
        )

        result = _transcribe_audio(
            client, model_name, audio_bytes, request.mime_type,
            request.duration_seconds,
            extra_instructions=(
                'VERBOSITY RULE: Capture EVERY detail the speaker mentions. Do NOT '
                'summarize or compress. Include ALL station numbers, measurements, '
                'quantities, pipe sizes, crew counts, and specifics.'
            ),
        )

        if result.status == 'failed':
            logger.warning(f'[bulk-dictate] Transcription failed: {result.reason}')
            return BulkDictationResponse(
                activities=[],
                raw_transcription=result.transcription or result.reason,
            )

        if result.status == 'suspect':
            # Do not build activities from a transcript we do not trust.
            logger.warning(f'[bulk-dictate] Suspect transcription: {result.reason}')
            return BulkDictationResponse(
                activities=[],
                raw_transcription=result.transcription,
                general_notes=result.reason,
            )

        return await bulk_parse(BulkParseRequest(transcription=result.transcription))

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[bulk-dictate] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Update Activity from Media (Smart Merge)
# Button: "📷 Update with Media" inside ActivityEditor
# WHY: Upload photo/video/audio/doc to UPDATE an existing activity.
# ============================================

class ActivityUpdateResponse(BaseModel):
    summary_html: str = ''
    manpower: list[dict[str, Any]] = []
    equipment: list[dict[str, Any]] = []
    confidence: dict[str, str] = {}
    merge_strategy_used: str = ''


@router.post('/update-activity', response_model=ActivityUpdateResponse)
async def update_activity(
    file: UploadFile | None = File(None),
    audio_data: str | None = Form(None),
    current_data: str = Form('{}'),
    merge_mode: bool = Form(True),
):
    """Update existing activity with media (photo/video/audio/document). Smart Merge or Replace."""
    import base64
    import os
    import tempfile

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        current_activity = json.loads(current_data) if current_data else {}
    except json.JSONDecodeError:
        current_activity = {}

    tmp_path = None

    try:
        from google.genai import types as genai_types

        current_summary = current_activity.get('summary_html', '') or current_activity.get('summary', '')
        merge_word = 'COMPLETE and ENHANCE' if merge_mode else 'REPLACE'

        if file:
            file_bytes = await file.read()
            content_type = file.content_type or 'application/octet-stream'
            logger.info(f'[update-activity] File: {file.filename}, type: {content_type}, size: {len(file_bytes)} bytes')

            suffix_map = {
                'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic',
                'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
                'audio/webm': '.webm', 'audio/mp3': '.mp3', 'audio/mpeg': '.mp3',
                'application/pdf': '.pdf',
            }
            suffix = suffix_map.get(content_type, '.bin')

            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name

            uploaded = client.files.upload(file=tmp_path, config={'mime_type': content_type})
            logger.info(f'[update-activity] Uploaded to Gemini: {uploaded.name}')

            prompt = f"""Analyze this media to {merge_word} activity data.

CURRENT SUMMARY: "{current_summary}"
CURRENT MANPOWER: {json.dumps(current_activity.get('manpower', []))}
CURRENT EQUIPMENT: {json.dumps(current_activity.get('equipment', []))}

{'SMART MERGE: Complete partial sentences naturally, dont just append.' if merge_mode else 'REPLACE: Provide entirely new data.'}

{STANDARD_EXTRACTION_RULES}

OUTPUT JSON:
{{"summary_html": "Enhanced summary", "manpower": [], "equipment": [], "confidence": {{"visual": "high"}}, "merge_strategy_used": "{'enhanced' if merge_mode else 'replaced'}"}}"""

            response = _gemini_call_with_retry(
                client,
                model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(text=prompt),
                        genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type=content_type),
                    ]),
                ],
                config=genai_types.GenerateContentConfig(
                    thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                    response_mime_type='application/json',
                    max_output_tokens=8192,
                ),
            )

        elif audio_data:
            logger.info('[update-activity] Processing audio')
            raw = audio_data
            if 'base64,' in raw:
                raw = raw.split('base64,')[1]
            audio_bytes = base64.b64decode(raw)

            with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name

            uploaded = client.files.upload(file=tmp_path, config={'mime_type': 'audio/webm'})

            prompt = f"""Transcribe audio to {merge_word} this activity.

CURRENT SUMMARY: "{current_summary}"
CURRENT MANPOWER: {json.dumps(current_activity.get('manpower', []))}
CURRENT EQUIPMENT: {json.dumps(current_activity.get('equipment', []))}

{'SMART MERGE: Complete/append naturally.' if merge_mode else 'REPLACE with new data.'}

{STANDARD_EXTRACTION_RULES}

OUTPUT JSON:
{{"summary_html": "...", "manpower": [], "equipment": [], "confidence": {{"audio": "high"}}, "merge_strategy_used": "{'enhanced' if merge_mode else 'replaced'}"}}"""

            response = _gemini_call_with_retry(
                client,
                model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(text=prompt),
                        genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type='audio/webm'),
                    ]),
                ],
                config=genai_types.GenerateContentConfig(
                    thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                    response_mime_type='application/json',
                    max_output_tokens=8192,
                ),
            )
        else:
            raise HTTPException(status_code=400, detail='No media provided (file or audio_data required)')

        data = _clean_json(response.text)
        logger.info(f'[update-activity] Parsed response: {len(data.get("summary_html", ""))} chars summary')
        return ActivityUpdateResponse(**{k: data.get(k, v) for k, v in ActivityUpdateResponse().model_dump().items()})

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[update-activity] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if tmp_path:
            import os
            if os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


# ============================================
# ENDPOINT: Parse Completed Report
# Button: "📄 Import Report" on Reports page
# WHY: Upload a .docx or .pdf completed report → AI creates a draft.
# ============================================

class ParseReportResponse(BaseModel):
    report_id: str = ''
    activity_count: int = 0
    project: str = ''
    original_date: str = ''
    message: str = ''


@router.post('/parse-report', response_model=ParseReportResponse)
async def parse_report(file: UploadFile = File(...)):
    """Upload a completed .docx/.pdf report → AI extracts activities into a new draft."""
    import os
    import tempfile

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        file_bytes = await file.read()
        content_type = file.content_type or 'application/octet-stream'
        logger.info(f'[parse-report] File: {file.filename}, type: {content_type}, size: {len(file_bytes)} bytes')

        accepted = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
        if content_type not in accepted:
            raise HTTPException(status_code=400, detail='Only .pdf and .docx files are supported.')

        suffix = '.pdf' if 'pdf' in content_type else '.docx'
        tmp_path = None

        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name

            uploaded = client.files.upload(file=tmp_path, config={'mime_type': content_type})
            logger.info(f'[parse-report] Uploaded: {uploaded.name}')

            system_prompt = f"""You are parsing a completed construction daily field report (PDF or Word document).

TASK: Extract ALL data from this completed report — project info, date, and every work activity with its manpower, equipment, and summary.

{STANDARD_EXTRACTION_RULES}

OUTPUT JSON:
{{
    "project": "Project Name if found",
    "original_date": "YYYY-MM-DD or as shown",
    "activities": [
        {{
            "work_area": "Location - Company - Description",
            "summary_html": "• Full bullet point text from the report",
            "manpower": [...],
            "equipment": [...]
        }}
    ]
}}

Extract EVERYTHING — do not summarize or skip any activities."""

            response = _gemini_call_with_retry(
                client,
                model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(text='Parse this completed daily report into structured JSON.'),
                        genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type=content_type),
                    ]),
                ],
                config=genai_types.GenerateContentConfig(
                    thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                    system_instruction=system_prompt,
                    response_mime_type='application/json',
                    max_output_tokens=32768,
                ),
            )

            data = _clean_json(response.text)
            activities = data.get('activities', [])
            logger.info(f'[parse-report] Extracted {len(activities)} activities')

            # Create the report in storage
            from app.services.reports import save_report
            import uuid
            from datetime import datetime

            # Assign IDs and normalize the summary field name.
            # The AI returns "summary_html"; the model, Word exporter and
            # report-chat's surgical merge all key on "summary" and on row IDs.
            _RESOURCE_KEYS = (
                'manpower', 'equipment', 'extra_work_manpower',
                'extra_work_equipment', 'consultant_manpower',
            )
            for act in activities:
                act['id'] = act.get('id') or str(uuid.uuid4())
                if not act.get('summary') and act.get('summary_html'):
                    act['summary'] = act.pop('summary_html')
                for key in _RESOURCE_KEYS:
                    rows = act.get(key)
                    if isinstance(rows, list):
                        for row in rows:
                            if isinstance(row, dict):
                                row['id'] = row.get('id') or str(uuid.uuid4())

            report_data = {
                'id': str(uuid.uuid4()),
                'general': {
                    'project_name': data.get('project', ''),
                    'project_number': '',
                    'project_location': '',
                    'inspector_name': '',
                    'resident_engineer': '',
                    'report_date': '',  # Left blank — user sets today's date
                    'start_time': '07:00',
                    'end_time': '15:30',
                    'sky_conditions': [],
                    'temperature_high': '',
                    'temperature_low': '',
                    'wind_info': '',
                    'notes': f'Imported from: {file.filename}',
                },
                'activities': activities,
                'photos': [],
                'status': 'draft',
                'created_at': datetime.utcnow().isoformat(),
                'updated_at': datetime.utcnow().isoformat(),
            }

            # save_report returns the JSON file path, not the report dict.
            await save_report(report_data)
            report_id = report_data['id']

            return ParseReportResponse(
                report_id=report_id,
                activity_count=len(activities),
                project=data.get('project', ''),
                original_date=data.get('original_date', ''),
                message=f'Created report with {len(activities)} activities from {file.filename}',
            )

        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[parse-report] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Parse Dispatch PDF
# WHY: Dispatch PDFs are columnar crew/job sheets from the paving
#      contractor. Each column represents a distinct job with its
#      assigned crew, equipment, trucking, and subcontractors.
#      The PDF HAS selectable text — no image rendering needed.
# ============================================

DISPATCH_PARSE_PROMPT_LEGACY = """You are parsing a PAVING CONTRACTOR DISPATCH SHEET (PDF document).

This is a multi-column table where each COLUMN represents a separate JOB for the day.
A column is a JOB if it has a "Job Number" row with a value.

TASK: Extract ONLY job columns (identified by having a Job Number).

For the OVERALL document, extract:
- date: The dispatch date at the top of the document (format as YYYY-MM-DD if possible)
- company: The contractor company name (e.g. "OHLA", "OHL") from the header

For EACH JOB COLUMN, extract:
- job_number: From the "Job Number" or "Job #" row
- job_name: From the "Job Name" row
- job_description: From the "Job Description" or "Description" row
- contract_type: "CONTRACT", "CHANGE ORDER", or "T&M" from "Contract Type" row
- start_time: From "Time on Job" row (e.g. "6:00 AM")
- load_time: From "Load Time" row
- material: From "Material" row (e.g. "3/4 PG64-10", "1/2 PG64-10")
- plant: From "Plant" row
- streets: Array of street names from the "Streets" rows at the bottom of the column
- location: From the "Location" row at the bottom
- foreman: Object with {name, time, role} from the "Foreman" row
- operators: Array of {name, time} from the "Operators" section for that column
- laborers: Array of {name, time} from the "Labors" or "Laborers" section
- rakers: Array of {name, time} from the "Rakers" section
- traffic_control: Array of {name, time} from the "Traffic Control" section
- equipment: Array of {id, description} from the "Equipment" section for that column
- trucking: Object {company, details} from "Trucking Ordered" row (null if N/A)
- grinders: Object {company, details} from "Grinders" row (null if N/A)
- sub_brooms: Object {company, details} from "SUB Brooms" row (null if N/A)
- sub_traffic_control: Object {company, details} from "SUB Traffic Control" row (null if N/A)
- oil_truck: Object {driver, equipment_id, equipment_desc, material} from "Oil Truck Driver" row (null if N/A)
- rentals: Array of {company, description} from "Rentals" section (empty array if none)

IGNORE THESE SECTIONS ENTIRELY:
- Crew Down
- EQ Down
- Equipment to Scrap/Sell
- Misc Work
- Yard Mechanics
- Office/Field
- Legend
- S/T certifications
- Skilled & Trained rosters

RULES:
- Extract EVERY job column. Do not skip any.
- If a field is empty or "N/A", use empty string or null as appropriate.
- For person entries (operators, laborers, rakers, traffic_control), only include entries that have an actual name — skip blank rows.
- Equipment entries: "id" is the equipment number/tag, "description" is the equipment type.
- Output ONLY the JSON. No commentary.

Return JSON:
{
    "date": "2026-01-15",
    "company": "OHLA",
    "jobs": [
        {
            "job_number": "12345",
            "job_name": "I-5 NB Paving",
            "job_description": "Mill and overlay",
            "contract_type": "CONTRACT",
            "start_time": "6:00 AM",
            "load_time": "5:30 AM",
            "material": "3/4 PG64-10",
            "plant": "El Cajon",
            "streets": ["Main St", "2nd Ave"],
            "location": "I-5 NB from Main to Harbor",
            "foreman": {"name": "John Smith", "time": "5:00 AM", "role": "Foreman"},
            "operators": [{"name": "Jane Doe", "time": "5:30 AM"}],
            "laborers": [{"name": "Bob Jones", "time": "5:30 AM"}],
            "rakers": [{"name": "Tom Lee", "time": "5:30 AM"}],
            "traffic_control": [{"name": "Sue Kim", "time": "5:00 AM"}],
            "equipment": [{"id": "P-101", "description": "Paver"}],
            "trucking": {"company": "ABC Trucking", "details": "10 trucks"},
            "grinders": null,
            "sub_brooms": null,
            "sub_traffic_control": null,
            "oil_truck": {"driver": "Mike R.", "equipment_id": "OT-01", "equipment_desc": "Oil Truck", "material": "SS-1H"},
            "rentals": []
        }
    ]
}
"""

# ── Two-pass prompts (Landmine #6: never JSON-force with media) ──

DISPATCH_READ_PROMPT = """You are reading a paving contractor's daily dispatch sheet.

LAYOUT:
- This is a LANDSCAPE TABLE.
- Row 1 is the DATE.
- The LEFT-MOST column contains ROW LABELS.
- Every column to the right of the row labels is a JOB COLUMN.
- Multiple columns can share the SAME Job Number — they represent different crews on the same job.
- The COMPANY name (the contractor or sub-contractor who made this dispatch) is printed at the VERY TOP of the sheet — this is the employer of all the crew listed. It is NOT "OHLA" unless the sheet literally says "OHLA" at the top.

WHAT IS NOT A JOB COLUMN — SKIP THESE ENTIRELY:
- The "Skilled & Trained" section on the right side is a LEGEND, not a job column.
- Crew Down, Equipment Down, equipment listed for sale/scrap.
- "Requested off/unavailable" names.
- "Buggy Dump" entries.

YOUR TASK:
For EACH column that has a NUMERIC job number (like 25015, 25005), read and output its data.

PEOPLE ROWS — these rows contain names you MUST capture from each column:
1. Foreman — one person per column
2. Operators — multiple names stacked vertically in each column
3. Laborers — multiple names stacked vertically in each column
4. Rakers — multiple names stacked vertically in each column
5. Traffic Control — multiple names stacked vertically in each column
6. Oil Truck — the driver name if present

Read ALL names in each of these rows for each column. Do NOT skip anyone.
Keep each column's people SEPARATE — do NOT combine people from different columns.

Output format for EACH column:

COLUMN [number]:
Date: [from top of page]
Company: [from header]
Job Number: [numeric value]
Job Name: [value]
Job Description: [value]
Contract Type: [CONTRACT or T&M or CHANGE ORDER]
Start Time: [from Time on Job row]
Load Time: [value]
Material: [value]
Plant: [value]
Trucking: [value — READ THE PRIMARY COUNT AND TIME ONLY, e.g. "4 @ 8 PM" means 4 trucks at 8 PM. IGNORE any "same trucks load at" entries (that is the same trucks doing another load, not additional trucks). IGNORE notations like "+ 5 x 1" which refer to travel pay, not additional trucks.]
Grinders: [value]
SUB Brooms: [value]
SUB Traffic Control: [value]

Foreman: [name] [time] [role]

Operators:
- [name] [time]
(every operator in THIS column)

Laborers:
- [name] [time]
(every laborer in THIS column)

Rakers:
- [name] [time]

Traffic Control:
- [name] [time]

Equipment:
- [equipment_id] [description]
(every piece of equipment in THIS column)

Oil Truck: [driver name] | [equipment_id] | [description] | [material] (or N/A)
Rentals: [details or N/A]
Streets: [value]
Location: [value]
---
"""

DISPATCH_JSON_PROMPT = """Parse this dispatch sheet text into structured JSON.

Each COLUMN from the text becomes its OWN job object in the output — do NOT merge columns together, even if they share the same job number. Each column has its own crew and equipment.

DISPATCH TEXT:
{pass1_text}

Return this exact JSON structure:
{{
    "date": "YYYY-MM-DD",
    "company": "Company Name",
    "jobs": [
        {{
            "job_number": "25015",
            "job_name": "SD MORENA CONVEYANCE",
            "job_description": "PAVE CREW",
            "contract_type": "CONTRACT",
            "start_time": "7:30 PM",
            "load_time": "8:15 PM",
            "material": "530 TN 3/4 HMA",
            "plant": "MM MIRAMAR",
            "streets": [],
            "location": "GENESSEE AVE / SR 52 INT - UTC",
            "foreman": {{"name": "Lopez, Salvador", "time": "7:30 PM", "role": "OP"}},
            "operators": [{{"name": "Martinez, Gustavo", "time": "7:30 PM"}}],
            "laborers": [{{"name": "Torres, Felipe", "time": "7:30 PM"}}],
            "rakers": [],
            "traffic_control": [],
            "equipment": [],
            "trucking": {{"company": "DIII", "details": "4 @ 8 PM", "count": 4, "time": "8:00 PM"}},
            "grinders": {{"company": "PRSI", "details": "HALF LANE X 1 @ 8 PM", "count": 1, "time": "8:00 PM"}},
            "sub_brooms": null,
            "sub_traffic_control": null,
            "oil_truck": null,
            "rentals": []
        }}
    ]
}}

CRITICAL RULES:
- One job object per COLUMN (do NOT merge columns — even if they share a job number)
- Job numbers are ALWAYS numeric (like 25015, 25005). Discard any column with a non-numeric job number
- Every person from the text MUST appear in their column's job output — do NOT drop anyone
- If trucking/grinders/sub entries are "N/A", set to null
- Parse dates as YYYY-MM-DD format
- Do NOT include people from "Requested off/unavailable" or "Crew Down" sections

TRUCKING RULE — READ THIS CAREFULLY:
- The trucking "count" is the number of trucks/drivers from the PRIMARY entry (e.g. "4 @ 8 PM" = count 4).
- "same trucks load at [time]" means those SAME trucks do another load — it is NOT additional trucks. Do NOT create a separate trucking entry for it. Do NOT add its count to the primary count.
- Notations like "+ 5 x 1" refer to travel pay or similar — they are NOT additional trucks. IGNORE these numbers entirely.
- The trucking "time" should be the start time from the primary entry (e.g. "4 @ 8 PM" → time = "8:00 PM").

EQUIPMENT RULE — READ THIS CAREFULLY:
- The "equipment" array must contain ONLY items that are EXPLICITLY listed under the "Equipment:" header for that column in the text above.
- If the "Equipment:" section for a column is EMPTY or has NO items listed beneath it, the equipment array MUST be [].
- Do NOT invent, guess, or infer equipment. Do NOT assume equipment based on crew roles (e.g., do NOT add a paver just because there are operators).
- Each equipment entry has {{"id": "...", "description": "..."}} — use ONLY the exact text from the transcription.
- The same rule applies to "rentals" — only include items explicitly listed under "Rentals:" in the text.
"""


class DispatchParseResponse(BaseModel):
    date: str = ''
    company: str = ''
    jobs: list[dict[str, Any]] = []


@router.post('/parse-dispatch', response_model=DispatchParseResponse)
async def parse_dispatch(file: UploadFile = File(...)):
    """
    Parse a paving contractor dispatch PDF into structured job data.

    The dispatch PDF HAS selectable text (unlike image-based schedules).
    Uses the Gemini Files API temp-file upload pattern (same as parse-report).
    """

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        file_bytes = await file.read()
        content_type = file.content_type or 'application/octet-stream'
        logger.info(
            f'[parse-dispatch] File: {file.filename}, type: {content_type}, '
            f'size: {len(file_bytes)} bytes'
        )

        # Only PDF supported for dispatch
        if content_type != 'application/pdf' and not (file.filename or '').lower().endswith('.pdf'):
            raise HTTPException(
                status_code=400,
                detail='Only PDF files are supported for dispatch parsing.',
            )

        try:
            # ─── Render PDF to images via PyMuPDF ───
            # WHY: The Gemini Files API file reference is non-deterministic.
            # Sometimes it reads the correct PDF, sometimes it hallucinates
            # entirely different content. Rendering to images and sending raw
            # pixel data eliminates the variable — same approach as schedule.py.
            import fitz  # PyMuPDF

            doc = fitz.open(stream=file_bytes, filetype='pdf')
            image_parts: list[genai_types.Part] = []
            page_count = len(doc)

            for page_num in range(page_count):
                page = doc[page_num]
                # 300 DPI for clear text reading
                pix = page.get_pixmap(dpi=300)
                img_bytes = pix.tobytes('png')
                image_parts.append(
                    genai_types.Part.from_bytes(data=img_bytes, mime_type='image/png')
                )
                logger.info(
                    f'[parse-dispatch] Rendered page {page_num + 1}/{page_count} '
                    f'({pix.width}x{pix.height}, {len(img_bytes):,} bytes)'
                )

            doc.close()

            if not image_parts:
                raise HTTPException(status_code=400, detail='PDF has no pages.')

            # ─── PASS 1: Faithful text read (NO JSON forcing with images) ───
            # Landmine #6: response_mime_type='application/json' + media = miscounted data.
            # Text mode lets the model focus on carefully reading every column.
            logger.info(f'[parse-dispatch] Pass 1: Faithful text read ({len(image_parts)} pages, text mode, thinking enabled)...')
            pass1_response = _gemini_call_with_retry(
                client, model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(
                            text='Read this paving dispatch sheet. For EACH column with a numeric job number, output the column data with separate labeled sections: Job Number, Job Name, Job Description, Contract Type, Start Time, Load Time, Material, Plant, Trucking, Grinders, SUB Brooms, SUB Traffic Control, Foreman, Operators (list each name), Laborers (list each name), Rakers, Traffic Control, Equipment (list each item), Oil Truck, Rentals, Streets, Location.'
                        ),
                    ] + image_parts),
                ],
                config=genai_types.GenerateContentConfig(
                    system_instruction=DISPATCH_READ_PROMPT,
                    thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                    max_output_tokens=32768,
                ),
            )

            pass1_text = pass1_response.text.strip()
            logger.info(
                f'[parse-dispatch] Pass 1 result ({len(pass1_text)} chars): '
                f'{pass1_text[:8000]}'
            )

            # Guard: if Pass 1 returned nothing useful
            if not pass1_text or len(pass1_text) < 50:
                logger.warning('[parse-dispatch] Pass 1 returned empty/too short — aborting')
                return DispatchParseResponse(date='', company='', jobs=[])

            # ─── PASS 2: JSON parse from verified text (NO media, JSON forcing safe) ───
            pass2_prompt = DISPATCH_JSON_PROMPT.format(pass1_text=pass1_text)
            logger.info('[parse-dispatch] Pass 2: JSON parse from text (no media)...')
            response = _gemini_call_with_retry(
                client, model_name,
                contents=[pass2_prompt],
                config=genai_types.GenerateContentConfig(
                    thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                    response_mime_type='application/json',
                    max_output_tokens=65536,
                ),
            )

            data = _clean_json(response.text)
            raw_jobs = data.get('jobs', [])

            # Hard filter: only keep jobs with numeric job numbers.
            # The S/T legend and Crew Down sections sometimes slip through as fake "jobs".
            jobs = [
                j for j in raw_jobs
                if j.get('job_number', '').strip().isdigit()
            ]
            if len(jobs) < len(raw_jobs):
                dropped = len(raw_jobs) - len(jobs)
                logger.warning(
                    f'[parse-dispatch] Dropped {dropped} non-numeric job entries '
                    f'(S/T legend, Crew Down, etc.)'
                )

            logger.info(
                f'[parse-dispatch] Extracted {len(jobs)} jobs, '
                f'date={data.get("date", "")}, company={data.get("company", "")}'
            )
            for i, job in enumerate(jobs):
                logger.info(
                    f'[parse-dispatch]   Job {i}: #{job.get("job_number", "?")}, '
                    f'type={job.get("contract_type", "?")}, '
                    f'name="{job.get("job_name", "")}", '
                    f'operators={len(job.get("operators", []))}, '
                    f'laborers={len(job.get("laborers", []))}, '
                    f'equipment={len(job.get("equipment", []))}'
                )

            return DispatchParseResponse(
                date=data.get('date') or '',
                company=data.get('company') or '',
                jobs=jobs,
            )

        except ImportError:
            logger.exception('[parse-dispatch] Missing dependency: fitz (PyMuPDF)')
            raise HTTPException(
                status_code=500,
                detail='PyMuPDF (fitz) not installed. Run: pip install PyMuPDF',
            )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[parse-dispatch] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Generate TC (Traffic Control) Activity
# WHY: RE needs a professional TC activity description generated
#      from the TCP plan PDF + crew/location context.
# ============================================

TC_GENERATION_PROMPT = """You are a Resident Engineer writing a daily report activity for Traffic Control setup.

Write a professional, past-tense, factual description of the traffic control operations for this work day.

INPUTS PROVIDED:
- TC Plan PDF (if available): Contains the approved Traffic Control Plan with lane closure details, sign placements, and flagger positions
- TC Crew: Names and start times of traffic control personnel
- Sub TC: Subcontractor traffic control company details (if any)
- Work Location: Streets and stations where work occurred
- Work Description: What construction activity the TC supported
- Schedule/Shift: The shift designation
- Start/End Times: Overall work window

WRITING RULES:
- Past tense, factual, third person (e.g. "Traffic control was established...")
- Mention the TCP number if visible in the document
- Note when TC was set up (based on earliest crew start time)
- Describe lane closures, sign placement, and flagger positions based on the TCP
- If a sub TC company is used, mention them by name with their crew count
- Reference specific streets/intersections from the location data
- Keep it concise: 3-5 bullet points using plain text bullet format ("• " prefix)
- Each bullet should be on its own line
- Do NOT invent details not supported by the provided data
- If no TCP document is provided, write a generic but professional TC description based on the crew and location info

OUTPUT FORMAT:
Return ONLY the activity summary text (plain text bullet points starting with •). Do NOT use HTML tags (<ul>, <li>, etc.). No JSON wrapping, no extra commentary.
"""


class TCGenerateRequest(BaseModel):
    streets: list[str] = []
    location: str = ''
    tc_crew: list[dict[str, str]] = []  # [{name, time}]
    sub_tc: dict[str, Any] | None = None  # {company, details, count, time}
    work_description: str = ''
    schedule_shift: str = ''
    start_time: str = ''
    end_time: str = ''


class TCGenerateResponse(BaseModel):
    summary: str  # Professional TC description for the activity summary
    work_area: str  # e.g. 'Traffic Control'


# ── Constants for TC plan PDF lookup ──
TC_PLAN_KEYWORDS = ['tcp', 'traffic control', 'traffic_control']


def _find_tc_plan_pdf() -> str | None:
    """
    Find the Traffic Control Plan PDF.

    Resolution order:
    1. Check tc_plan_path from settings (direct file path on disk)
    2. Search data/specs/ for any PDF whose name contains TCP or traffic control
    """
    from app.core.paths import settings_file, specs_dir

    # ── Step 1: Check settings for explicit tc_plan_path ──
    settings_path = settings_file()
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
            tc_path = settings.get("tc_plan_path", "")
            if tc_path and os.path.isfile(tc_path) and tc_path.lower().endswith('.pdf'):
                logger.info(f'[generate-tc] Using TC plan from settings: {tc_path}')
                return tc_path
            if tc_path:
                logger.warning(f'[generate-tc] tc_plan_path in settings is not a valid PDF: {tc_path}')
        except Exception as exc:
            logger.warning(f'[generate-tc] Failed to read settings for tc_plan_path: {exc}')

    # ── Step 2: Scan data/specs/ ──
    specs_root = specs_dir()
    if not os.path.exists(specs_root):
        logger.debug('[generate-tc] specs directory does not exist')
        return None

    for item in os.listdir(specs_root):
        item_path = os.path.join(specs_root, item)
        if not os.path.isdir(item_path):
            continue
        # Each spec is stored in a subdirectory with metadata.json + the PDF
        metadata_path = os.path.join(item_path, "metadata.json")
        if not os.path.exists(metadata_path):
            continue
        try:
            with open(metadata_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            original_name = meta.get("original_name", "").lower()
            if any(kw in original_name for kw in TC_PLAN_KEYWORDS):
                # Find the actual PDF file in this directory
                for fname in os.listdir(item_path):
                    if fname.lower().endswith('.pdf'):
                        pdf_path = os.path.join(item_path, fname)
                        logger.info(f'[generate-tc] Found TC plan PDF in specs: {pdf_path}')
                        return pdf_path
        except Exception as exc:
            logger.warning(f'[generate-tc] Error reading metadata for {item}: {exc}')
            continue

    logger.info('[generate-tc] No TC plan PDF found')
    return None


@router.post('/generate-tc', response_model=TCGenerateResponse)
async def generate_tc(request: TCGenerateRequest):
    """
    Generate a professional TC activity description for a daily report.

    Checks data/specs/ for a TC plan PDF. If found, renders it to images
    and sends to Gemini with crew/location context. If not found, generates
    a description based solely on the provided crew and location data.
    """
    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        logger.info(
            f'[generate-tc] Request: location={request.location}, '
            f'streets={request.streets}, '
            f'tc_crew_count={len(request.tc_crew)}, '
            f'has_sub_tc={request.sub_tc is not None}'
        )

        # Build context text from the request data
        context_lines: list[str] = []

        if request.streets:
            context_lines.append(f"Streets: {', '.join(request.streets)}")
        if request.location:
            context_lines.append(f"Location: {request.location}")
        if request.work_description:
            context_lines.append(f"Work Description: {request.work_description}")
        if request.schedule_shift:
            context_lines.append(f"Shift: {request.schedule_shift}")
        if request.start_time:
            context_lines.append(f"Work Start Time: {request.start_time}")
        if request.end_time:
            context_lines.append(f"Work End Time: {request.end_time}")

        if request.tc_crew:
            context_lines.append("\nTC Crew:")
            for person in request.tc_crew:
                name = person.get('name', 'Unknown')
                tc_time = person.get('time', '')
                context_lines.append(f"  - {name} (start: {tc_time})")

        if request.sub_tc:
            sub_company = request.sub_tc.get('company', '')
            sub_details = request.sub_tc.get('details', '')
            sub_count = request.sub_tc.get('count', '')
            sub_time = request.sub_tc.get('time', '')
            context_lines.append(
                f"\nSub TC: {sub_company} — {sub_details}, "
                f"count: {sub_count}, time: {sub_time}"
            )

        context_text = '\n'.join(context_lines)
        logger.debug(f'[generate-tc] Context text:\n{context_text}')

        # Check for TC plan PDF in specs
        tc_plan_path = _find_tc_plan_pdf()
        image_parts: list[genai_types.Part] = []

        if tc_plan_path:
            try:
                import fitz  # PyMuPDF

                with open(tc_plan_path, "rb") as f:
                    pdf_bytes = f.read()

                doc = fitz.open(stream=pdf_bytes, filetype='pdf')
                page_count = len(doc)

                for page_num in range(page_count):
                    page = doc[page_num]
                    pix = page.get_pixmap(dpi=300)
                    img_bytes = pix.tobytes('png')
                    image_parts.append(
                        genai_types.Part.from_bytes(data=img_bytes, mime_type='image/png')
                    )
                    logger.info(
                        f'[generate-tc] Rendered TC plan page {page_num + 1}/{page_count} '
                        f'({pix.width}x{pix.height}, {len(img_bytes):,} bytes)'
                    )

                doc.close()
                logger.info(f'[generate-tc] TC plan rendered: {len(image_parts)} pages')

            except ImportError:
                logger.warning('[generate-tc] PyMuPDF not installed — skipping TC plan PDF')
            except Exception as exc:
                logger.warning(f'[generate-tc] Failed to render TC plan PDF: {exc}')

        # Build the user message
        user_text = f"Generate a Traffic Control activity description for this daily report.\n\n{context_text}"
        if image_parts:
            user_text = f"Here is the approved Traffic Control Plan (TCP) document, followed by today's TC crew and location details.\n\n{context_text}"

        user_parts = [genai_types.Part.from_text(text=user_text)] + image_parts

        logger.info(
            f'[generate-tc] Calling Gemini: '
            f'{len(image_parts)} TC plan pages, '
            f'{len(context_text)} chars context'
        )

        response = _gemini_call_with_retry(
            client, model_name,
            contents=[
                genai_types.Content(role='user', parts=user_parts),
            ],
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                system_instruction=TC_GENERATION_PROMPT,
                max_output_tokens=2048,
            ),
        )

        summary = response.text.strip()
        logger.info(f'[generate-tc] Generated summary ({len(summary)} chars): {summary[:500]}')

        # Build work_area from location/streets
        work_area = 'Traffic Control'
        if request.location:
            work_area = f"Traffic Control — {request.location}"
        elif request.streets:
            work_area = f"Traffic Control — {', '.join(request.streets[:3])}"

        return TCGenerateResponse(
            summary=_clean_summary_bullets(summary),
            work_area=work_area,
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[generate-tc] Error: {exc}')
        raise HTTPException(status_code=500, detail=str(exc))

