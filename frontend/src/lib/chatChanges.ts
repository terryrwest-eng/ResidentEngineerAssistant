/**
 * Describing what the assistant is about to change — including what it removes.
 *
 * WHY THIS EXISTS
 *
 * The chat assistant returns partial patches, and the app merges them field by
 * field: `updateActivity(id, { summary })` overwrites the WHOLE summary with
 * whatever came back. That is correct for "rewrite the summary" and destructive
 * for "add a line to the summary" — the two are indistinguishable once the
 * patch is a bare string.
 *
 * The confirmation gate used to say "1 activity updated" for both. A patch that
 * quietly dropped three bullets looked exactly like one that added a fourth, so
 * there was no way to catch it before pressing Apply.
 *
 * This module diffs the patch against the report as it stands and names what
 * disappears. The point is not to block the model — it is to make the model's
 * mistakes visible while they are still one tap from being thrown away.
 */

import type { Activity } from '@/types';

/** One field's worth of change, described in the user's terms. */
export interface FieldChange {
  /** Human label for the field, e.g. "Summary". */
  label: string;
  /** Lines/values this change adds. */
  added: string[];
  /**
   * Lines/values this change removes. Anything in here is content that exists
   * in the report now and will not exist after Apply.
   */
  removed: string[];
  /** True when the field is being replaced wholesale with unrelated text. */
  replaced?: { from: string; to: string };
}

/** Everything about to happen to one activity. */
export interface ActivityChange {
  id: string;
  /** Work area if we can resolve it, else a short id — for naming the activity. */
  name: string;
  fields: FieldChange[];
}

/** True when this change takes away content that is in the report today. */
export function isDestructive(change: ActivityChange): boolean {
  return change.fields.some(f => f.removed.length > 0 || f.replaced !== undefined);
}

/** Split a summary into its bullet lines, ignoring blanks and bullet glyphs. */
function summaryLines(summary: string): string[] {
  return String(summary || '')
    .split('\n')
    .map(l => l.replace(/^[\s•\-*]+/, '').trim())
    .filter(l => l.length > 0);
}

/**
 * Compare two summaries by their lines.
 *
 * Line-level rather than character-level because that is the unit the user
 * thinks in — "it dropped the paving bullet", not "it changed 40 characters".
 * Comparison is case-insensitive and whitespace-normalised so a bullet the
 * model reworded punctuation on doesn't read as a delete plus an add.
 */
function diffSummary(before: string, after: string): FieldChange | null {
  const beforeLines = summaryLines(before);
  const afterLines = summaryLines(after);

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
  const afterSet = new Set(afterLines.map(norm));
  const beforeSet = new Set(beforeLines.map(norm));

  const removed = beforeLines.filter(l => !afterSet.has(norm(l)));
  const added = afterLines.filter(l => !beforeSet.has(norm(l)));

  if (removed.length === 0 && added.length === 0) return null;
  return { label: 'Summary', added, removed };
}

/** Rows are compared by the fields a person would read off the screen. */
function rowLabel(row: Record<string, unknown>): string {
  const name = String(row.trade || row.name || '').trim();
  const qty = row.qty ? `×${row.qty}` : '';
  const hours = row.hours ? `${row.hours}h` : '';
  const company = String(row.company || '').trim();
  return [name, qty, hours, company].filter(Boolean).join(' · ') || '(blank row)';
}

/**
 * Compare two resource arrays (manpower, equipment, …) by row identity.
 *
 * Rows carry stable ids, so an id present before and absent after is a genuine
 * removal rather than a reorder. Rows without an id fall back to their label.
 */
function diffRows(
  label: string,
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): FieldChange | null {
  const key = (r: Record<string, unknown>) => String(r.id || rowLabel(r));
  const afterKeys = new Set(after.map(key));
  const beforeKeys = new Set(before.map(key));

  const removed = before.filter(r => !afterKeys.has(key(r))).map(rowLabel);
  const added = after.filter(r => !beforeKeys.has(key(r))).map(rowLabel);

  if (removed.length === 0 && added.length === 0) return null;
  return { label, added, removed };
}

/** Plain text fields where any change replaces the old value outright. */
const TEXT_FIELDS: { field: keyof Activity; label: string }[] = [
  { field: 'work_area', label: 'Work area' },
  { field: 'stations', label: 'Stations' },
];

/** Resource arrays, in the order they appear in the activity. */
const ROW_FIELDS: { field: keyof Activity; label: string }[] = [
  { field: 'manpower', label: 'Crew' },
  { field: 'equipment', label: 'Equipment' },
  { field: 'extra_work_manpower', label: 'Extra work crew' },
  { field: 'extra_work_equipment', label: 'Extra work equipment' },
  { field: 'consultant_manpower', label: 'Consultant crew' },
];

/**
 * Describe a single activity patch against the activity as it stands.
 *
 * Returns null when the patch changes nothing we can show — a patch for an
 * activity that is not in the report, or one whose fields all match what is
 * already there.
 */
export function describeActivityPatch(
  patch: Partial<Activity> & { id: string },
  current: Activity[],
): ActivityChange | null {
  const existing = current.find(a => a.id === patch.id);
  if (!existing) return null;

  const fields: FieldChange[] = [];

  if (typeof patch.summary === 'string') {
    const change = diffSummary(existing.summary, patch.summary);
    if (change) fields.push(change);
  }

  for (const { field, label } of TEXT_FIELDS) {
    const next = patch[field];
    if (typeof next !== 'string') continue;
    const prev = String(existing[field] || '');
    if (prev.trim() === next.trim()) continue;
    // An empty previous value is a fill-in, not a replacement — nothing is lost.
    if (!prev.trim()) {
      fields.push({ label, added: [next], removed: [] });
    } else {
      fields.push({ label, added: [], removed: [], replaced: { from: prev, to: next } });
    }
  }

  for (const { field, label } of ROW_FIELDS) {
    const next = patch[field];
    if (!Array.isArray(next)) continue;
    const prev = (existing[field] as unknown as Record<string, unknown>[]) || [];
    const change = diffRows(label, prev, next as unknown as Record<string, unknown>[]);
    if (change) fields.push(change);
  }

  if (fields.length === 0) return null;

  return {
    id: patch.id,
    name: existing.work_area?.trim() || `Activity ${patch.id.slice(0, 6)}`,
    fields,
  };
}

/** Describe every activity patch in a pending change set. */
export function describeActivityPatches(
  patches: (Partial<Activity> & { id: string })[],
  current: Activity[],
): ActivityChange[] {
  return patches
    .map(p => describeActivityPatch(p, current))
    .filter((c): c is ActivityChange => c !== null);
}
