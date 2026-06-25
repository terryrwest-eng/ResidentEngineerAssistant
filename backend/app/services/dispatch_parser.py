"""
Daily Reporter V3 — Dispatch Parser Service

Extracted from ai.py /parse-dispatch endpoint into a reusable service.
Used by both the original parse-dispatch endpoint and the new dispatches router.

Architecture:
  1. Render PDF pages to 300 DPI PNG images via PyMuPDF
  2. Pass 1 (TEXT mode): Faithful column-by-column text read — no JSON forcing with media (Landmine #6)
  3. Pass 2 (JSON mode): Parse verified text into structured JSON — no media, safe to force JSON
  4. Hard filter: only keep jobs with numeric job numbers (strips S/T legend, Crew Down, etc.)
"""

import json
import logging
import re
import time
from typing import Any

from pydantic import BaseModel

from app.core.config import GEMINI_API_KEY

logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────────────
GEMINI_MODEL_NAME = "gemini-2.5-pro"
PDF_RENDER_DPI = 300
PASS1_THINKING_BUDGET = 24576
PASS1_MAX_OUTPUT_TOKENS = 32768
PASS2_MAX_OUTPUT_TOKENS = 65536
MIN_PASS1_TEXT_LENGTH = 50
MAX_RETRIES = 3


# ============================================
# Pydantic result model
# ============================================

class DispatchParseResult(BaseModel):
    """Structured result from parsing a dispatch PDF."""
    date: str = ''
    company: str = ''
    jobs: list[dict[str, Any]] = []


# ============================================
# LAZY IMPORT — Only initialize Gemini when needed
# WHY local: avoids import-time crash if google-genai isn't installed
# ============================================

def _get_gemini_client(model_name: str = GEMINI_MODEL_NAME) -> tuple[Any, str]:
    """Initialize the Gemini client on first use (matches ai.py pattern)."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured. Set it in .env")
    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        logger.debug("[dispatch-parser] Gemini client initialized")
        return client, model_name
    except ImportError:
        raise RuntimeError(
            "google-genai package not installed. Run: pip install google-genai"
        )


def _gemini_call_with_retry(
    client: Any, model_name: str, max_retries: int = MAX_RETRIES, **kwargs: Any
) -> Any:
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
                f'[dispatch-parser][gemini-retry] Attempt {attempt + 1}/{max_retries} got {exc.code}. '
                f'Retrying in {wait}s...'
            )
            time.sleep(wait)
        except ClientError as exc:
            if exc.code == 429:
                last_error = exc
                wait = 2 ** (attempt + 1)
                logger.warning(
                    f'[dispatch-parser][gemini-retry] Attempt {attempt + 1}/{max_retries} got 429. '
                    f'Retrying in {wait}s...'
                )
                time.sleep(wait)
            else:
                raise  # Non-retryable client error
    # All retries exhausted
    raise last_error  # type: ignore[misc]


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
        logger.warning(f'[dispatch-parser][_clean_json] Initial parse failed ({e}), trying brace-count extraction')
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


# ============================================
# AI PROMPTS — Dispatch Parsing (TWO-PASS)
# WHY two-pass: Landmine #6 — JSON forcing + media = hallucination.
# Pass 1 reads the image faithfully in text mode.
# Pass 2 parses that verified text into structured JSON (no images).
# ============================================

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


# ============================================
# MAIN PARSER FUNCTION
# ============================================

async def parse_dispatch_pdf(file_bytes: bytes, filename: str) -> DispatchParseResult:
    """
    Parse a dispatch PDF into structured job data.

    Uses the 2-pass Gemini approach:
      Pass 1: Render PDF to images → faithful text read (no JSON forcing)
      Pass 2: Parse verified text into structured JSON (no images)

    Returns DispatchParseResult with {date, company, jobs[]}.
    Raises RuntimeError on unrecoverable errors.
    """
    logger.info(
        f'[dispatch-parser] Starting parse: filename={filename}, '
        f'size={len(file_bytes):,} bytes'
    )

    client, model_name = _get_gemini_client()

    try:
        from google.genai import types as genai_types
    except ImportError:
        logger.exception('[dispatch-parser] Missing dependency: google-genai')
        raise RuntimeError("google-genai package not installed. Run: pip install google-genai")

    # ─── Render PDF to images via PyMuPDF ───
    # WHY: The Gemini Files API file reference is non-deterministic.
    # Sometimes it reads the correct PDF, sometimes it hallucinates
    # entirely different content. Rendering to images and sending raw
    # pixel data eliminates the variable — same approach as schedule.py.
    try:
        import fitz  # PyMuPDF
    except ImportError:
        logger.exception('[dispatch-parser] Missing dependency: fitz (PyMuPDF)')
        raise RuntimeError('PyMuPDF (fitz) not installed. Run: pip install PyMuPDF')

    doc = fitz.open(stream=file_bytes, filetype='pdf')
    image_parts: list[Any] = []
    page_count = len(doc)

    for page_num in range(page_count):
        page = doc[page_num]
        pix = page.get_pixmap(dpi=PDF_RENDER_DPI)
        img_bytes = pix.tobytes('png')
        image_parts.append(
            genai_types.Part.from_bytes(data=img_bytes, mime_type='image/png')
        )
        logger.info(
            f'[dispatch-parser] Rendered page {page_num + 1}/{page_count} '
            f'({pix.width}x{pix.height}, {len(img_bytes):,} bytes)'
        )

    doc.close()

    if not image_parts:
        logger.warning('[dispatch-parser] PDF has no pages — returning empty result')
        return DispatchParseResult(date='', company='', jobs=[])

    # ─── PASS 1: Faithful text read (NO JSON forcing with images) ───
    # Landmine #6: response_mime_type='application/json' + media = miscounted data.
    # Text mode lets the model focus on carefully reading every column.
    logger.info(
        f'[dispatch-parser] Pass 1: Faithful text read '
        f'({len(image_parts)} pages, text mode, thinking enabled)...'
    )
    pass1_response = _gemini_call_with_retry(
        client, model_name,
        contents=[
            genai_types.Content(role='user', parts=[
                genai_types.Part.from_text(
                    text=(
                        'Read this paving dispatch sheet. For EACH column with a numeric '
                        'job number, output the column data with separate labeled sections: '
                        'Job Number, Job Name, Job Description, Contract Type, Start Time, '
                        'Load Time, Material, Plant, Trucking, Grinders, SUB Brooms, '
                        'SUB Traffic Control, Foreman, Operators (list each name), '
                        'Laborers (list each name), Rakers, Traffic Control, Equipment '
                        '(list each item), Oil Truck, Rentals, Streets, Location.'
                    )
                ),
            ] + image_parts),
        ],
        config=genai_types.GenerateContentConfig(
            system_instruction=DISPATCH_READ_PROMPT,
            thinking_config=genai_types.ThinkingConfig(thinking_budget=PASS1_THINKING_BUDGET),
            max_output_tokens=PASS1_MAX_OUTPUT_TOKENS,
        ),
    )

    pass1_text = pass1_response.text.strip()
    logger.info(
        f'[dispatch-parser] Pass 1 result ({len(pass1_text)} chars): '
        f'{pass1_text[:8000]}'
    )

    # Guard: if Pass 1 returned nothing useful
    if not pass1_text or len(pass1_text) < MIN_PASS1_TEXT_LENGTH:
        logger.warning('[dispatch-parser] Pass 1 returned empty/too short — returning empty result')
        return DispatchParseResult(date='', company='', jobs=[])

    # ─── PASS 2: JSON parse from verified text (NO media, JSON forcing safe) ───
    pass2_prompt = DISPATCH_JSON_PROMPT.format(pass1_text=pass1_text)
    logger.info('[dispatch-parser] Pass 2: JSON parse from text (no media)...')
    response = _gemini_call_with_retry(
        client, model_name,
        contents=[pass2_prompt],
        config=genai_types.GenerateContentConfig(
            response_mime_type='application/json',
            max_output_tokens=PASS2_MAX_OUTPUT_TOKENS,
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
            f'[dispatch-parser] Dropped {dropped} non-numeric job entries '
            f'(S/T legend, Crew Down, etc.)'
        )

    logger.info(
        f'[dispatch-parser] Extracted {len(jobs)} jobs, '
        f'date={data.get("date", "")}, company={data.get("company", "")}'
    )
    for i, job in enumerate(jobs):
        logger.info(
            f'[dispatch-parser]   Job {i}: #{job.get("job_number", "?")}, '
            f'type={job.get("contract_type", "?")}, '
            f'name="{job.get("job_name", "")}", '
            f'operators={len(job.get("operators", []))}, '
            f'laborers={len(job.get("laborers", []))}, '
            f'equipment={len(job.get("equipment", []))}'
        )

    return DispatchParseResult(
        date=data.get('date') or '',
        company=data.get('company') or '',
        jobs=jobs,
    )
