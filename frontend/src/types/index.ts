/**
 * Daily Reporter V3 — Core Type Definitions
 *
 * These interfaces define the shape of ALL data in the application.
 * TypeScript enforces them at compile time — field-name typos become
 * editor errors instead of runtime data loss.
 */

// ============================================
// REPORT TYPES
// ============================================

/** A single daily field report */
export interface Report {
  id: string;
  general: GeneralInfo;
  activities: Activity[];
  photos: PhotoAttachment[];
  status: ReportStatus;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/** Report header / project info */
export interface GeneralInfo {
  project_name: string;
  project_number: string;
  project_location: string;
  inspector_name: string;
  resident_engineer: string;
  report_date: string; // YYYY-MM-DD
  start_time: string;  // HH:MM
  end_time: string;    // HH:MM
  sky_conditions: SkyCondition[];
  temperature_high: string;
  temperature_low: string;
  wind_info: string;
  notes: string;
}

/** Multi-select sky condition */
export interface SkyCondition {
  id: string;
  label: string;
  emoji: string;
}

/** A single work activity within a report */
export interface Activity {
  id: string;
  work_area: string;
  stations: string;
  summary: string;
  manpower: ManpowerRow[];
  equipment: EquipmentRow[];
  extra_work_manpower: ManpowerRow[];
  extra_work_equipment: EquipmentRow[];
  consultant_manpower: ManpowerRow[];
}

/** A single manpower entry (one trade/person) */
export interface ManpowerRow {
  id: string;
  trade: string;      // e.g. "LL-03- Laborers"
  name: string;       // Individual name (optional)
  qty: number;        // Headcount
  hours: number;      // Hours worked
  company: string;    // Employer
  classification: string;
  is_extra_work: boolean;
  is_consultant: boolean;
}

/** A single equipment entry */
export interface EquipmentRow {
  id: string;
  name: string;        // e.g. "LE-05- CAT 330 Excavator"
  description: string;
  qty: number;
  hours: number;
  company: string;
  is_extra_work: boolean;
}

/** Photo attached to a report */
export interface PhotoAttachment {
  id: string;
  filename: string;
  caption: string;
  timestamp: string;
  url: string; // Relative path to the photo file on the server
}

export type ReportStatus = 'draft' | 'submitted' | 'archived';

// ============================================
// TRACKER TYPES
// ============================================

export interface ExcavationEntry {
  id: string;
  date: string;
  station_from: string;
  station_to: string;
  depth: string;
  soil_type: string;
  notes: string;
  created_at: string;
}

export interface PayItem {
  id: string;
  item_number: string;
  description: string;
  unit: string;
  contract_qty: number;
  installed_qty: number;
  remaining_qty: number;
  notes: string;
  updated_at: string;
}

export interface PunchItem {
  id: string;
  description: string;
  location: string;
  responsible_party: string;
  status: 'open' | 'in_progress' | 'closed';
  priority: 'low' | 'medium' | 'high';
  date_opened: string;
  date_closed: string | null;
  notes: string;
}

export interface RedlineEntry {
  id: string;
  drawing_number: string;
  description: string;
  status: 'pending' | 'reviewed' | 'incorporated';
  date_submitted: string;
  date_resolved: string | null;
  notes: string;
}

// ============================================
// AUTH TYPES
// ============================================

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  is_approved: boolean;
  gemini_api_key: string | null;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
}

// ============================================
// SETTINGS TYPES
// ============================================

export interface ProjectSettings {
  default_project_name: string;
  default_project_number: string;
  default_project_location: string;
  default_inspector_name: string;
  default_resident_engineer: string;
  default_start_time: string;
  default_end_time: string;
  weather_zip: string;
  weather_lat: string;
  weather_lon: string;
}

// ============================================
// API RESPONSE TYPES
// ============================================

export interface ApiError {
  detail: string;
  status: number;
}

export interface ScanResult {
  activities: Activity[];
  raw_text: string;
  confidence: number;
}

export interface DictationResult {
  activities: Activity[];
  transcript: string;
}

export interface PdfSearchResult {
  answer: string;
  sources: PdfSource[];
}

export interface PdfSource {
  document_name: string;
  page_number: number;
  excerpt: string;
}
