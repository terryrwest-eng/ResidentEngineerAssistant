"""
Daily Reporter V3 — AI Scanning Router (stub)
Phase 4 — full implementation later.
"""

from fastapi import APIRouter

router = APIRouter()


@router.post("/ai/scan-notes")
async def scan_notes():
    """Timesheet scanning — stub for Phase 4."""
    return {"message": "Scanning not yet implemented"}


@router.post("/ai/transcribe")
async def transcribe():
    """Voice dictation — stub for Phase 4."""
    return {"message": "Dictation not yet implemented"}
