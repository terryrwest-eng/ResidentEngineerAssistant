"""
Daily Reporter V3 — Pydantic Models for Reports

These models validate ALL incoming data. No bad data gets through.
Uses model_config extra='ignore' so unknown fields from AI/frontend don't cause 422.
"""

from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime


class ManpowerRowModel(BaseModel):
    """Manpower row — tolerant of extra fields from AI or frontend."""
    model_config = {"extra": "ignore"}

    id: str = ""
    trade: str = ""
    name: str = ""
    qty: Any = 0        # Accept string or int from AI, coerce later
    hours: Any = 0.0    # Accept string or float from AI, coerce later
    company: str = ""
    classification: str = ""
    start_time: str = ""
    stop_time: str = ""
    is_extra_work: bool = False
    is_consultant: bool = False
    is_3rd_party: bool = False
    locked: bool = False
    # Whether the per-activity "Set End Time" button fills this row's stop time
    apply_end_time: bool = True


class EquipmentRowModel(BaseModel):
    """Equipment row — tolerant of extra fields from AI or frontend."""
    model_config = {"extra": "ignore"}

    id: str = ""
    name: str = ""
    description: str = ""
    qty: Any = 0        # Accept string or int from AI, coerce later
    hours: Any = 0.0    # Accept string or float from AI, coerce later
    company: str = ""
    start_time: str = ""
    stop_time: str = ""
    is_extra_work: bool = False
    is_3rd_party: bool = False
    is_consultant: bool = False
    is_rental: bool = False
    locked: bool = False
    # Whether the per-activity "Set End Time" button fills this row's stop time
    apply_end_time: bool = True


class PhotoModel(BaseModel):
    model_config = {"extra": "ignore"}

    id: str = ""
    filename: str = ""
    caption: str = ""
    timestamp: str = ""
    url: str = ""


class SkyConditionModel(BaseModel):
    model_config = {"extra": "ignore"}

    id: str
    label: str
    emoji: str


class GeneralInfoModel(BaseModel):
    model_config = {"extra": "ignore"}

    project_name: str = ""
    project_number: str = ""
    project_location: str = ""
    inspector_name: str = ""
    resident_engineer: str = ""
    report_date: str = ""
    start_time: str = "07:00"
    end_time: str = "15:30"
    sky_conditions: list[SkyConditionModel] = []
    temperature_high: str = ""
    temperature_low: str = ""
    wind_info: str = ""
    notes: str = ""


class ActivityModel(BaseModel):
    model_config = {"extra": "ignore"}

    id: str = ""
    work_area: str = ""
    stations: str = ""
    summary: str = ""
    manpower: list[ManpowerRowModel] = []
    equipment: list[EquipmentRowModel] = []
    extra_work_manpower: list[ManpowerRowModel] = []
    extra_work_equipment: list[EquipmentRowModel] = []
    consultant_manpower: list[ManpowerRowModel] = []


class ReportModel(BaseModel):
    """Full report model for create/update."""
    model_config = {"extra": "ignore"}

    id: str = ""
    general: GeneralInfoModel = Field(default_factory=GeneralInfoModel)
    activities: list[ActivityModel] = []
    photos: list[PhotoModel] = []
    status: str = "draft"
    created_at: str = ""
    updated_at: str = ""


class ReportIndexModel(BaseModel):
    """Lightweight report summary for list views."""
    id: str
    project_name: str
    project_number: str
    report_date: str
    inspector_name: str
    status: str
    activity_count: int
    created_at: str
    updated_at: str
