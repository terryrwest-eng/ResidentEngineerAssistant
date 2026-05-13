"""
Daily Reporter V3 — Report Service

Thin service layer that wraps database operations.
Provides async-compatible interface for routers (export.py uses this).
"""

from app.services.database import (
    get_report as _get_report_sync,
    save_report as _save_report_sync,
    list_reports as _list_reports_sync,
    delete_report as _delete_report_sync,
    get_report_count as _get_report_count_sync,
)
from typing import Optional


async def get_report(report_id: str) -> Optional[dict]:
    """Get a full report by ID. Async wrapper around sync database call."""
    return _get_report_sync(report_id)


async def save_report(report_data: dict) -> str:
    """Save a report (create or update). Returns file path."""
    return _save_report_sync(report_data)


async def list_reports(**kwargs) -> list[dict]:
    """List reports with optional filters."""
    return _list_reports_sync(**kwargs)


async def delete_report(report_id: str) -> bool:
    """Delete a report by ID."""
    return _delete_report_sync(report_id)


async def get_report_count() -> int:
    """Get total report count."""
    return _get_report_count_sync()
