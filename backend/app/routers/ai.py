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
import re
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.config import GEMINI_API_KEY

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai", tags=["ai"])

# ============================================
# LAZY IMPORT — Only initialize Gemini when needed
# ============================================

def _get_gemini_client(model_name: str = "gemini-2.5-pro-preview-05-06"):
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
1. Use DIRECT field language. "Crews excavated from Sta 10+00 to 12+50" NOT "The construction workforce proceeded with excavation activities."
2. NO unnecessary adjectives: "properly," "efficiently," "successfully," "in accordance with" — DELETE.
3. NO corporate vocabulary: "utilized" → "used," "commenced" → "started," "implemented" → "installed."
4. STATION FORMAT: Always use "Sta XX+XX" (e.g. "Sta 10+50 to 12+00").
5. FIRST PERSON TO THIRD PERSON — ONLY when the sentence uses a first-person pronoun (we/I/our/us/my). Use the real subject (company, trade) when known. Use "The crew" only as a last resort. Do NOT prepend "The crew" to bullets already in third person.
6. Fix spelling, grammar, punctuation. Do NOT change technical terms or proper nouns.
7. Use "• " (bullet character) for ALL bullets in summary_html. NEVER use * or -.
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
    return json.loads(text)


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
        'summary_html': raw.get('summary_html', raw.get('description', '')),
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
    Audio is passed directly to Gemini — no intermediate transcription step.
    Supports: audio/webm, audio/m4a, audio/mp4, audio/wav, audio/ogg.
    """
    if not request.audio_data:
        raise HTTPException(status_code=400, detail='No audio data provided')

    client, model_name = _get_gemini_client()

    try:
        import base64
        from google.genai import types as genai_types

        audio_bytes = base64.b64decode(request.audio_data)
        logger.info(f'[transcribe] Audio: {len(audio_bytes)} bytes, mime: {request.mime_type}')

        context = request.context or {}
        project_name = context.get('project_name', 'this project')
        report_date = context.get('report_date', 'today')

        prompt = f"""You are a construction field assistant helping to transcribe and structure voice dictation.

The speaker is dictating notes for a construction daily field report.
Project: {project_name}
Date: {report_date}

TASK:
1. Transcribe the audio exactly (raw_transcription field)
2. Extract structured activities from the transcription
3. Apply all standard extraction rules below

The speaker may dictate:
- Work performed today (location, what was done)
- Manpower (who was there, how many, what trade)
- Equipment used (what equipment, how long)
- Extra work or T&M items
- General notes or observations

If the speaker mentions multiple work areas or locations, create a separate activity for each.

{STANDARD_EXTRACTION_RULES}

Return JSON:
{{
    "raw_transcription": "Exact words from the recording...",
    "activities": [
        {{
            "work_area": "Location - Company - Work Type",
            "summary_html": "• Bullet description.",
            "manpower": [...],
            "equipment": [...]
        }}
    ]
}}
"""

        response = client.models.generate_content(
            model=model_name,
            contents=[
                prompt,
                genai_types.Part.from_bytes(data=audio_bytes, mime_type=request.mime_type),
            ],
            config=genai_types.GenerateContentConfig(
                response_mime_type='application/json',
                max_output_tokens=32768,
            ),
        )

        data = _clean_json(response.text)
        activities = data.get('activities', [])
        raw_text = data.get('raw_transcription', '')

        logger.info(f'[transcribe] Extracted {len(activities)} activities, transcription: {len(raw_text)} chars')
        return TranscribeResponse(activities=activities, raw_transcription=raw_text)

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
• [Bullet points describing traffic control, work performed, observations, stationing, progress, etc.]

MANPOWER:
• [Trade/Role] - [Name if mentioned] - [Quantity] - [Hours] - [Pay rate if mentioned (ST/OT/DT)]
• Example: Laborer - 4 - 8 hrs - Straight Time
• Example: Operator - Joe - 1 - 10 hrs - Double Time

EQUIPMENT:
• [Equipment type] - [Description/Name if mentioned] - [Quantity] - [Hours]
• Example: Excavator - CAT 330 - 1 - 8 hrs
• Example: Dump Truck - 2 - 6 hrs

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
    Smart dictation: audio → structured JSON activity data.
    Used by the "Dictate" button inside an open activity editor.
    Returns summary_html + manpower/equipment arrays that populate directly.
    """
    if not request.audio_data:
        raise HTTPException(status_code=400, detail='No audio data provided')

    client, model_name = _get_gemini_client()

    try:
        import base64
        from google.genai import types as genai_types

        audio_bytes = base64.b64decode(request.audio_data)
        logger.info(f'[transcribe-smart] Audio: {len(audio_bytes)} bytes, mime: {request.mime_type}')

        ctx = request.context or {}
        work_area = ctx.get('work_area', '')
        project_name = ctx.get('project_name', 'this project')
        report_date = ctx.get('report_date', 'today')

        system_prompt = f"""You are an Expert Construction Field Assistant.

TASK: Listen to the field engineer's voice note and EXTRACT report data into structured JSON.

DICTATION-SPECIFIC RULES (speech is naturally unstructured):
1. RESTRUCTURE and ORGANIZE the spoken content into clear, logical bullet points in summary_html.
2. EXTRACT ALL MANPOWER AND EQUIPMENT into their JSON arrays. Do NOT write resource counts in summary_html.
3. You CAN rearrange text and add connecting words — but DO NOT add outside context or fabricate facts.
4. UNINTELLIGIBLE WORDS: Use "_____" placeholder and ask for clarification. Do NOT leave blanks silently.
5. If the ENTIRE audio is silent or unintelligible, return all empty fields.

PERSONA — Write like a 20-year pipeline construction superintendent:
- Direct, factual, specific. NOT like a technical writer or AI assistant.
- "Crews excavated from Sta 10+00 to 12+50" NOT "The construction workforce proceeded..."
- NO filler: "properly", "efficiently", "successfully", "in accordance with" — DELETE.
- NO AI vocabulary: "utilized" → "used", "commenced" → "started", "implemented" → "did/installed"
- Stationing: always "Sta XX+XX" format
- First-person to third-person ONLY when speaker says "we/I/our". Use company name when known.
- Past tense. "Placed concrete" NOT "Performing concrete work."
- Use "• " (bullet) for all bullets in summary_html. NEVER asterisks or dashes.

PROJECT CONTEXT:
- Project: {project_name}
- Date: {report_date}
- Current work area: {work_area or 'Not specified'}

{CONSTRUCTION_VOCAB}

{STANDARD_EXTRACTION_RULES}
"""

        user_prompt = "Field notes audio — parse into structured JSON for the activity editor."

        response = client.models.generate_content(
            model=model_name,
            contents=[
                system_prompt,
                user_prompt,
                genai_types.Part.from_bytes(data=audio_bytes, mime_type=request.mime_type),
            ],
            config=genai_types.GenerateContentConfig(
                response_mime_type='application/json',
                max_output_tokens=32768,
            ),
        )

        data = _clean_json(response.text)
        logger.info(f'[transcribe-smart] manpower={len(data.get("manpower", []))}, equipment={len(data.get("equipment", []))}')
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

        response = client.models.generate_content(
            model=model_name,
            contents=[system_prompt, user_prompt],
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

        response = client.models.generate_content(
            model=model_name,
            contents=[system_prompt, user_prompt],
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


