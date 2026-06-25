"""
Daily Reporter V3 — Settings Router

Stores all user settings in a single JSON file: data/settings.json
No database needed. Atomic writes prevent corruption.

Settings stored:
  - default_project, default_resident_engineer  (pre-fill new reports)
  - projects []                                  (project name dropdown)
  - companies []                                 (company dropdown in manpower/equip rows)
  - default_start_time, default_stop_time        (bulk-add defaults)
  - master_lists.manpower []                     (trade dropdown)
  - master_lists.equipment []                    (equipment type dropdown)
  - user_templates []                            (custom activity templates)
  - gemini_api_key                               (stored server-side, never sent to frontend)
"""

import json
import logging
import os
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/settings", tags=["settings"])

# ── Storage path ──────────────────────────────────────────────────────────────
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
DATA_DIR = os.path.join(_BASE_DIR, "data")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

# ── Built-in activity templates (not editable, always available) ───────────────
BUILTIN_TEMPLATES: list[dict[str, str]] = [
    {"id": "excavation",      "name": "Excavation",            "body": "Excavated Sta ___ to ___. Maintained trench width and limits per plans."},
    {"id": "pipe-install",    "name": "Pipe Installation",     "body": "Installed pipe Sta ___ to ___. Checked bedding, alignment, and joint spacing."},
    {"id": "backfill",        "name": "Backfill / Compaction", "body": "Backfilled Sta ___ to ___ in lifts. Compacted per spec."},
    {"id": "concrete",        "name": "Concrete Placement",    "body": "Placed concrete at ___. Verified forms, rebar, and embeds prior to pour."},
    {"id": "shoring",         "name": "Shoring / Trench Safety", "body": "Installed/adjusted shoring at ___ per manufacturer data."},
    {"id": "dewatering",      "name": "Dewatering",            "body": "Dewatered trench at ___. Pumps set, discharge directed to approved location."},
    {"id": "traffic-control", "name": "Traffic Control",       "body": "Traffic control set per approved plan. Flaggers and signs in place."},
    {"id": "hydrotest",       "name": "Hydrostatic Test",      "body": "Hydrostatic test on segment Sta ___ to ___ at ___ psi for ___ hours."},
    {"id": "grading",         "name": "Grading / Subgrade",    "body": "Graded subgrade at ___. Checked elevations and slopes."},
    {"id": "cctv",            "name": "CCTV Inspection",       "body": "CCTV inspection performed Sta ___ to ___. Video recorded and submitted."},
    {"id": "manhole",         "name": "Manhole Installation",  "body": "Manhole installed at Sta ___. Grade rings set. Frame and cover set to grade."},
    {"id": "paving",          "name": "AC Paving",             "body": "AC paving placed at ___. Thickness ___\". Compacted and checked for smoothness."},
]

# ── Default values ─────────────────────────────────────────────────────────────
DEFAULT_SETTINGS: dict[str, Any] = {
    "default_project": "",
    "default_resident_engineer": "",
    "projects": [],
    "default_start_time": "7:00 AM",
    "default_stop_time": "3:30 PM",
    "companies": [
        "OHL NA", "SRK Eng", "AR Concrete", "Brino Builders",
        "NorCal Pipeline", "City of San Diego", "Jacobs", "RJ Noble",
    ],
    "master_lists": {
        "manpower": [
            "Laborer", "Operator", "Foreman", "General Foreman",
            "Carpenter", "Electrician", "Pipefitter", "Teamster",
            "Finisher", "Ironworker", "Mason", "Welder",
            "Journeyman", "Apprentice", "Superintendent", "PM", "PE",
        ],
        "equipment": [
            "Excavator", "Mini Excavator", "Loader", "Backhoe",
            "Dump Truck", "Water Truck", "Pickup Truck", "Crew Truck",
            "Compressor", "Generator", "Crane", "Boom Truck",
            "Roller / Compactor", "Plate Compactor", "Dewatering Pump",
            "Concrete Pump", "Grader", "Bulldozer", "Forklift",
        ],
    },
    "user_templates": [],
    "resource_aliases": {"equipment": {}, "manpower": {}},
    "default_company": "",
    "default_zip_code": "",
    "dispatch_folder_path": "",
    "tc_plan_path": "",
    "updated_at": "",
}


# ── Pydantic models ────────────────────────────────────────────────────────────

class MasterLists(BaseModel):
    manpower: list[str] = []
    equipment: list[str] = []


class UserTemplate(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    body: str


class SettingsPayload(BaseModel):
    default_project: str = ""
    default_resident_engineer: str = ""
    projects: list[str] = []
    default_start_time: str = "7:00 AM"
    default_stop_time: str = "3:30 PM"
    companies: list[str] = []
    master_lists: MasterLists = Field(default_factory=MasterLists)
    user_templates: list[dict[str, Any]] = []


# ── Helpers ────────────────────────────────────────────────────────────────────

def _load() -> dict[str, Any]:
    """Load settings from disk. Returns defaults if file doesn't exist."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(SETTINGS_FILE):
        logger.info("[settings] No settings file found — using defaults")
        return dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Back-fill any keys added since last save
        for k, v in DEFAULT_SETTINGS.items():
            if k not in data:
                data[k] = v
        return data
    except Exception as exc:
        logger.error(f"[settings] Failed to load settings: {exc}")
        return dict(DEFAULT_SETTINGS)


def _save(data: dict[str, Any]) -> None:
    """Atomic write — write to temp then rename to prevent partial writes."""
    os.makedirs(DATA_DIR, exist_ok=True)
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=DATA_DIR, delete=False, suffix=".tmp"
        ) as tmp:
            json.dump(data, tmp, indent=2, default=str)
            tmp_path = tmp.name
        shutil.move(tmp_path, SETTINGS_FILE)
        logger.info("[settings] Saved successfully")
    except Exception as exc:
        logger.error(f"[settings] Save failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Failed to save settings: {exc}")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("")
def get_settings() -> dict[str, Any]:
    """Return all settings. Gemini API key is never returned (server-side only)."""
    data = _load()
    # Strip sensitive key before sending to frontend
    data.pop("gemini_api_key", None)
    return data


@router.put("")
def update_settings(payload: SettingsPayload) -> dict[str, Any]:
    """Full settings update (except Gemini key — use /api/settings/gemini-key)."""
    data = _load()
    data.update(payload.model_dump())
    _save(data)
    data.pop("gemini_api_key", None)
    return {"status": "success", "settings": data}


@router.put("/master-lists")
def update_master_lists(lists: MasterLists) -> dict[str, Any]:
    """Update only the manpower and equipment master lists."""
    data = _load()
    data["master_lists"] = lists.model_dump()
    _save(data)
    return {"status": "success", "master_lists": data["master_lists"]}


class ResourceAliasesPayload(BaseModel):
    equipment: dict[str, str] = {}
    manpower: dict[str, str] = {}


@router.put("/resource-aliases")
def update_resource_aliases(payload: ResourceAliasesPayload) -> dict[str, Any]:
    """
    Merge new resource aliases into existing ones.
    Each alias maps a raw name (AI output) → canonical PMWeb code.
    Incoming aliases are merged — existing keys not in the payload are preserved.
    """
    data = _load()
    existing: dict[str, dict[str, str]] = data.get("resource_aliases", {"equipment": {}, "manpower": {}})

    incoming = payload.model_dump()
    merged_equipment = {**existing.get("equipment", {}), **incoming.get("equipment", {})}
    merged_manpower = {**existing.get("manpower", {}), **incoming.get("manpower", {})}

    data["resource_aliases"] = {
        "equipment": merged_equipment,
        "manpower": merged_manpower,
    }
    _save(data)

    logger.info(
        f"[settings] Resource aliases merged — equipment: {len(merged_equipment)}, "
        f"manpower: {len(merged_manpower)}"
    )
    return {"status": "success", "resource_aliases": data["resource_aliases"]}


@router.post("/templates")
def add_template(template: UserTemplate) -> dict[str, Any]:
    """Add a custom activity template."""
    data = _load()
    templates: list[dict] = data.get("user_templates", [])
    # Prevent duplicate names
    if any(t.get("name", "").lower() == template.name.lower() for t in templates):
        raise HTTPException(status_code=409, detail="A template with that name already exists")
    entry = template.model_dump()
    templates.append(entry)
    data["user_templates"] = templates
    _save(data)
    return {"status": "success", "template": entry}


@router.delete("/templates/{template_id}")
def delete_template(template_id: str) -> dict[str, Any]:
    """Delete a custom activity template by ID."""
    data = _load()
    before = len(data.get("user_templates", []))
    data["user_templates"] = [
        t for t in data.get("user_templates", []) if t.get("id") != template_id
    ]
    if len(data["user_templates"]) == before:
        raise HTTPException(status_code=404, detail="Template not found")
    _save(data)
    return {"status": "success"}


@router.get("/templates/builtin")
def get_builtin_templates() -> dict[str, Any]:
    """Return the hardcoded built-in activity templates."""
    return {"templates": BUILTIN_TEMPLATES}


@router.post("/gemini-key")
def save_gemini_key(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Store the Gemini API key server-side only.
    Key is written to data/settings.json but NEVER returned to the frontend.
    The app reads GEMINI_API_KEY from environment first; this is the fallback.
    """
    key = (payload.get("api_key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="api_key is required")
    data = _load()
    data["gemini_api_key"] = key
    _save(data)
    logger.info("[settings] Gemini API key updated")
    return {"status": "success", "has_key": True}


@router.get("/gemini-key/status")
def get_gemini_key_status() -> dict[str, Any]:
    """Check if a Gemini API key is stored (does not return the key itself)."""
    data = _load()
    env_key = os.environ.get("GEMINI_API_KEY", "")
    stored_key = data.get("gemini_api_key", "")
    has_key = bool(env_key or stored_key)
    source = "environment" if env_key else ("settings" if stored_key else "none")
    return {"has_key": has_key, "source": source}
