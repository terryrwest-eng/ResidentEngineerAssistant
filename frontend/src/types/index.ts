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
  trade: string;         // PMWeb resource code e.g. "LL-03- Laborers"
  name: string;          // Individual name (optional)
  qty: number;           // Headcount
  hours: number;         // Hours worked
  start_time: string;    // e.g. "7:00 AM"
  stop_time: string;     // e.g. "3:30 PM"
  company: string;       // Employer
  classification: string;
  is_3rd_party: boolean;
  is_extra_work: boolean;
  is_consultant: boolean;
  locked: boolean;       // Protected from bulk apply
}

/** A single equipment entry */
export interface EquipmentRow {
  id: string;
  name: string;          // PMWeb resource code e.g. "LE-05- CAT 330 Excavator"
  description: string;   // Equipment number e.g. "F450"
  qty: number;
  hours: number;
  start_time: string;    // e.g. "7:00 AM"
  stop_time: string;     // e.g. "3:30 PM"
  company: string;
  is_3rd_party: boolean;
  is_extra_work: boolean;
  is_consultant: boolean;
  is_rental: boolean;
  locked: boolean;       // Protected from bulk apply
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

// ============================================
// DISPATCH TYPES
// ============================================

/** A single crew member entry from dispatch */
export interface DispatchCrewMember {
  name: string;
  time: string;
}

/** Equipment entry from dispatch */
export interface DispatchEquipmentItem {
  id: string;
  description: string;
}

/** Sub/rental info from dispatch */
export interface DispatchSubInfo {
  company: string;
  details: string;
  count?: number;
  time?: string;
}

/** A single job column from the dispatch */
export interface DispatchJob {
  column_index: number;
  job_number: string;
  job_name: string;
  job_description: string;
  contract_type: string;
  streets: string[];
  location: string;
  start_time: string;
  load_time: string;
  material: string;
  plant: string;
  foreman: DispatchCrewMember & { role: string };
  operators: DispatchCrewMember[];
  laborers: DispatchCrewMember[];
  rakers: DispatchCrewMember[];
  traffic_control: DispatchCrewMember[];
  equipment: DispatchEquipmentItem[];
  trucking: DispatchSubInfo;
  grinders: DispatchSubInfo;
  sub_brooms: DispatchSubInfo;
  sub_traffic_control: DispatchSubInfo;
  oil_truck: { driver: string; equipment_id: string; equipment_desc: string; material: string };
  rentals: { company: string; description: string }[];
}

/** Response from POST /api/ai/parse-dispatch */
export interface DispatchParseResult {
  date: string;
  company: string;
  jobs: DispatchJob[];
}

// ============================================
// SCHEDULE TYPES
// ============================================

/** A single digout row in the schedule */
export interface ScheduleRow {
  direction: string;
  do_number: string;
  depth: number;
  width: number;
  length: number;
  sf: number;
  tons: number;
  added: boolean;
}

/** A shift group containing multiple digout rows */
export interface ScheduleShift {
  rows: ScheduleRow[];
  total_sf: number;
  total_tons: number;
}

/** A complete parsed schedule */
export interface Schedule {
  id: string;
  filename: string;
  uploaded_at: string;
  total_shifts: number;
  schedule_type: 'digout' | 'grind_overlay';
  shifts: Record<string, ScheduleShift>;
}

// ============================================
// DISPATCH LIBRARY
// ============================================

/** A stored dispatch entry in the library */
export interface DispatchLibraryEntry {
  date: string;
  filename: string;
  company: string;
  job_count: number;
  uploaded_at: string;
}

/** Response from uploading a single dispatch PDF */
export interface DispatchUploadResponse extends DispatchLibraryEntry {
  jobs: DispatchJob[];
}

/** Result for a single file in a batch upload */
export interface BatchUploadResult {
  date: string;
  filename: string;
  status: 'success' | 'error';
  job_count: number;
  error: string | null;
}

/** Response from batch uploading multiple dispatch PDFs */
export interface BatchUploadResponse {
  results: BatchUploadResult[];
  success_count: number;
  error_count: number;
}

// ============================================
// TRAFFIC CONTROL AI
// ============================================

/** Request payload for TC activity generation */
export interface TCGenerateRequest {
  streets: string[];
  location: string;
  tc_crew: { name: string; time: string }[];
  sub_tc: { company: string; details: string; count?: number; time?: string } | null;
  work_description: string;
  schedule_shift: string;
  start_time: string;
  end_time: string;
}

/** Response from TC activity generation */
export interface TCGenerateResponse {
  summary: string;
  work_area: string;
}

