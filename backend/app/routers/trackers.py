"""
Daily Reporter V3 — Trackers Router

CRUD endpoints for the 4 field tracking modules:
  - Excavation Log          GET/POST/PUT/DELETE /api/trackers/excavation
  - Pay Item Tracker        GET/POST/PUT/DELETE /api/trackers/pay-items
  - Punch List              GET/POST/PUT/DELETE /api/trackers/punch-list
  - Redline Tracker         GET/POST/PUT/DELETE /api/trackers/redlines

All data stored in individual JSON files under data/trackers/{type}.json
Atomic writes (tempfile → rename) prevent corruption.
No MongoDB — all state is files on disk.

WHY file-per-tracker not file-per-row:
  Each tracker is a single list document that fits in memory.
  Field conditions don't create thousands of rows — these are project-level lists.
  A single JSON file per tracker is trivially diff-able and human-readable.
"""

import json
import logging
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/trackers", tags=["trackers"])

TRACKER_DIR = Path("data/trackers")
TRACKER_DIR.mkdir(parents=True, exist_ok=True)

# ─────────────────────────────────────────
# FILE HELPERS
# ─────────────────────────────────────────

def _tracker_path(name: str) -> Path:
    """Returns the JSON file path for a tracker."""
    return TRACKER_DIR / f"{name}.json"


def _load(name: str) -> list[dict[str, Any]]:
    """Load a tracker list from disk. Returns [] if file doesn't exist."""
    path = _tracker_path(name)
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.error(f"[trackers] Failed to read {name}.json: {exc}")
        return []


def _save(name: str, rows: list[dict[str, Any]]) -> None:
    """
    Atomically write a tracker list to disk.
    Uses tempfile + rename so a crash mid-write never corrupts the file.
    """
    path = _tracker_path(name)
    try:
        fd, tmp = tempfile.mkstemp(dir=TRACKER_DIR, suffix=".json")
        with open(fd, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2, default=str)
        shutil.move(tmp, path)
        logger.debug(f"[trackers] Saved {name}.json ({len(rows)} rows)")
    except Exception as exc:
        logger.exception(f"[trackers] Failed to save {name}.json: {exc}")
        raise HTTPException(status_code=500, detail="Failed to save tracker data")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _find_idx(rows: list[dict[str, Any]], entry_id: str) -> int:
    """Return the index of the row with the given id, or raise 404."""
    for i, row in enumerate(rows):
        if row.get("id") == entry_id:
            return i
    raise HTTPException(status_code=404, detail=f"Entry {entry_id} not found")


# ─────────────────────────────────────────
# MODELS
# ─────────────────────────────────────────

class ExcavationEntry(BaseModel):
    date: str = ""
    location: str = ""
    station_from: str = ""
    station_to: str = ""
    length_lf: float = 0.0
    width_ft: float = 0.0
    depth_ft: float = 0.0
    soil_type: str = ""
    notes: str = ""


class PayItemEntry(BaseModel):
    bid_item: str = ""
    description: str = ""
    unit: str = ""
    contract_qty: float = 0.0
    unit_price: float = 0.0
    running_total: float = 0.0
    notes: str = ""


class PunchListItem(BaseModel):
    date_opened: str = ""
    location: str = ""
    description: str = ""
    assigned_to: str = ""
    priority: str = "Medium"   # Low | Medium | High | Critical
    status: str = "Open"       # Open | In Progress | Closed
    date_closed: str = ""
    notes: str = ""


class RedlineEntry(BaseModel):
    date: str = ""
    sheet_number: str = ""
    description: str = ""
    location: str = ""
    station: str = ""
    change_type: str = ""      # Alignment | Elevation | Material | Other
    submitted_by: str = ""
    status: str = "Pending"    # Pending | Approved | Rejected
    notes: str = ""


# ─────────────────────────────────────────
# EXCAVATION LOG
# ─────────────────────────────────────────

@router.get("/excavation")
async def list_excavation():
    """All excavation entries, newest first."""
    rows = _load("excavation")
    return rows


@router.post("/excavation", status_code=201)
async def create_excavation(entry: ExcavationEntry):
    """
    Create a new excavation entry.
    Auto-calculates volume_cy = L × W × D / 27.
    """
    rows = _load("excavation")
    data = entry.model_dump()
    data["id"] = str(uuid.uuid4())
    data["created_at"] = _now_iso()
    data["updated_at"] = _now_iso()

    # Computed field
    if data["length_lf"] > 0 and data["width_ft"] > 0 and data["depth_ft"] > 0:
        data["volume_cy"] = round(
            (data["length_lf"] * data["width_ft"] * data["depth_ft"]) / 27, 2
        )
    else:
        data["volume_cy"] = 0.0

    rows.insert(0, data)
    _save("excavation", rows)
    logger.info(f"[trackers] Created excavation entry {data['id']} ({data['volume_cy']} CY)")
    return data


@router.put("/excavation/{entry_id}")
async def update_excavation(entry_id: str, entry: ExcavationEntry):
    """Update an existing excavation entry. Recalculates volume_cy."""
    rows = _load("excavation")
    idx = _find_idx(rows, entry_id)
    data = entry.model_dump()
    data["id"] = entry_id
    data["created_at"] = rows[idx].get("created_at", _now_iso())
    data["updated_at"] = _now_iso()

    if data["length_lf"] > 0 and data["width_ft"] > 0 and data["depth_ft"] > 0:
        data["volume_cy"] = round(
            (data["length_lf"] * data["width_ft"] * data["depth_ft"]) / 27, 2
        )
    else:
        data["volume_cy"] = 0.0

    rows[idx] = data
    _save("excavation", rows)
    return data


@router.delete("/excavation/{entry_id}")
async def delete_excavation(entry_id: str):
    rows = _load("excavation")
    idx = _find_idx(rows, entry_id)
    rows.pop(idx)
    _save("excavation", rows)
    return {"status": "deleted", "id": entry_id}


# ─────────────────────────────────────────
# PAY ITEM TRACKER
# ─────────────────────────────────────────

@router.get("/pay-items")
async def list_pay_items():
    """All pay items ordered by bid item number."""
    return _load("pay_items")


@router.post("/pay-items", status_code=201)
async def create_pay_item(entry: PayItemEntry):
    """
    Create a new pay item.
    Auto-calculates: percent_complete and contract_value.
    """
    rows = _load("pay_items")
    data = entry.model_dump()
    data["id"] = str(uuid.uuid4())
    data["created_at"] = _now_iso()
    data["updated_at"] = _now_iso()
    data["percent_complete"] = _calc_percent(data)
    data["contract_value"] = round(data["contract_qty"] * data["unit_price"], 2)
    data["earned_value"] = round(data["running_total"] * data["unit_price"], 2)

    rows.append(data)
    _save("pay_items", rows)
    logger.info(f"[trackers] Created pay item {data['id']} — {data['description']}")
    return data


@router.put("/pay-items/{entry_id}")
async def update_pay_item(entry_id: str, entry: PayItemEntry):
    rows = _load("pay_items")
    idx = _find_idx(rows, entry_id)
    data = entry.model_dump()
    data["id"] = entry_id
    data["created_at"] = rows[idx].get("created_at", _now_iso())
    data["updated_at"] = _now_iso()
    data["percent_complete"] = _calc_percent(data)
    data["contract_value"] = round(data["contract_qty"] * data["unit_price"], 2)
    data["earned_value"] = round(data["running_total"] * data["unit_price"], 2)

    rows[idx] = data
    _save("pay_items", rows)
    return data


@router.delete("/pay-items/{entry_id}")
async def delete_pay_item(entry_id: str):
    rows = _load("pay_items")
    idx = _find_idx(rows, entry_id)
    rows.pop(idx)
    _save("pay_items", rows)
    return {"status": "deleted", "id": entry_id}


def _calc_percent(data: dict[str, Any]) -> float:
    """Safe percent complete = (running / contract) × 100."""
    if data.get("contract_qty", 0) > 0:
        return round((data["running_total"] / data["contract_qty"]) * 100, 1)
    return 0.0


# ─────────────────────────────────────────
# PUNCH LIST
# ─────────────────────────────────────────

@router.get("/punch-list")
async def list_punch_list():
    """All punch list items, newest first."""
    return _load("punch_list")


@router.post("/punch-list", status_code=201)
async def create_punch_item(entry: PunchListItem):
    """Create a punch list item. Auto-assigns sequential item_number."""
    rows = _load("punch_list")

    # Sequential item number — max existing + 1
    existing_nums = [r.get("item_number", 0) for r in rows if isinstance(r.get("item_number"), int)]
    item_number = (max(existing_nums) + 1) if existing_nums else 1

    data = entry.model_dump()
    data["id"] = str(uuid.uuid4())
    data["item_number"] = item_number
    data["created_at"] = _now_iso()
    data["updated_at"] = _now_iso()

    rows.insert(0, data)
    _save("punch_list", rows)
    logger.info(f"[trackers] Created punch item #{item_number}: {data['description'][:60]}")
    return data


@router.put("/punch-list/{entry_id}")
async def update_punch_item(entry_id: str, entry: PunchListItem):
    rows = _load("punch_list")
    idx = _find_idx(rows, entry_id)
    data = entry.model_dump()
    data["id"] = entry_id
    data["item_number"] = rows[idx].get("item_number", 0)
    data["created_at"] = rows[idx].get("created_at", _now_iso())
    data["updated_at"] = _now_iso()

    # Auto-set date_closed when status is Closed
    if data["status"] == "Closed" and not data.get("date_closed"):
        data["date_closed"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    rows[idx] = data
    _save("punch_list", rows)
    return data


@router.delete("/punch-list/{entry_id}")
async def delete_punch_item(entry_id: str):
    rows = _load("punch_list")
    idx = _find_idx(rows, entry_id)
    rows.pop(idx)
    _save("punch_list", rows)
    return {"status": "deleted", "id": entry_id}


# ─────────────────────────────────────────
# REDLINE TRACKER
# ─────────────────────────────────────────

@router.get("/redlines")
async def list_redlines():
    """All redline entries, newest first."""
    return _load("redlines")


@router.post("/redlines", status_code=201)
async def create_redline(entry: RedlineEntry):
    rows = _load("redlines")
    data = entry.model_dump()
    data["id"] = str(uuid.uuid4())
    data["created_at"] = _now_iso()
    data["updated_at"] = _now_iso()

    rows.insert(0, data)
    _save("redlines", rows)
    logger.info(f"[trackers] Created redline {data['id']} — sheet {data['sheet_number']}")
    return data


@router.put("/redlines/{entry_id}")
async def update_redline(entry_id: str, entry: RedlineEntry):
    rows = _load("redlines")
    idx = _find_idx(rows, entry_id)
    data = entry.model_dump()
    data["id"] = entry_id
    data["created_at"] = rows[idx].get("created_at", _now_iso())
    data["updated_at"] = _now_iso()
    rows[idx] = data
    _save("redlines", rows)
    return data


@router.delete("/redlines/{entry_id}")
async def delete_redline(entry_id: str):
    rows = _load("redlines")
    idx = _find_idx(rows, entry_id)
    rows.pop(idx)
    _save("redlines", rows)
    return {"status": "deleted", "id": entry_id}
