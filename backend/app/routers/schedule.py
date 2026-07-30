"""Daily Reporter V3 — Schedule Router (Digout & Grind/Overlay Schedules)

Endpoints:
  POST   /api/schedule/upload       → Upload image-based schedule PDF → AI parses table
  GET    /api/schedule/active       → Get most recently uploaded schedule
  GET    /api/schedule/list         → List all uploaded schedules
  DELETE /api/schedule/{schedule_id} → Delete a schedule

The schedule PDF is IMAGE-BASED (no selectable text — just an embedded raster image).
It contains a landscape table with rows organized by SHIFT number or date.

Two schedule types are supported:
  - DIGOUT: rows have Direction, DO#, Depth, Width (W), Length (L), SF, Tons
  - GRIND & OVERLAY: rows have Direction, DO#, Depth, SF, Tons (NO Width/Length columns)

The AI auto-detects the type based on column presence.

WHY PyMuPDF: Since the PDF has no text layer, we render each page to a high-res image
and send it to Gemini 2.5 Pro for visual/multimodal table extraction.
"""

import json
import logging
import os
import re
import time
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.config import GEMINI_API_KEY, GEMINI_MODEL_NAME, GEMINI_THINKING_LEVEL

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/schedule", tags=["schedule"])

# Data directory for schedules
from app.core.paths import SCHEDULES_DIR  # noqa: E402

os.makedirs(SCHEDULES_DIR, exist_ok=True)


# ============================================
# LAZY IMPORT — Only initialize Gemini when needed
# WHY local: avoids circular imports from ai.py
# ============================================

def _get_gemini_client(model_name: str = GEMINI_MODEL_NAME):
    """Initialize the Gemini client on first use (matches ai.py pattern)."""
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured. Set it in .env")
    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        return client, model_name
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="google-genai package not installed. Run: pip install google-genai",
        )


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
            if exc.code == 429:
                last_error = exc
                wait = 2 ** (attempt + 1)
                logger.warning(
                    f'[gemini-retry] Attempt {attempt + 1}/{max_retries} got 429. '
                    f'Retrying in {wait}s...'
                )
                time.sleep(wait)
            else:
                raise
    raise last_error  # type: ignore[misc]


def _clean_json(text: str) -> dict[str, Any]:
    """Strip markdown fencing and extract the JSON object."""
    text = re.sub(r'```json\s*', '', text)
    text = re.sub(r'```\s*', '', text)
    if '{' in text:
        text = text[text.find('{'):]
    if '}' in text:
        text = text[:text.rfind('}') + 1]
    return json.loads(text)


# ============================================
# AI PROMPTS — Schedule Table Extraction (TWO-PASS)
# WHY two-pass: Landmine #6 — JSON forcing + media = hallucination.
# Pass 1 reads the image faithfully in text mode.
# Pass 2 parses that verified text into structured JSON (no images).
# ============================================

SCHEDULE_READ_PROMPT = """You are reading an image of a construction SCHEDULE table (either DIGOUT or GRIND & OVERLAY).

Your ONLY job is to transcribe EXACTLY what you see in the table. Do NOT invent, guess, or infer any data.

FIRST, determine the SCHEDULE TYPE by checking the columns:
- If the table has Width (W) and Length (L) columns → it is a DIGOUT schedule
- If the table has SF and Tons but NO Width/Length columns → it is a GRIND & OVERLAY schedule

State the detected type on the first line: TYPE=DIGOUT or TYPE=GRIND_OVERLAY

The table has rows grouped under HEADERS. Each header could be:
- A DATE (e.g., "June 9, 2026", "6/9/26", "Monday 6/9")
- A SHIFT label (e.g., "Shift 1", "Night 1")
- Any other grouping label

Use the EXACT header text from the table as the group label. Do NOT rename or renumber them.

For DIGOUT schedules, output each row as:
GROUP [exact header text] | [direction] | DO#[do_number] | [depth]' | W=[width] | L=[length] | SF=[sf] | TONS=[tons] | ADDED=[yes/no]

For GRIND & OVERLAY schedules, output each row as:
GROUP [exact header text] | [direction] | DO#[do_number] | [depth]' | SF=[sf] | TONS=[tons] | ADDED=[yes/no]

RULES:
- Read EVERY row. Count them carefully.
- SKIP rows labeled "TOTAL", "SUBTOTAL", or "Total" — these are summary rows, NOT data entries. Do NOT include them in the output.
- If a cell is blank or contains "W" or is unclear, write "?" for that value.
- After each group, write: === GROUP [exact header text] TOTAL: [count] rows ===
- At the very end, write: === GRAND TOTAL: [total_rows] rows across [total_groups] groups ===
- Do NOT skip any rows (except TOTAL/SUBTOTAL rows). Do NOT add any rows that aren't in the image.
- If you're unsure about a value, write exactly what you see with a "?" suffix.
"""

SCHEDULE_JSON_PROMPT = """Parse the following schedule table transcription into structured JSON.

Each line represents one row. Parse the values from the pipe-delimited format.
Group rows by their GROUP label (whatever text appears after "GROUP" — could be a date, shift number, etc.)
Use the EXACT group label as the key in the shifts object.
For any value that is "?" or missing, use 0.
SKIP any lines that are TOTAL or SUBTOTAL summaries — only include actual data rows.
Calculate total_sf and total_tons for each group from the individual row values.

IMPORTANT: Check the first line for TYPE=DIGOUT or TYPE=GRIND_OVERLAY.
- For DIGOUT rows: include width and length fields.
- For GRIND_OVERLAY rows: set width to 0 and length to 0.
- Include the schedule_type field in the top-level JSON.

TRANSCRIPTION:
{pass1_text}

Return JSON:
{{
  "schedule_type": "digout",
  "shifts": {{
    "June 9, 2026": {{
      "rows": [
        {{"direction": "SB #2", "do_number": "26", "depth": 0.5, "width": 11, "length": 10, "sf": 1210, "tons": 90.75, "added": false}}
      ],
      "total_sf": 1210,
      "total_tons": 90.75
    }}
  }}
}}

For GRIND_OVERLAY type, the JSON looks the same but schedule_type is "grind_overlay" and width/length are always 0:
{{
  "schedule_type": "grind_overlay",
  "shifts": {{
    "June 23, 2026": {{
      "rows": [
        {{"direction": "WB Outside", "do_number": "15", "depth": 0.15, "width": 0, "length": 0, "sf": 5000, "tons": 375, "added": false}}
      ],
      "total_sf": 5000,
      "total_tons": 375
    }}
  }}
}}
"""


# ============================================
# RESPONSE MODELS
# ============================================

class ScheduleUploadResponse(BaseModel):
    id: str
    filename: str
    uploaded_at: str
    total_shifts: int
    schedule_type: str = 'digout'  # 'digout' or 'grind_overlay'
    shifts: dict[str, Any]


class ScheduleListItem(BaseModel):
    id: str
    filename: str
    uploaded_at: str
    total_shifts: int
    schedule_type: str = 'digout'


# ============================================
# ENDPOINT: Upload + Parse Schedule PDF
# ============================================

@router.post("/upload", response_model=ScheduleUploadResponse)
async def upload_schedule(file: UploadFile = File(...)):
    """
    Upload an image-based schedule PDF.

    Flow:
      1. Validate PDF content type
      2. Render PDF pages to high-res images via PyMuPDF (fitz)
      3. Send images to Gemini 2.5 Pro for visual table parsing
      4. Save parsed JSON + original PDF to data/schedules/{id}/
      5. Return the parsed schedule
    """
    content_type = file.content_type or "application/octet-stream"
    if content_type != "application/pdf" and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported for schedule upload.")

    client, model_name = _get_gemini_client()

    try:
        import fitz  # PyMuPDF
        from google.genai import types as genai_types

        file_bytes = await file.read()
        logger.info(
            f"[schedule/upload] File: {file.filename}, type: {content_type}, "
            f"size: {len(file_bytes)} bytes"
        )

        if len(file_bytes) < 100:
            raise HTTPException(status_code=400, detail="File is too small to be a valid PDF.")

        # ─── Render PDF pages to images ───
        # WHY: The schedule PDF is image-based (no text layer).
        # PyMuPDF renders each page to a high-res PNG for Gemini to read visually.
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        image_parts: list[genai_types.Part] = []
        page_count = len(doc)

        for page_num in range(page_count):
            page = doc[page_num]
            # 300 DPI for clear table reading (72 DPI default is too blurry for small text)
            pix = page.get_pixmap(dpi=300)
            img_bytes = pix.tobytes("png")
            image_parts.append(
                genai_types.Part.from_bytes(data=img_bytes, mime_type="image/png")
            )
            logger.info(
                f"[schedule/upload] Rendered page {page_num + 1}/{page_count} "
                f"({pix.width}x{pix.height}, {len(img_bytes):,} bytes)"
            )

        doc.close()

        if not image_parts:
            raise HTTPException(status_code=400, detail="PDF has no pages.")

        # ─── PASS 1: Faithful text read (NO JSON forcing) ───
        # WHY: Landmine #6 — JSON forcing + media = hallucination.
        # Text mode lets the model focus on accurately reading the image.
        logger.info(f"[schedule/upload] PASS 1: Sending {len(image_parts)} page images for faithful text read...")

        pass1_response = _gemini_call_with_retry(
            client, model_name,
            contents=[SCHEDULE_READ_PROMPT] + image_parts,
            config=genai_types.GenerateContentConfig(
                max_output_tokens=32768,
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
            ),
        )

        pass1_text = pass1_response.text
        logger.info(f"[schedule/upload] PASS 1 complete. Output length: {len(pass1_text)} chars")
        logger.info(f"[schedule/upload] PASS 1 output preview:\n{pass1_text[:2000]}")

        # Count rows from Pass 1 output for verification
        row_lines = [line for line in pass1_text.splitlines() if line.strip().startswith("SHIFT")]
        grand_total_match = re.search(r"GRAND TOTAL:\s*(\d+)\s*rows", pass1_text)
        logger.info(
            f"[schedule/upload] PASS 1 row count: {len(row_lines)} data lines, "
            f"grand total line says: {grand_total_match.group(1) if grand_total_match else 'not found'}"
        )

        # ─── PASS 2: JSON parse from verified text (NO images) ───
        # WHY: JSON forcing is safe here — no media, just text.
        logger.info("[schedule/upload] PASS 2: Parsing verified text into structured JSON...")

        pass2_prompt = SCHEDULE_JSON_PROMPT.format(pass1_text=pass1_text)

        pass2_response = _gemini_call_with_retry(
            client, model_name,
            contents=[pass2_prompt],
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                response_mime_type="application/json",
                max_output_tokens=65536,
            ),
        )

        data = _clean_json(pass2_response.text)
        shifts = data.get("shifts", {})
        total_shifts = len(shifts)
        # Auto-detect schedule type from AI response (defaults to 'digout' for backward compat)
        schedule_type = data.get("schedule_type", "digout")
        if schedule_type not in ("digout", "grind_overlay"):
            schedule_type = "digout"

        logger.info(f"[schedule/upload] PASS 2 complete. Type: {schedule_type}, Parsed {total_shifts} shifts")
        for shift_num, shift_data in shifts.items():
            rows = shift_data.get("rows", [])
            total_sf = shift_data.get("total_sf", 0)
            total_tons = shift_data.get("total_tons", 0)
            logger.info(
                f"[schedule/upload]   Shift {shift_num}: {len(rows)} rows, "
                f"SF={total_sf}, Tons={total_tons}"
            )

        # ─── Save to disk ───
        schedule_id = str(uuid.uuid4())
        schedule_dir = os.path.join(SCHEDULES_DIR, schedule_id)
        os.makedirs(schedule_dir, exist_ok=True)

        # Save original PDF
        pdf_path = os.path.join(schedule_dir, f"{schedule_id}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(file_bytes)

        # Save parsed JSON + metadata
        uploaded_at = datetime.utcnow().isoformat()
        schedule_data = {
            "id": schedule_id,
            "filename": file.filename or "schedule.pdf",
            "uploaded_at": uploaded_at,
            "total_shifts": total_shifts,
            "schedule_type": schedule_type,
            "page_count": page_count,
            "file_size": len(file_bytes),
            "shifts": shifts,
        }

        json_path = os.path.join(schedule_dir, f"{schedule_id}.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(schedule_data, f, indent=2)

        logger.info(f"[schedule/upload] Saved schedule {schedule_id} to {schedule_dir}")

        return ScheduleUploadResponse(
            id=schedule_id,
            filename=file.filename or "schedule.pdf",
            uploaded_at=uploaded_at,
            total_shifts=total_shifts,
            schedule_type=schedule_type,
            shifts=shifts,
        )

    except HTTPException:
        raise
    except ImportError as exc:
        logger.exception(f"[schedule/upload] Missing dependency: {exc}")
        raise HTTPException(
            status_code=500,
            detail="PyMuPDF (fitz) not installed. Run: pip install PyMuPDF",
        )
    except Exception as exc:
        logger.exception(f"[schedule/upload] Error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# HELPER: Infer schedule type for legacy data
# WHY: Schedules stored before the schedule_type field was added
# don't have it. We retroactively detect: if ALL rows across
# ALL shifts have width=0 and length=0, it's grind_overlay.
# ============================================

def _infer_schedule_type(schedule_data: dict[str, Any]) -> str:
    """Infer schedule type from row data if not explicitly set."""
    explicit = schedule_data.get("schedule_type")
    if explicit and explicit in ("digout", "grind_overlay"):
        return explicit

    # Check all rows — if every row has width=0 and length=0, it's G&O
    shifts = schedule_data.get("shifts", {})
    if not shifts:
        return "digout"

    all_zero = True
    for shift_data in shifts.values():
        for row in shift_data.get("rows", []):
            if row.get("width", 0) != 0 or row.get("length", 0) != 0:
                all_zero = False
                break
        if not all_zero:
            break

    inferred = "grind_overlay" if all_zero else "digout"
    if not explicit:
        logger.info(f"[schedule] Inferred schedule_type='{inferred}' for legacy schedule {schedule_data.get('id', '?')}")
    return inferred


# ============================================
# ENDPOINT: Get Active (Most Recent) Schedule
# ============================================

@router.get("/active")
async def get_active_schedule():
    """
    Return the most recently uploaded schedule's parsed data.
    Scans data/schedules/ for JSON files, sorts by uploaded_at descending.
    """
    try:
        if not os.path.exists(SCHEDULES_DIR):
            raise HTTPException(status_code=404, detail="No schedules found.")

        schedules: list[dict[str, Any]] = []

        for item in os.listdir(SCHEDULES_DIR):
            item_path = os.path.join(SCHEDULES_DIR, item)
            if not os.path.isdir(item_path):
                continue

            # Look for the JSON metadata file inside the subdirectory
            json_path = os.path.join(item_path, f"{item}.json")
            if not os.path.exists(json_path):
                logger.warning(f"[schedule/active] Missing JSON for {item}, skipping")
                continue

            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    schedule_data = json.load(f)
                schedules.append(schedule_data)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"[schedule/active] Failed to read {json_path}: {e}")
                continue

        if not schedules:
            raise HTTPException(status_code=404, detail="No schedules found.")

        # Sort by uploaded_at descending (newest first)
        schedules.sort(key=lambda s: s.get("uploaded_at", ""), reverse=True)
        active = schedules[0]

        logger.info(
            f"[schedule/active] Returning schedule {active['id']} "
            f"(uploaded {active.get('uploaded_at', 'unknown')})"
        )

        # Retroactively infer schedule_type for legacy data
        active['schedule_type'] = _infer_schedule_type(active)

        return active

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"[schedule/active] Error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: List All Schedules
# ============================================

@router.get("/list")
async def list_schedules():
    """Return list of all uploaded schedules with summary metadata."""
    try:
        if not os.path.exists(SCHEDULES_DIR):
            return {"schedules": [], "count": 0}

        schedules: list[dict[str, Any]] = []

        for item in os.listdir(SCHEDULES_DIR):
            item_path = os.path.join(SCHEDULES_DIR, item)
            if not os.path.isdir(item_path):
                continue

            json_path = os.path.join(item_path, f"{item}.json")
            if not os.path.exists(json_path):
                logger.warning(f"[schedule/list] Missing JSON for {item}, skipping")
                continue

            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                schedules.append({
                    "id": data.get("id", item),
                    "filename": data.get("filename", "Unknown"),
                    "uploaded_at": data.get("uploaded_at", ""),
                    "total_shifts": data.get("total_shifts", 0),
                    "schedule_type": _infer_schedule_type(data),
                })
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"[schedule/list] Failed to read {json_path}: {e}")
                continue

        # Sort by uploaded_at descending (newest first)
        schedules.sort(key=lambda s: s.get("uploaded_at", ""), reverse=True)

        logger.info(f"[schedule/list] Returning {len(schedules)} schedules")
        return {"schedules": schedules, "count": len(schedules)}

    except Exception as exc:
        logger.exception(f"[schedule/list] Error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ============================================
# ENDPOINT: Get Schedule by ID
# ============================================

@router.get("/{schedule_id}")
async def get_schedule_by_id(schedule_id: str):
    """Return a specific schedule's full parsed data by ID."""
    schedule_dir = os.path.join(SCHEDULES_DIR, schedule_id)
    if not os.path.isdir(schedule_dir):
        raise HTTPException(status_code=404, detail=f"Schedule '{schedule_id}' not found.")

    json_path = os.path.join(schedule_dir, f"{schedule_id}.json")
    if not os.path.exists(json_path):
        raise HTTPException(status_code=404, detail=f"Schedule data missing for '{schedule_id}'.")

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Retroactively infer schedule_type for legacy data
        data['schedule_type'] = _infer_schedule_type(data)

        logger.info(f"[schedule/{schedule_id}] Returning schedule (type={data['schedule_type']})")
        return data
    except (json.JSONDecodeError, OSError) as e:
        logger.exception(f"[schedule/{schedule_id}] Failed to read: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to read schedule: {e}")


# ============================================
# ENDPOINT: Delete Schedule
# ============================================

@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: str):
    """Delete both the .json and .pdf files for a schedule."""
    import shutil

    schedule_dir = os.path.join(SCHEDULES_DIR, schedule_id)
    if not os.path.isdir(schedule_dir):
        raise HTTPException(status_code=404, detail=f"Schedule '{schedule_id}' not found.")

    # Read filename for the log message before deleting
    json_path = os.path.join(schedule_dir, f"{schedule_id}.json")
    filename = schedule_id
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            filename = data.get("filename", schedule_id)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"[schedule/delete] Could not read metadata for {schedule_id}: {e}")

    try:
        shutil.rmtree(schedule_dir)
        logger.info(f"[schedule/delete] Deleted schedule: {filename} ({schedule_id})")
        return {"status": "success", "message": f"Schedule '{filename}' deleted."}
    except Exception as exc:
        logger.exception(f"[schedule/delete] Error deleting {schedule_id}: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
