/**
 * One definition of what a brand new report starts with.
 *
 * WHY THIS EXISTS
 *
 * There are two ways to start a report — Quick Create and New Report — and they
 * used to seed different fields from the same Settings page:
 *
 *   Quick Create   project_name, project_number, project_location,
 *                  inspector_name, resident_engineer, start_time
 *                  (and deliberately blanked end_time)
 *   New Report     project_name, resident_engineer, start_time, end_time
 *
 * So which button you happened to press decided whether your project number and
 * location were filled in, and whether the report had an end time. Same app,
 * same settings, two different starting reports.
 *
 * Both paths now call buildReportDefaults, so a default configured in Settings
 * means the same thing everywhere.
 */

import type { GeneralInfo } from '@/types';

/** The Settings fields that seed a new report. */
export interface ReportDefaultSettings {
  default_project?: string;
  default_project_number?: string;
  default_project_location?: string;
  default_inspector_name?: string;
  default_resident_engineer?: string;
  default_start_time?: string;
  default_stop_time?: string;
}

/**
 * Convert a Settings time ("7:00 AM", "07:00", "9:00") into the "HH:MM" that an
 * <input type="time"> will accept.
 *
 * Returns '' for anything unparseable rather than passing it through: a value
 * the input rejects renders as an empty box either way, and an empty string at
 * least says so honestly instead of looking like data that failed to load.
 */
export function to24Hour(value: string): string {
  if (!value?.trim()) return '';

  const match12 = value.match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i);
  if (match12) {
    let hrs = parseInt(match12[1], 10);
    const period = match12[3].toUpperCase();
    if (period === 'PM' && hrs !== 12) hrs += 12;
    if (period === 'AM' && hrs === 12) hrs = 0;
    return `${hrs.toString().padStart(2, '0')}:${match12[2]}`;
  }

  // Already 24-hour, but possibly unpadded ("9:00"), which the input rejects.
  const match24 = value.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (match24) {
    const hrs = parseInt(match24[1], 10);
    if (hrs > 23) return '';
    return `${hrs.toString().padStart(2, '0')}:${match24[2]}`;
  }

  return '';
}

/**
 * Build the general-info defaults for a new report.
 *
 * `overrides` is for things the caller knows that Settings does not — Quick
 * Create passes the date the user picked, for instance. Anything passed here
 * wins over the Settings-derived value.
 *
 * Note on end_time: it is seeded from default_stop_time. Quick Create used to
 * leave it blank on the grounds that "Set End Time" fills times in later, but
 * that button fills the stop times on each activity's crew rows — it does not
 * touch the report's own end time. Blanking it meant a stop time configured in
 * Settings was silently ignored on one of the two paths.
 */
export function buildReportDefaults(
  settings: ReportDefaultSettings,
  overrides: Partial<GeneralInfo> = {},
): Partial<GeneralInfo> {
  return {
    project_name: settings.default_project || '',
    project_number: settings.default_project_number || '',
    project_location: settings.default_project_location || '',
    inspector_name: settings.default_inspector_name || '',
    resident_engineer: settings.default_resident_engineer || '',
    start_time: to24Hour(settings.default_start_time || ''),
    end_time: to24Hour(settings.default_stop_time || ''),
    ...overrides,
  };
}
