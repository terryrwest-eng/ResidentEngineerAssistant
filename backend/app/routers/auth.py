"""
Daily Reporter V3 — Authentication Router (stub)
Phase 1 placeholder — full auth in next build step.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/auth/login")
async def login():
    """Login endpoint — stub for Phase 1."""
    return {"token": "dev-token", "user": {"id": "dev", "name": "Developer", "email": "dev@test.com", "role": "admin"}}


@router.post("/auth/register")
async def register():
    """Register endpoint — stub for Phase 1."""
    return {"message": "Registration not yet implemented"}


@router.get("/auth/me")
async def get_current_user():
    """Get current user — stub for Phase 1."""
    return {"id": "dev", "name": "Developer", "email": "dev@test.com", "role": "admin"}
