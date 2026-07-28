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
from app.core.paths import DATA_DIR, SETTINGS_FILE  # noqa: E402

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
    "custom_resource_codes": {"labor": [], "equipment": []},
    "default_company": "",
    "default_zip_code": "",
    "project_number": "",
    "project_location": "",
    # Saved Word files are named "<prefix> - Daily-TW-MM-DD-YYYY.docx", matching
    # the filing convention already used by the 61 reports in Daily Reports/.
    # Kept separate from default_project because the project is recorded as
    # "Morena Conveyance Northern" while the files are filed under
    # "Morena Conveyance North".
    "word_filename_prefix": "Morena Conveyance North",
    "dispatch_folder_path": "",
    "tc_plan_path": "",
    # Backfill scope rule — see routers/backfill.py.
    # "All timesheets for a date, MINUS the 805 tunnel crew, = one report."
    # The foreman list is configuration rather than a constant because that
    # association ended: Rey Villa ran the tunnel crew through the makeup window
    # (Oct 2025 – Jan 2026) and came off it before Jul 2026. Going forward the
    # job-name keywords are what carry the rule.
    "backfill": {
        "tunnel_foremen": ["Rey Villa"],
        "tunnel_job_keywords": ["805", "tunnel"],
    },
    "updated_at": "",
}


# ── Pydantic models ────────────────────────────────────────────────────────────

class MasterLists(BaseModel):
    manpower: list[str] = []
    equipment: list[str] = []


class CustomResourceCodes(BaseModel):
    labor: list[str] = []
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
    custom_resource_codes: CustomResourceCodes = Field(default_factory=CustomResourceCodes)
    user_templates: list[dict[str, Any]] = []
    # Project defaults. These were stored in settings.json but missing from this
    # payload, so the Settings page could never actually set them — which is why
    # weather fell back to a browser prompt on every report, and why backfill
    # skipped weather entirely.
    default_zip_code: str = ""
    default_company: str = ""
    project_number: str = ""
    project_location: str = ""
    word_filename_prefix: str = "Morena Conveyance North"


class SyncResourcesPayload(BaseModel):
    resources: list[str]


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


class BackfillConfigPayload(BaseModel):
    tunnel_foremen: list[str] = []
    tunnel_job_keywords: list[str] = ["805", "tunnel"]


@router.put("/backfill")
def update_backfill_config(payload: BackfillConfigPayload) -> dict[str, Any]:
    """
    Update the backfill scope rule (which sheets count as 805 tunnel work).

    Kept out of the main SettingsPayload so a normal settings save from the
    Settings page can never blank it out.
    """
    data = _load()
    data["backfill"] = payload.model_dump()
    _save(data)
    return {"status": "success", "backfill": data["backfill"]}


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


BUILTIN_LABOR = {
    "LL-01- Superintendent", "LL-02- Foreman", "LL-03- Laborers", "LL-04- Operator", "LL-05- Journeyman", 
    "LL-06- Apprentice", "LL-07- Engineer", "LL-08- PM", "LL-09- PE", "LL-10- GF", "LL-11- Teamster", 
    "LL-12- Carpenter", "LL-13- Ironworker", "LL-14- Pump Operator", "LL-15- Cement Mason", 
    "LL-16- Vac Truck Operator", "LL-17- Electrician", "LL-18- Visitor", "LL-19- Welder", 
    "LL-20- Certified Welding Inspector (CWI)", "LL-21- NDT Technician", "LL-22- Safety Manager", 
    "LL-23- Paleontologist", "LL-24- Archaeologist", "LL-25- Environmental Monitor", "LL-26- Biologist", 
    "LL-27- Native American Monitor", "LL-28- Pipe Fitter", "LL-29- Painters", "LL-30- Material Handler", 
    "LL-31- Survey Crew", "LL-32- AEC NETA Technician", "LL-33- RESA Power Technician", "LL-34- Plumber", 
    "LL-35- ABB - Field Engineer", "LL-36- ACE Crane Technician", "LL-37- CSI Technician", 
    "LL-38- Select Electric Technician", "LL-39- Big Sky Electric Tech.",
}

BUILTIN_EQUIPMENT = {
    "LE-01- Crew Truck", "LE-02- CAT 950 Wheel Loader", "LE-03- Bobcat", "LE-04- Mini Excavator", "LE-05- CAT 330 Excavator", 
    "LE-07- Skyjacker (fork lift)", "LE-09- Skip Loader", "LE-10- CAT 336", "LE-100- Liebherr LB20 Drill Rig", 
    "LE-101- Lily Corp CD15 Epoxy Injection Dispenser", "LE-102- AHEARN Single Man Lift", 
    "LE-103- Magnum X7 True Airless Epoxy Injection Sprayer", "LE-104- McElroy 824 Fusion Welding Machine", 
    "LE-105- Generac Generator - United Rentals", "LE-106- Link Belt RTC 8075", "LE-107- APE Hammer VS200 w/power unit", 
    "LE-108- Backhoe", "LE-109- Excavator", "LE-11- CAT D5 Dozer", "LE-110- Compressor", "LE-111- Trailer Mounted Blower", 
    "LE-112- Hilti PS 1000 Ground Penetrating Radar", "LE-113- McElroy Tracstar 16-inch Fusion Machine", "LE-114- Crane", 
    "LE-115- ABI Mobilram", "LE-116- McElroy Tracstar 24-inch Fusion", "LE-117- Seal Boss PA 3000 Epoxy Injection Pump", 
    "LE-118- Barge", "LE-119- John Deere 710K Backhoe Loader", "LE-12- CAT 637D Scrapper", "LE-120- CAT TL1055 Telehandler", 
    "LE-121- Case CX225SR Excavator", "LE-122- John Deere 324G Skid Steer", "LE-123- John Deere 410L Backhoe", 
    "LE-124- CAT D5G LGP Dozer", "LE-125- Skid Steer", "LE-126- Baker Tank", "LE-127- CAT 246D Skid Steer", 
    "LE-128- General – Fork Lift", "LE-129- Genie Z-30/20N RJ Boom Lift", "LE-13- Roller H222", "LE-130- Tunnel Boring Machine", 
    "LE-131- CAT TRS3312 fork lift", "LE-132- Yale 26637 fork lift", "LE-133- Snorkel MB26J Man Lift", 
    "LE-134- CAT 352 Excavator", "LE-135- John Deere 325G Skid Steer", "LE-136- John Deere Mini Excavator 35G", 
    "LE-139- CAT 410J Loader Backhoe", "LE-14- Water Truck F750", "LE-140- Ditch Witch HX30 Vacuum Excavator", 
    "LE-141- JLG Telehandler 534D10-45", "LE-142- HITACHI ZAXIS 75US excavator", "LE-143- Cat® 259B Series 3 Compact Track Loader", 
    "LE-144- KOBELCO SK210LC Excavator", "LE-146- JCB 512 Telehandler", "LE-147- Caterpillar 249D3 Compact Track Loader", 
    "LE-148- Model No. U55-4 Kubota Tight Tail Swing Compact Excavator", "LE-149- BOMAG BW 124 PDH Single Drum Roller", 
    "LE-15- Deer 350G excavator", "LE-150- Tunnel Slurry Separation Plant", "LE-151- KOBELCO SK55SRX-7 Mini Excavator", 
    "LE-152- CAT 308E2 CR Mini Excavator", "LE-153- Hydraulic Power Unit", "LE-154- Bentonite Mixing Tank", 
    "LE-155- Wacker Neuson RTLx-SC3 Trench Roller", "LE-156- LORAIN LRT-275 Crane", "LE-157- Tack Truck", "LE-158- CCTV Truck", 
    "LE-159- Roller", "LE-160- Pup Roller", "LE-16- CAT 14H Grader", "LE-17- Volvo SD 115 B Compactor", "LE-18- CAT D6 Dozer", 
    "LE-19- Street sweeper", "LE-21- Kobelco SK 485 Excavator", "LE-22- Yanmar ViO 25 Mini Excavator", 
    "LE-23- Super 10 End Dump Truck", "LE-24- Cat 374 FL Excavator", "LE-25- Cat D5K2 XL Dozer", "LE-26- Cat 966H Loader", 
    "LE-27- JLG Lift", "LE-28- Water Truck", "LE-29- Hamm Single Drum Sheeps Foot Roller", "LE-30- Deere 210L Skip Loader", 
    "LE-31- Cat 335F Excavator", "LE-32- Skytrak Forklift", "LE-33- Cat 730C Articulated Haul Truck", "LE-34- Concrete Boom Pump", 
    "LE-35- Light Tower", "LE-36- Sunstate Rental Dump Truck", "LE-37- Cat 420F Backhoe", "LE-38- Cat 430 Backhoe", 
    "LE-39- Cat 304E Mini Ex", "LE-40- Badger Vac Truck", "LE-41- Saw Cutter", "LE-42- Utility Truck", "LE-43- Cat 325F Excavator", 
    "LE-44- Kobelco CK 1100 Crawler Crane", "LE-45- Cat 259D Skid Steer", "LE-46- Greenle 555 Pipe Bender", 
    "LE-47- Pipe Threader Ridgid 1224", "LE-49- PVC Pipe Heater", "LE-50- Roto Hammer", "LE-51- Pickup Truck", 
    "LE-52- CAT 140M2 Grader", "LE-53- Cat 315F Excavator", "LE-54- Vibratory Soil Compactor CS44B", 
    "LE-56- Xtreme Telehandler XR4030", "LE-57- Miller Trailblazer Welding Generator", "LE-58- Welding Truck", 
    "LE-59- Genie S-65 Boom Lift", "LE-60- Sakai SV410 Sheepsfoot Roller", "LE-61- Wacker RD12 Roller", 
    "LE-62- Genie GTH 5519 Forklift", "LE-63- Asphalt Paver", "LE-64- Truck-Mounted Auger Drill", 
    "LE-65- Crane-Mounted Auger Drill", "LE-66- Concrete Mixer", "LE-67- Concrete Pump Truck", "LE-69- Jackhammer", 
    "LE-70- Generator", "LE-71- Pavement Grinder", "LE-72- Arrow Board", "LE-75- Polaris Ranger", 
    "LE-76- Generator Multiquip", "LE-77- Cat 321D LCR Hydraulic Excavator", "LE-78- Freightliner M2-106 LW2000", 
    "LE-79- Bomag BMP 8500", "LE-80- Hamm HD12 Vibratory Roller Compactor", "LE-81- Mechanical Wacker", 
    "LE-82- Vactor Truck", "LE-83- Equipment-Hauling Trailer", "LE-84- TracStar 900 HDPE Fusion Machine", 
    "LE-85- Maxim 250 Crawler Crane", "LE-86- CAT TL1255D", "LE-87- Kenworth - T370", "LE-89- McElroy 2401 Fusion Welding Machine", 
    "LE-90- MQ Power 70 Whisperwatt Generator", "LE-91- Model – BOMAG 211D Roller", "LE-92- McElroy 711301", 
    "LE-93- Maxim LR 1100 Crane", "LE-94- Lincoln LN-25 Wire Feeder", "LE-95- Lincoln Vantage Welding Generator", 
    "LE-96- Toyota Forklift (Mid Capacity 8FGU30)", "LE-97- Hoist P550 Forklift", "LE-98- Scissor Lift", 
    "LE-99- JLG E300AJP Electric Boom Lift",
}

@router.post("/sync-pmweb-resources")
def sync_pmweb_resources(payload: SyncResourcesPayload) -> dict[str, Any]:
    """
    Sync scraped resources directly from PMWeb.
    Filters by LL- and LE- prefixes, deduplicates, and filters out builtin codes.
    """
    data = _load()
    if "custom_resource_codes" not in data:
        data["custom_resource_codes"] = {"labor": [], "equipment": []}
        
    custom = data["custom_resource_codes"]
    
    # Store initial counts to calculate how many NEW ones were actually added
    initial_labor_count = len(custom["labor"])
    initial_equip_count = len(custom["equipment"])
    
    for r in payload.resources:
        r = r.strip()
        if r.startswith("LL-") and r not in BUILTIN_LABOR:
            custom["labor"].append(r)
        elif r.startswith("LE-") and r not in BUILTIN_EQUIPMENT:
            custom["equipment"].append(r)
            
    # Deduplicate arrays to prevent endless growth
    custom["labor"] = list(dict.fromkeys(custom["labor"]))
    custom["equipment"] = list(dict.fromkeys(custom["equipment"]))
    
    data["custom_resource_codes"] = custom
    _save(data)
    
    new_labor = len(custom["labor"]) - initial_labor_count
    new_equip = len(custom["equipment"]) - initial_equip_count
    
    logger.info(f"[settings] Synced PMWeb resources: added {new_labor} labor, {new_equip} equipment")
    # Return the delta (new items added) instead of total length
    return {"status": "success", "counts": {"labor": new_labor, "equipment": new_equip}}
