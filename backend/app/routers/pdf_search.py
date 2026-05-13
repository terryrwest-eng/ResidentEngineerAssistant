"""
Daily Reporter V3 — PDF Search Router (stub)
Phase 7 — unified smart PDF search.
"""

from fastapi import APIRouter

router = APIRouter()


@router.post("/pdf/upload")
async def upload_pdf():
    """Upload PDF — stub for Phase 7."""
    return {"message": "PDF upload not yet implemented"}


@router.post("/pdf/ask")
async def ask_pdf():
    """Ask PDF question — stub for Phase 7."""
    return {"message": "PDF search not yet implemented"}
