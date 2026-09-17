/**
 * Daily Reporter — one readable line per crew or equipment row.
 *
 * WHY THIS EXISTS: on a phone the resource grid used to become a stack of cards
 * with ten labelled fields each, so a crew of eight was a long scroll and there
 * was no way to see the whole crew at once. The phone list shows each row as a
 * single line built here - "LL-03- Laborers", "x4 - 8 hrs - OHL NA -
 * 7:00 AM-3:30 PM", plus any flags - and totals for the section on top.
 *
 * Pure functions with no React in them, so the wording is tested on its own.
 */

import { formatQty } from '@/lib/formatters';
import type { EquipmentRow, ManpowerRow } from '@/types';

export type ResourceKind = 'manpower' | 'equipment';
type AnyRow = ManpowerRow | EquipmentRow;

export interface ResourceLine {
  /** The resource - the trade or the machine. Empty until one is picked. */
  title: string;
  /** The person's name, or the equipment number. */
  subtitle: string;
  /** Quantity, hours, company and times, joined with a middle dot. */
  detail: string;
  /** Anything flagged on the row, in plain words. */
  flags: string[];
}

const DOT = ' · ';

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function timeRange(start: string, stop: string): string {
  if (start && stop) return `${start}–${stop}`;
  if (start) return `from ${start}`;
  if (stop) return `until ${stop}`;
  return '';
}

export function resourceLine(row: AnyRow, kind: ResourceKind): ResourceLine {
  const isManpower = kind === 'manpower';
  const qty = num(row.qty);
  const hours = num(row.hours);

  const detail = [
    qty > 0 ? `×${qty}` : '',
    hours > 0 ? `${formatQty(hours)} hrs` : '',
    text(row.company),
    timeRange(text(row.start_time), text(row.stop_time)),
  ].filter(Boolean).join(DOT);

  const flags = [
    row.is_extra_work ? 'Extra work' : '',
    row.is_3rd_party ? '3rd party' : '',
    row.is_consultant ? 'Consultant' : '',
    !isManpower && (row as EquipmentRow).is_rental ? 'Rental' : '',
    row.locked ? 'Locked' : '',
  ].filter(Boolean);

  return {
    title: isManpower ? text((row as ManpowerRow).trade) : text((row as EquipmentRow).name),
    subtitle: isManpower ? text((row as ManpowerRow).name) : text((row as EquipmentRow).description),
    detail,
    flags,
  };
}

/**
 * Whether a row holds anything worth confirming before it is removed.
 *
 * A row just added carries default times and a default company, so those do
 * not count - otherwise removing a row tapped by mistake would ask "are you
 * sure?" about a row with nothing in it.
 */
export function hasContent(row: AnyRow, kind: ResourceKind): boolean {
  const line = resourceLine(row, kind);
  return Boolean(line.title || line.subtitle || num(row.qty) > 0);
}

/**
 * The section at a glance: "3 rows · 7 people · 56 hrs".
 *
 * Hours are counted per person, the way the report header counts them: a row
 * of 4 laborers at 8 hours is 32 hours. A row with no quantity yet counts once,
 * so its hours are not silently left out.
 */
export function resourceTotals(rows: AnyRow[], kind: ResourceKind): string {
  if (!rows.length) return '';

  const units = rows.reduce((sum, r) => sum + Math.max(num(r.qty), 0), 0);
  const hours = rows.reduce((sum, r) => sum + num(r.hours) * (num(r.qty) > 0 ? num(r.qty) : 1), 0);

  const rowWord = rows.length === 1 ? 'row' : 'rows';
  const unitWord = kind === 'manpower'
    ? (units === 1 ? 'person' : 'people')
    : (units === 1 ? 'unit' : 'units');

  return [
    `${rows.length} ${rowWord}`,
    `${formatQty(units)} ${unitWord}`,
    `${formatQty(hours)} hrs`,
  ].join(DOT);
}
