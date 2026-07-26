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

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.config import GEMINI_API_KEY

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai", tags=["ai"])


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

def _get_gemini_client(model_name: str = "gemini-2.5-pro"):
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
2. NO unnecessary adjectives: "properly," "efficiently," "successfully," "in accordance with" — DELETE.
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
            resp = client.models.generate_content(
                model=model_name,
                contents=[NOTE_SCAN_PROMPT] + parts_list,
                config=genai_types.GenerateContentConfig(
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

        response = client.models.generate_content(
            model=model_name,
            contents=[prompt, genai_types.Part.from_bytes(data=content, mime_type=mime_type)],
            config=genai_types.GenerateContentConfig(
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

        response = client.models.generate_content(
            model=model_name,
            contents=[CONSULTANT_PROMPT, genai_types.Part.from_bytes(data=content, mime_type=mime_type)],
            config=genai_types.GenerateContentConfig(
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
        import base64
        from google.genai import types as genai_types

        audio_bytes = base64.b64decode(request.audio_data)
        logger.info(f'[transcribe] Audio: {len(audio_bytes)} bytes, mime: {request.mime_type}')

        # Guard: reject tiny audio that can't contain speech
        if len(audio_bytes) < 2000:
            logger.warning(f'[transcribe] Audio too small ({len(audio_bytes)} bytes), likely empty')
            return TranscribeResponse(
                activities=[],
                raw_transcription='Recording too short — please try again.'
            )

        context = request.context or {}
        project_name = context.get('project_name', 'this project')
        report_date = context.get('report_date', 'today')

        # ─── PASS 1: Faithful transcription (TEXT mode, NOT JSON) ───
        # Uses DICTATION_SYSTEM_PROMPT which was battle-tested over field sessions.
        # Text mode means the model focuses on hearing the audio correctly,
        # not on filling a JSON schema.
        pass1_prompt = f"""{DICTATION_SYSTEM_PROMPT}

PROJECT CONTEXT:
- Project: {project_name}
- Date: {report_date}

Listen to the audio and transcribe it now. Organize into WORK DESCRIPTION, MANPOWER, and EQUIPMENT sections as instructed above.
"""

        logger.info('[transcribe] Pass 1: Faithful transcription (text mode)...')
        pass1_response = client.models.generate_content(
            model=model_name,
            contents=[
                pass1_prompt,
                genai_types.Part.from_bytes(data=audio_bytes, mime_type=request.mime_type),
            ],
            config=genai_types.GenerateContentConfig(
                max_output_tokens=16384,
            ),
        )

        raw_transcription = pass1_response.text.strip()
        logger.info(f'[transcribe] Pass 1 result ({len(raw_transcription)} chars): {raw_transcription[:500]}')

        # Guard: if model couldn't hear anything
        if not raw_transcription or raw_transcription.startswith('| Please try again'):
            logger.warning('[transcribe] Pass 1 returned empty or "couldn\'t hear" — no activities')
            return TranscribeResponse(
                activities=[],
                raw_transcription=raw_transcription or 'Could not understand the recording. Please try again.'
            )

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
        pass2_response = client.models.generate_content(
            model=model_name,
            contents=[pass2_prompt],
            config=genai_types.GenerateContentConfig(
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
- Provide context around the unintelligible word, use "_____" for the blank, then ask:
  "Please provide the correct word for the blank."
- Example: "• The trench was excavated to 5 feet. We encountered a _____ pipe. We stopped work immediately. Please provide the correct word for the blank."

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
        import base64
        from google.genai import types as genai_types

        audio_bytes = base64.b64decode(request.audio_data)
        logger.info(f'[transcribe-smart] Audio: {len(audio_bytes)} bytes, mime: {request.mime_type}')

        # Guard: reject tiny audio
        if len(audio_bytes) < 2000:
            logger.warning(f'[transcribe-smart] Audio too small ({len(audio_bytes)} bytes), likely empty')
            return SmartDictationResponse(
                summary_html='',
                work_area='',
                manpower=[],
                equipment=[],
            )

        ctx = request.context or {}
        work_area = ctx.get('work_area', '')
        project_name = ctx.get('project_name', 'this project')
        report_date = ctx.get('report_date', 'today')

        # ─── PASS 1: Faithful transcription (TEXT mode, NOT JSON) ───
        pass1_prompt = f"""{DICTATION_SYSTEM_PROMPT}

PROJECT CONTEXT:
- Project: {project_name}
- Date: {report_date}
- Current work area: {work_area or 'Not specified'}

VERBOSITY RULE: Capture EVERY detail the speaker mentions. Do NOT summarize or compress.
If they speak 10 sentences of detail, output 10 sentences of detail. More is better than less.

Listen to the audio and transcribe it now. Organize into WORK DESCRIPTION, MANPOWER, and EQUIPMENT sections as instructed above.
"""

        logger.info('[transcribe-smart] Pass 1: Faithful transcription (text mode)...')
        pass1_response = client.models.generate_content(
            model=model_name,
            contents=[
                pass1_prompt,
                genai_types.Part.from_bytes(data=audio_bytes, mime_type=request.mime_type),
            ],
            config=genai_types.GenerateContentConfig(
                max_output_tokens=16384,
            ),
        )

        raw_transcription = pass1_response.text.strip()
        logger.info(f'[transcribe-smart] Pass 1 result ({len(raw_transcription)} chars): {raw_transcription[:500]}')

        # Guard: if model couldn't hear anything
        if not raw_transcription or raw_transcription.startswith('| Please try again'):
            logger.warning('[transcribe-smart] Pass 1 returned empty — no data')
            return SmartDictationResponse(
                summary_html='',
                work_area='',
                manpower=[],
                equipment=[],
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
        pass2_response = client.models.generate_content(
            model=model_name,
            contents=[pass2_prompt],
            config=genai_types.GenerateContentConfig(
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

        response = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
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

        response = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
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

        response = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
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

        # ─── AUDIO PROCESSING (two-pass) ───
        if request.audio_data:
            audio_bytes = base64.b64decode(request.audio_data)
            logger.info(f'[report-chat] Audio received: {len(audio_bytes)} bytes, mime: {request.mime_type}')

            # Guard: reject tiny audio
            if len(audio_bytes) < 2000:
                logger.warning(f'[report-chat] Audio too small ({len(audio_bytes)} bytes)')
                return ReportChatResponse(
                    reply="I couldn't hear anything — the recording was too short. Please try again and speak for at least a few seconds.",
                    transcription=''
                )

            # Pass 1: Faithful transcription (TEXT mode)
            pass1_prompt = f"""{DICTATION_SYSTEM_PROMPT}

PROJECT CONTEXT:
- Project: {request.report.get('general', {}).get('project_name', 'this project')}
- Date: {request.report.get('general', {}).get('report_date', 'today')}

Listen to the audio and transcribe it now. Organize into WORK DESCRIPTION, MANPOWER, and EQUIPMENT sections as instructed above.
"""

            logger.info('[report-chat] Pass 1: Transcribing audio (text mode)...')
            pass1_response = client.models.generate_content(
                model=model_name,
                contents=[
                    pass1_prompt,
                    genai_types.Part.from_bytes(data=audio_bytes, mime_type=request.mime_type),
                ],
                config=genai_types.GenerateContentConfig(
                    max_output_tokens=16384,
                ),
            )

            transcription = pass1_response.text.strip()
            logger.info(f'[report-chat] Transcription ({len(transcription)} chars): {transcription[:300]}')

            # Guard: unintelligible audio
            if not transcription or transcription.startswith('| Please try again'):
                return ReportChatResponse(
                    reply="I couldn't understand what you said. Could you try again? Speak clearly and close to the mic.",
                    transcription=transcription or ''
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

        response = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=genai_types.GenerateContentConfig(
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

NEUTRAL TONE (CRITICAL):
- Use ONLY neutral, factual statements describing work performed
- DO NOT include judgments, opinions, or evaluations
- NEVER use words like: good, well, safe, proper, correct, excellent, satisfactory, successful, quality
- Simply state WHAT was done, not how well it was done

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

        response = client.models.generate_content(
            model=model_name,
            contents=[system_prompt, f'RAW FIELD NOTES TO TRANSFORM:\n{request.text}'],
            config=genai_types.GenerateContentConfig(
                max_output_tokens=4096,
            ),
        )

        text = response.text.strip()
        text = re.sub(r'```[a-z]*\n?', '', text).strip()
        cleaned_text = _clean_summary_bullets(text)
        logger.info(f'[rewrite] Polished {len(cleaned_text)} chars')
        return {'status': 'success', 'text': cleaned_text}

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f'[rewrite] Error: {exc}')
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


class BulkDictateRequest(BaseModel):
    audio_data: str
    mime_type: str = 'audio/webm'


@router.post('/bulk-dictate-activities', response_model=BulkDictationResponse)
async def bulk_dictate_activities_v2(request: BulkDictateRequest):
    """
    Transcribe audio and split into multiple activities by location.

    TWO-PASS APPROACH (prevents hallucination):
      Pass 1 — TEXT MODE: Upload audio to Gemini Files API, transcribe faithfully.
               No JSON forcing = model focuses on hearing the audio correctly.
      Pass 2 — JSON MODE: Take the verified transcription text and parse it into
               separate activities split by location.

    WHY NOT ONE PASS: Forcing JSON output while transcribing audio causes the model
    to prioritize filling the JSON schema over faithful transcription. It fabricates
    plausible-sounding construction content instead of transcribing what was said.
    """
    import base64
    import os
    import tempfile

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types

        audio_data = request.audio_data
        if 'base64,' in audio_data:
            audio_data = audio_data.split('base64,')[1]
        audio_bytes = base64.b64decode(audio_data)
        logger.info(f'[bulk-dictate] Audio decoded. Size: {len(audio_bytes)} bytes')

        # Guard: reject tiny audio
        if len(audio_bytes) < 2000:
            logger.warning(f'[bulk-dictate] Audio too small ({len(audio_bytes)} bytes), likely empty')
            return BulkDictationResponse(activities=[], raw_transcription='Recording too short.')

        suffix_map = {'audio/webm': '.webm', 'audio/mp3': '.mp3', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav'}
        suffix = suffix_map.get(request.mime_type, '.webm')

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name

            uploaded = client.files.upload(file=tmp_path, config={'mime_type': request.mime_type})
            logger.info(f'[bulk-dictate] File uploaded: {uploaded.name}')

            # ─── PASS 1: Faithful transcription (TEXT mode, NOT JSON) ───
            pass1_prompt = f"""{DICTATION_SYSTEM_PROMPT}

VERBOSITY RULE: Capture EVERY detail the speaker mentions. Do NOT summarize or compress.
If they speak 10 sentences of detail, output 10 sentences of detail. More is better than less.
Include ALL station numbers, measurements, quantities, pipe sizes, crew counts, and specific details.

Listen to the audio and transcribe it now. Organize into WORK DESCRIPTION, MANPOWER, and EQUIPMENT sections as instructed above.
"""

            logger.info('[bulk-dictate] Pass 1: Faithful transcription (text mode)...')
            pass1_response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(text=pass1_prompt),
                        genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type=request.mime_type),
                    ]),
                ],
                config=genai_types.GenerateContentConfig(
                    max_output_tokens=16384,
                ),
            )

            raw_transcription = pass1_response.text.strip()
            logger.info(f'[bulk-dictate] Pass 1 result ({len(raw_transcription)} chars): {raw_transcription[:1000]}')

            # Guard: if model couldn't hear anything
            if not raw_transcription or raw_transcription.startswith('| Please try again'):
                logger.warning('[bulk-dictate] Pass 1 returned empty — no data')
                return BulkDictationResponse(
                    activities=[],
                    raw_transcription=raw_transcription or 'Could not understand the recording. Please try again.',
                )

            # ─── PASS 2: Parse transcription into MULTIPLE activities by location ───
            # NOTE: Using string concat (not f-string) because raw_transcription
            # may contain literal { } that break f-string parsing.
            pass2_prompt = (
                'You are a construction field data parser. Parse the transcription below into MULTIPLE activities, split by location.\n\n'
                'CRITICAL RULES:\n'
                '1. Each distinct LOCATION or work area becomes a SEPARATE activity.\n'
                '2. Listen for location changes: "At Station...", "Moving to...", "Over at...", "Next we have...", "Also at..."\n'
                '3. DO NOT add any information that is not in the transcription. DO NOT fabricate details.\n'
                '4. The summary_html for each activity MUST contain EVERY detail mentioned for that location.\n'
                '   Do NOT summarize or compress. Keep ALL station numbers, measurements, quantities, and specifics.\n'
                '5. EXTRACT manpower and equipment into their JSON arrays for each activity. Remove resource counts from summary_html.\n'
                '6. Use the \u2022 (bullet) character for all bullets in summary_html. Never asterisks or dashes.\n'
                '7. If all work is at one location, return a SINGLE activity in the array with ALL the detail.\n'
                '8. Do NOT use HTML tags (<p>, <ul>, <li>, etc.). Use PLAIN TEXT with \u2022 bullet characters separated by newlines.\n'
                '9. COMPANY NAMES ARE CRITICAL: When the speaker mentions a company, contractor, or subcontractor name, ALWAYS include it in the "company" field of EVERY manpower and equipment row for that company. Never leave company blank if it was spoken.\n'
                '10. TIME FORMAT: Use standard 12-hour AM/PM format (e.g., "7:00 AM", "3:30 PM"). NEVER use military/24-hour time (e.g., NOT "15:00" or "0700").\n\n'
                'TRANSCRIPTION TO PARSE:\n'
                '---\n'
                + raw_transcription + '\n'
                '---\n\n'
                'Return a JSON object with exactly these fields:\n'
                '- "activities": array of activity objects, each containing:\n'
                '    - "work_area": string (Location - Company - Work Type)\n'
                '    - "stations": string (station range if mentioned, e.g. "Sta 100+00 to 101+50", or empty string if not mentioned)\n'
                '    - "summary_html": string (PLAIN TEXT, not HTML. Each detail on its own line starting with \u2022 character)\n'
                '    - "manpower": array of objects with: trade, name, company (MUST include if spoken), qty, hours, start_time (AM/PM), stop_time (AM/PM), is_extra_work, is_3rd_party, is_consultant\n'
                '    - "equipment": array of objects with: name (specific unit), description (equipment type), company (MUST include if spoken), qty, hours, start_time (AM/PM), stop_time (AM/PM), is_extra_work, is_3rd_party, is_rental\n'
                '- "locations": string (comma-separated list of all locations)\n'
                '- "general_notes": string (1-2 sentence HIGH-LEVEL executive overview of the day. Example: "Continued pipeline installation along Morena Blvd with 4 active work areas. Weather clear, no delays." Do NOT repeat station numbers, crew counts, pipe sizes, or equipment details — those belong in the individual activity summaries. Think superintendent elevator pitch, not activity recap.)\n'
            )

            logger.info('[bulk-dictate] Pass 2: Parsing into activities by location (JSON mode)...')
            pass2_response = client.models.generate_content(
                model=model_name,
                contents=[pass2_prompt],
                config=genai_types.GenerateContentConfig(
                    response_mime_type='application/json',
                    max_output_tokens=32768,
                ),
            )

            raw_text = pass2_response.text
            logger.info(f'[bulk-dictate] Pass 2 raw response (first 2000 chars): {raw_text[:2000]}')
            data = _clean_json(raw_text)

            # Inject the full raw transcription from Pass 1
            data['raw_transcription'] = raw_transcription

            activities = data.get('activities', [])
            logger.info(f'[bulk-dictate] Parsed {len(activities)} activities')

            # Debug: Log each activity's structure so we can catch silent drops
            for i, act in enumerate(activities):
                has_summary = bool(act.get('summary_html') or act.get('summary'))
                mp_count = len(act.get('manpower', []))
                eq_count = len(act.get('equipment', []))
                work_area = act.get('work_area', 'NO WORK AREA')
                logger.info(
                    f'[bulk-dictate] Activity {i}: work_area="{work_area}", '
                    f'has_summary={has_summary}, manpower={mp_count}, equipment={eq_count}'
                )
                # If AI used 'summary' instead of 'summary_html', remap it
                if not act.get('summary_html') and act.get('summary'):
                    logger.warning(f'[bulk-dictate] Activity {i}: AI used "summary" instead of "summary_html" — remapping')
                    act['summary_html'] = act['summary']
                if mp_count == 0:
                    logger.warning(f'[bulk-dictate] Activity {i}: ZERO manpower returned by AI')
                if eq_count == 0:
                    logger.warning(f'[bulk-dictate] Activity {i}: ZERO equipment returned by AI')

            return BulkDictationResponse(**{k: data.get(k, v) for k, v in BulkDictationResponse().model_dump().items()})

        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

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

            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(text=prompt),
                        genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type=content_type),
                    ]),
                ],
                config=genai_types.GenerateContentConfig(
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

            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(text=prompt),
                        genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type='audio/webm'),
                    ]),
                ],
                config=genai_types.GenerateContentConfig(
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

            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Content(role='user', parts=[
                        genai_types.Part.from_text(text='Parse this completed daily report into structured JSON.'),
                        genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type=content_type),
                    ]),
                ],
                config=genai_types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type='application/json',
                    max_output_tokens=32768,
                ),
            )

            data = _clean_json(response.text)
            activities = data.get('activities', [])
            logger.info(f'[parse-report] Extracted {len(activities)} activities')

            # Create the report in storage
            from app.services.reports import create_report
            import uuid
            from datetime import datetime

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

            saved = await create_report(report_data)
            report_id = saved.get('id', report_data['id'])

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
                    thinking_config=genai_types.ThinkingConfig(thinking_budget=24576),
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
    _base = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

    # ── Step 1: Check settings for explicit tc_plan_path ──
    settings_path = os.path.join(_base, "data", "settings.json")
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
    specs_dir = os.path.join(_base, "data", "specs")
    if not os.path.exists(specs_dir):
        logger.debug('[generate-tc] specs directory does not exist')
        return None

    for item in os.listdir(specs_dir):
        item_path = os.path.join(specs_dir, item)
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

