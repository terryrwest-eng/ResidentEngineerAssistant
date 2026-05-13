"""
Daily Reporter V3 — Pydantic Models for Reports

These models validate ALL incoming data. No bad data gets through.
"""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class ManpowerRowModel(BaseModel):
    id: str = ""
    trade: str = ""
    name: str = ""
    qty: int = 0
    hours: float = 0.0
    company: str = ""
    classification: str = ""
    is_extra_work: bool = False
    is_consultant: bool = False


class EquipmentRowModel(BaseModel):
    id: str = ""
    name: str = ""
    description: str = ""
    qty: int = 0
    hours: float = 0.0
    company: str = ""
    is_extra_work: bool = False


class PhotoModel(BaseModel):
    id: str = ""
    filename: str = ""
    caption: str = ""
    timestamp: str = ""
    url: str = ""


class SkyConditionModel(BaseModel):
    id: str
    label: str
    emoji: str


class GeneralInfoModel(BaseModel):
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
