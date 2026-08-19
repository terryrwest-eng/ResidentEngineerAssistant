/**
 * Daily Reporter V3 — report flow helpers
 *
 * Which format a report belongs to, and how interview answers become report
 * content. Kept out of the page so the mapping is testable and so a third
 * project means editing one file rather than a component.
 */

import type { Report } from '@/types';

/** Project name → profile key. Mirrors the backend's resolution. */
const PROFILE_BY_NAME: Record<string, string> = {
  'morena conveyance north': 'morena',
  'tecolote channel': 'tecolote',
};

/**
 * The profile a report belongs to.
 *
 * Resolved from the project name stored on the report rather than held
 * separately, so a report written before profiles existed still opens in the
 * format it was written in. Anything unrecognised falls back to the original
 * layout — never an error, because an unknown project must still be editable.
 */
export function getProfileKey(report: Report | null): string {
  const name = (report?.general?.project_name || '').trim().toLowerCase();
  if (!name) return 'morena';
  if (PROFILE_BY_NAME[name]) return PROFILE_BY_NAME[name];
  for (const [known, key] of Object.entries(PROFILE_BY_NAME)) {
    if (name.includes(known) || known.includes(name)) return key;
  }
  return 'morena';
}

/**
 * Interview answers as they are stored on the report.
 *
 * Kept as a block beside the activities rather than scattered into fields:
 * several answers describe the day and have no activity to belong to, and
 * keeping the raw answers means a later format change can re-render an old
 * report instead of losing what was said.
 */
export interface InterviewState {
  profile: string;
  answers: Record<string, string>;
  rows: Record<string, Record<string, unknown>[]>;
  /** Marked once the inspector reaches the end, so an abandoned run is
   *  distinguishable from a finished one that genuinely had little in it. */
  completed: boolean;
}

export function buildInterviewState(
  profile: string,
  answers: Record<string, string>,
  rows: Record<string, Record<string, unknown>[]>,
  completed: boolean,
): InterviewState {
  return { profile, answers, rows, completed };
}
