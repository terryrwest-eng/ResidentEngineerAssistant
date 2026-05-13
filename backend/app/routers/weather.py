"""
Daily Reporter V3 — Weather Router (stub)
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/weather")
async def get_weather(lat: float = 0, lon: float = 0):
    """Get weather — stub."""
    return {"message": "Weather not yet implemented"}
