"""
Daily Reporter V3 — Dispatches Router (Dispatch Library)

Endpoints:
  POST   /api/dispatches/upload        → Upload a single dispatch PDF for a date
  POST   /api/dispatches/batch-upload   → Upload multiple dispatch PDFs (auto-detect dates from filenames)
  GET    /api/dispatches                → List all available dispatch dates
  GET    /api/dispatches/{date}         → Get parsed dispatch for a specific date
  DELETE /api/dispatches/{date}         → Remove dispatch for a date

Storage layout:
  data/dispatches/{YYYY-MM-DD}/
    ├── dispatch.pdf   — original uploaded file
    └── parsed.json    — cached AI parse result + metadata
"""

import glob
import json
import logging
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.services.dispatch_parser import parse_dispatch_pdf

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dispatches", tags=["dispatches"])

# ── Storage path ──────────────────────────────────────────────────────────────
from app.core.paths import DISPATCHES_DIR, SETTINGS_FILE  # noqa: E402

os.makedirs(DISPATCHES_DIR, exist_ok=True)

# ── Constants ─────────────────────────────────────────────────────────────────
DISPATCH_PDF_FILENAME = "dispatch.pdf"
PARSED_JSON_FILENAME = "parsed.json"
# Matches filenames like: 6.18.26 THURSDAY DISPATCH.pdf
FILENAME_DATE_PATTERN = re.compile(r'(\d{1,2})\.(\d{1,2})\.(\d{2})')
DATE_FORMAT = "%Y-%m-%d"
TWO_DIGIT_YEAR_BASE = 2000
# Settings file path — read dispatch_folder_path from here
_SETTINGS_PATH = SETTINGS_FILE


def _get_dispatch_folder_path() -> str | None:
    """Read dispatch_folder_path from settings. Returns None if not set."""
    if not os.path.exists(_SETTINGS_PATH):
        logger.debug('[dispatches] No settings.json found')
        return None
    try:
        with open(_SETTINGS_PATH, 'r', encoding='utf-8') as f:
            settings = json.load(f)
        folder_path = settings.get('dispatch_folder_path', '')
        if folder_path and os.path.isdir(folder_path):
            logger.debug(f'[dispatches] dispatch_folder_path from settings: {folder_path}')
            return folder_path
        if folder_path:
            logger.warning(f'[dispatches] dispatch_folder_path not a valid directory: {folder_path}')
        return None
    except Exception as exc:
        logger.warning(f'[dispatches] Failed to read settings: {exc}')
        return None


def _find_dispatch_in_folder(date_str: str) -> str | None:
    """
    Search the configured dispatch folder for a PDF matching the given date.

    Looks for filenames matching the pattern: M.DD.YY DAYNAME DISPATCH.pdf
    Example: date_str='2026-06-18' → looks for '6.18.26 *.pdf'

    Returns the full file path, or None if not found.
    """
    folder = _get_dispatch_folder_path()
    if not folder:
        logger.debug(f'[dispatches] No dispatch folder configured — cannot auto-find for {date_str}')
        return None

    # Parse the target date
    try:
        target = datetime.strptime(date_str, DATE_FORMAT)
    except ValueError:
        logger.warning(f'[dispatches] Invalid date for auto-find: {date_str}')
        return None

    # Build the expected filename prefix: M.DD.YY (no leading zeros on month)
    month = target.month
    day = target.day
    year_2digit = target.year - TWO_DIGIT_YEAR_BASE
    # Try patterns with and without leading zeros
    patterns = [
        f'{month}.{day:02d}.{year_2digit:02d}',   # 6.18.26
        f'{month:02d}.{day:02d}.{year_2digit:02d}', # 06.18.26
        f'{month}.{day}.{year_2digit:02d}',         # 6.18.26 (no zero-pad day)
    ]

    logger.debug(f'[dispatches] Searching folder {folder} for date {date_str}, patterns: {patterns}')

    for fname in os.listdir(folder):
        if not fname.lower().endswith('.pdf'):
            continue
        for pattern in patterns:
            if fname.startswith(pattern):
                full_path = os.path.join(folder, fname)
                logger.info(f'[dispatches] Auto-found dispatch: {full_path}')
                return full_path

    logger.info(f'[dispatches] No dispatch file found in {folder} for date {date_str}')
    return None


# ── Pydantic models ───────────────────────────────────────────────────────────

class DispatchUploadResponse(BaseModel):
    """Response for a single dispatch upload."""
    date: str
    filename: str
    company: str
    job_count: int
    uploaded_at: str
    jobs: list[dict[str, Any]]


class DispatchListItem(BaseModel):
    """Summary item for dispatch listing."""
    date: str
    filename: str
    job_count: int
    company: str
    uploaded_at: str


class DispatchListResponse(BaseModel):
    """Response for listing all dispatches."""
    dispatches: list[DispatchListItem]
    count: int


class BatchUploadResult(BaseModel):
    """Result for a single file in a batch upload."""
    date: str
    filename: str
    status: str  # 'success' or 'error'
    job_count: int
    error: str | None = None


class BatchUploadResponse(BaseModel):
    """Response for batch upload of multiple dispatch PDFs."""
    results: list[BatchUploadResult]
    success_count: int
    error_count: int


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_date_dir(date_str: str) -> str:
    """Get the directory path for a dispatch date. Creates if needed."""
    date_dir = os.path.join(DISPATCHES_DIR, date_str)
    os.makedirs(date_dir, exist_ok=True)
    return date_dir


def _save_parsed(date_str: str, filename: str, parsed_data: dict[str, Any]) -> str:
    """
    Save parsed dispatch data to disk with metadata.
    Uses atomic write (temp file + rename) to prevent corruption.
    Returns the uploaded_at timestamp.
    """
    date_dir = _get_date_dir(date_str)
    uploaded_at = datetime.now(timezone.utc).isoformat()

    payload = {
        "date": parsed_data.get("date", date_str),
        "company": parsed_data.get("company", ""),
        "jobs": parsed_data.get("jobs", []),
        "filename": filename,
        "uploaded_at": uploaded_at,
    }

    parsed_path = os.path.join(date_dir, PARSED_JSON_FILENAME)
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=date_dir, delete=False, suffix=".tmp"
        ) as tmp:
            json.dump(payload, tmp, indent=2, default=str)
            tmp_path = tmp.name
        shutil.move(tmp_path, parsed_path)
        logger.info(f'[dispatches] Saved parsed.json for {date_str} ({len(payload["jobs"])} jobs)')
    except Exception as exc:
        logger.error(f'[dispatches] Failed to save parsed.json for {date_str}: {exc}')
        raise

    return uploaded_at


def _load_parsed(date_str: str) -> dict[str, Any] | None:
    """Load parsed dispatch data from disk. Returns None if not found."""
    parsed_path = os.path.join(DISPATCHES_DIR, date_str, PARSED_JSON_FILENAME)
    if not os.path.exists(parsed_path):
        logger.debug(f'[dispatches] No parsed.json found for {date_str}')
        return None
    try:
        with open(parsed_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        logger.debug(f'[dispatches] Loaded parsed.json for {date_str}')
        return data
    except Exception as exc:
        logger.error(f'[dispatches] Failed to read parsed.json for {date_str}: {exc}')
        return None


def _extract_date_from_filename(filename: str) -> str | None:
    """
    Extract a YYYY-MM-DD date from a dispatch filename.

    Expected pattern: M.DD.YY DAYNAME DISPATCH.pdf
    Example: 6.18.26 THURSDAY DISPATCH.pdf → 2026-06-18
    """
    match = FILENAME_DATE_PATTERN.search(filename)
    if not match:
        logger.warning(f'[dispatches] Could not extract date from filename: {filename}')
        return None

    month = int(match.group(1))
    day = int(match.group(2))
    year_2digit = int(match.group(3))
    year = TWO_DIGIT_YEAR_BASE + year_2digit

    try:
        date_obj = datetime(year=year, month=month, day=day)
        date_str = date_obj.strftime(DATE_FORMAT)
        logger.debug(f'[dispatches] Extracted date {date_str} from filename: {filename}')
        return date_str
    except ValueError as exc:
        logger.warning(f'[dispatches] Invalid date in filename {filename}: {exc}')
        return None


def _validate_date_format(date_str: str) -> None:
    """Validate that a date string is in YYYY-MM-DD format."""
    try:
        datetime.strptime(date_str, DATE_FORMAT)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f'Invalid date format: "{date_str}". Expected YYYY-MM-DD.',
        )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/upload", response_model=DispatchUploadResponse)
async def upload_dispatch(
    file: UploadFile = File(...),
    date: str = Form(...),
):
    """
    Upload a single dispatch PDF for a specific date.

    Saves the PDF, parses it via AI, and caches the result.
    If a dispatch already exists for that date, it is replaced.
    """
    _validate_date_format(date)
    filename = file.filename or "dispatch.pdf"
    logger.info(f'[dispatches] Upload started: date={date}, filename={filename}')

    # Read file bytes
    try:
        file_bytes = await file.read()
        logger.debug(f'[dispatches] Read {len(file_bytes):,} bytes from upload')
    except Exception as exc:
        logger.error(f'[dispatches] Failed to read uploaded file: {exc}')
        raise HTTPException(status_code=400, detail=f"Failed to read file: {exc}")

    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file uploaded.")

    # Validate PDF
    content_type = file.content_type or 'application/octet-stream'
    if content_type != 'application/pdf' and not filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    # Save the original PDF
    date_dir = _get_date_dir(date)
    pdf_path = os.path.join(date_dir, DISPATCH_PDF_FILENAME)
    try:
        with open(pdf_path, "wb") as f:
            f.write(file_bytes)
        logger.info(f'[dispatches] Saved PDF: {pdf_path} ({len(file_bytes):,} bytes)')
    except Exception as exc:
        logger.error(f'[dispatches] Failed to save PDF for {date}: {exc}')
        raise HTTPException(status_code=500, detail=f"Failed to save PDF: {exc}")

    # Parse via AI
    try:
        result = await parse_dispatch_pdf(file_bytes, filename)
        logger.info(
            f'[dispatches] Parse complete for {date}: '
            f'{len(result.jobs)} jobs, company={result.company}'
        )
    except Exception as exc:
        logger.error(f'[dispatches] AI parse failed for {date}: {exc}')
        raise HTTPException(status_code=500, detail=f"AI parse failed: {exc}")

    # Cache parsed result
    parsed_data = result.model_dump()
    uploaded_at = _save_parsed(date, filename, parsed_data)

    return DispatchUploadResponse(
        date=date,
        filename=filename,
        company=result.company,
        job_count=len(result.jobs),
        uploaded_at=uploaded_at,
        jobs=result.jobs,
    )


@router.post("/batch-upload", response_model=BatchUploadResponse)
async def batch_upload_dispatches(
    files: list[UploadFile] = File(...),
):
    """
    Upload multiple dispatch PDFs. Dates are auto-detected from filenames.

    Expected filename pattern: M.DD.YY DAYNAME DISPATCH.pdf
    Example: 6.18.26 THURSDAY DISPATCH.pdf → 2026-06-18
    """
    logger.info(f'[dispatches] Batch upload started: {len(files)} files')

    results: list[BatchUploadResult] = []
    success_count = 0
    error_count = 0

    for file in files:
        filename = file.filename or "unknown.pdf"
        logger.info(f'[dispatches] Processing batch file: {filename}')

        # Auto-detect date from filename
        date_str = _extract_date_from_filename(filename)
        if not date_str:
            error_msg = (
                f'Could not extract date from filename "{filename}". '
                f'Expected pattern: M.DD.YY DAYNAME DISPATCH.pdf'
            )
            logger.warning(f'[dispatches] {error_msg}')
            results.append(BatchUploadResult(
                date='',
                filename=filename,
                status='error',
                job_count=0,
                error=error_msg,
            ))
            error_count += 1
            continue

        # Read file bytes
        try:
            file_bytes = await file.read()
            logger.debug(f'[dispatches] Read {len(file_bytes):,} bytes from {filename}')
        except Exception as exc:
            error_msg = f'Failed to read file: {exc}'
            logger.error(f'[dispatches] {error_msg}')
            results.append(BatchUploadResult(
                date=date_str,
                filename=filename,
                status='error',
                job_count=0,
                error=error_msg,
            ))
            error_count += 1
            continue

        if not file_bytes:
            results.append(BatchUploadResult(
                date=date_str,
                filename=filename,
                status='error',
                job_count=0,
                error='Empty file',
            ))
            error_count += 1
            continue

        # Save original PDF
        date_dir = _get_date_dir(date_str)
        pdf_path = os.path.join(date_dir, DISPATCH_PDF_FILENAME)
        try:
            with open(pdf_path, "wb") as f:
                f.write(file_bytes)
            logger.info(f'[dispatches] Saved PDF: {pdf_path}')
        except Exception as exc:
            error_msg = f'Failed to save PDF: {exc}'
            logger.error(f'[dispatches] {error_msg}')
            results.append(BatchUploadResult(
                date=date_str,
                filename=filename,
                status='error',
                job_count=0,
                error=error_msg,
            ))
            error_count += 1
            continue

        # Parse via AI
        try:
            result = await parse_dispatch_pdf(file_bytes, filename)
            parsed_data = result.model_dump()
            _save_parsed(date_str, filename, parsed_data)

            logger.info(
                f'[dispatches] Batch parse complete for {date_str}: '
                f'{len(result.jobs)} jobs'
            )
            results.append(BatchUploadResult(
                date=date_str,
                filename=filename,
                status='success',
                job_count=len(result.jobs),
                error=None,
            ))
            success_count += 1

        except Exception as exc:
            error_msg = f'AI parse failed: {exc}'
            logger.error(f'[dispatches] {error_msg}')
            results.append(BatchUploadResult(
                date=date_str,
                filename=filename,
                status='error',
                job_count=0,
                error=error_msg,
            ))
            error_count += 1

    logger.info(
        f'[dispatches] Batch upload complete: '
        f'{success_count} success, {error_count} errors out of {len(files)} files'
    )

    return BatchUploadResponse(
        results=results,
        success_count=success_count,
        error_count=error_count,
    )


@router.get("/{date}", response_model=DispatchUploadResponse)
async def get_dispatch(date: str):
    """
    Get parsed dispatch data for a specific date.

    Resolution order:
    1. Check cache (data/dispatches/{date}/parsed.json)
    2. Auto-find in configured dispatch_folder_path (settings)
    3. Return 404
    """
    _validate_date_format(date)
    logger.debug(f'[dispatches] GET dispatch for {date}')

    # ── Step 1: Check cache ──
    data = _load_parsed(date)
    if data is not None:
        logger.debug(f'[dispatches] Cache hit for {date}')
        return DispatchUploadResponse(
            date=data.get("date", date),
            filename=data.get("filename", ""),
            company=data.get("company", ""),
            job_count=len(data.get("jobs", [])),
            uploaded_at=data.get("uploaded_at", ""),
            jobs=data.get("jobs", []),
        )

    # ── Step 2: Auto-find from configured folder ──
    pdf_path = _find_dispatch_in_folder(date)
    if pdf_path is not None:
        logger.info(f'[dispatches] Auto-loading dispatch from: {pdf_path}')
        try:
            with open(pdf_path, 'rb') as f:
                file_bytes = f.read()
            filename = os.path.basename(pdf_path)
            logger.debug(f'[dispatches] Read {len(file_bytes):,} bytes from {filename}')

            # Save a copy to our cache directory
            date_dir = _get_date_dir(date)
            cache_pdf_path = os.path.join(date_dir, DISPATCH_PDF_FILENAME)
            with open(cache_pdf_path, 'wb') as f:
                f.write(file_bytes)
            logger.debug(f'[dispatches] Cached PDF copy at {cache_pdf_path}')

            # Parse via AI
            result = await parse_dispatch_pdf(file_bytes, filename)
            logger.info(
                f'[dispatches] Auto-parse complete for {date}: '
                f'{len(result.jobs)} jobs, company={result.company}'
            )

            # Cache parsed result
            parsed_data = result.model_dump()
            uploaded_at = _save_parsed(date, filename, parsed_data)

            return DispatchUploadResponse(
                date=date,
                filename=filename,
                company=result.company,
                job_count=len(result.jobs),
                uploaded_at=uploaded_at,
                jobs=result.jobs,
            )
        except Exception as exc:
            logger.error(f'[dispatches] Auto-load failed for {date}: {exc}')
            raise HTTPException(
                status_code=500,
                detail=f'Found dispatch file but AI parse failed: {exc}',
            )

    # ── Step 3: Not found ──
    raise HTTPException(status_code=404, detail=f"No dispatch found for {date}")


@router.get("", response_model=DispatchListResponse)
async def list_dispatches():
    """List all available dispatch dates, sorted by date descending."""
    logger.debug('[dispatches] Listing all dispatches')

    dispatches: list[DispatchListItem] = []

    if not os.path.exists(DISPATCHES_DIR):
        logger.debug('[dispatches] Dispatches directory does not exist')
        return DispatchListResponse(dispatches=[], count=0)

    for item in sorted(os.listdir(DISPATCHES_DIR), reverse=True):
        item_path = os.path.join(DISPATCHES_DIR, item)
        if not os.path.isdir(item_path):
            continue

        # Validate directory name is a date
        try:
            datetime.strptime(item, DATE_FORMAT)
        except ValueError:
            logger.debug(f'[dispatches] Skipping non-date directory: {item}')
            continue

        # Load parsed data for metadata
        data = _load_parsed(item)
        if data is None:
            logger.debug(f'[dispatches] No parsed.json in {item}, skipping')
            continue

        dispatches.append(DispatchListItem(
            date=item,
            filename=data.get("filename", ""),
            job_count=len(data.get("jobs", [])),
            company=data.get("company", ""),
            uploaded_at=data.get("uploaded_at", ""),
        ))

    logger.info(f'[dispatches] Found {len(dispatches)} dispatches')

    return DispatchListResponse(
        dispatches=dispatches,
        count=len(dispatches),
    )


@router.delete("/{date}")
async def delete_dispatch(date: str):
    """Delete the dispatch for a specific date (removes entire date directory)."""
    _validate_date_format(date)
    logger.info(f'[dispatches] DELETE dispatch for {date}')

    date_dir = os.path.join(DISPATCHES_DIR, date)
    if not os.path.exists(date_dir):
        raise HTTPException(status_code=404, detail=f"No dispatch found for {date}")

    try:
        shutil.rmtree(date_dir)
        logger.info(f'[dispatches] Deleted directory: {date_dir}')
    except Exception as exc:
        logger.error(f'[dispatches] Failed to delete {date_dir}: {exc}')
        raise HTTPException(status_code=500, detail=f"Failed to delete dispatch: {exc}")

    return {"status": "success", "date": date}
