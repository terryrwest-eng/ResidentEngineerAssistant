/**
 * Daily Reporter V3 — report flow helpers
 *
 * Which format a report belongs to, and how interview answers become report
 * content. Kept out of the page so the mapping is testable and so a third
 * project means editing one file rather than a component.
 */

import type { Report, Activity } from '@/types';

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

// ============================================
// Turning interview answers into real report data
// ============================================

/**
 * Marks an activity as belonging to one pass of the interview.
 *
 * The interview owns the activities it creates and nothing else. Anything added
 * by hand in the editor has no marker and is never touched, so answering the
 * questions again cannot quietly delete work typed directly into the report.
 */
const INTERVIEW_TAG = '__interview__:';

const passKey = (questionId: string, pass: number) =>
  pass <= 1 ? questionId : `${questionId}#${pass}`;

/** "7:30 AM" -> minutes since midnight. Returns null when unparseable. */
function timeToMinutes(raw: string): number | null {
  const m = (raw || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const suffix = (m[3] || '').toUpperCase();
  if (suffix === 'PM' && hour !== 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;
  if (hour > 23 || mins > 59) return null;
  return hour * 60 + mins;
}

/**
 * Hours worked, from the shift the inspector gave.
 *
 * Returns 0 rather than a guess when either time is missing or unreadable — an
 * invented hours figure in a payroll-adjacent document is the one thing this
 * app must never produce. A stop time before the start is read as a shift that
 * ran past midnight.
 */
export function shiftHours(start: string, stop: string, deductLunch: boolean): number {
  const a = timeToMinutes(start);
  const b = timeToMinutes(stop);
  if (a === null || b === null) return 0;
  let span = b - a;
  if (span < 0) span += 24 * 60;
  if (deductLunch) span -= 30;
  if (span <= 0) return 0;
  return Math.round((span / 60) * 100) / 100;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Bullet lines from a spoken answer, so the summary reads like the rest. */
function toBullets(text: string): string[] {
  return (text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[•\-*\s]+/, '').trim())
    .filter(Boolean)
    .map((line) => `• ${line}`);
}

/**
 * Build the activities the interview described.
 *
 * One location = one activity, matching how the report has always been
 * structured — so the Word export, PMWeb sync and timesheet reconciliation all
 * keep reading exactly the data they read now. The interview is a better way to
 * fill the report in; it is not a second, parallel report.
 *
 * MERGE RULES:
 *  - An activity this interview created is rewritten from the current answers.
 *    Correcting an answer corrects the activity instead of adding a second one.
 *  - An activity added by hand in the editor is left completely alone.
 *  - A location removed from the first answer removes its activity, because it
 *    was never worked. Anything typed by hand under it survives, since that
 *    activity is not interview-owned.
 */
export interface ProfileQuestion {
  id: string;
  kind?: string;
  print_label?: string;
}

export interface ProfileSection {
  id: string;
  number?: number;
  title?: string;
  repeats?: boolean;
  repeat_from?: string;
  empty_statement?: string;
  questions: ProfileQuestion[];
}

export function materializeActivities(
  sections: ProfileSection[],
  answers: Record<string, string>,
  rows: Record<string, Record<string, unknown>[]>,
  existing: Activity[],
): Activity[] {
  const repeating = sections.find((s) => s.repeats && s.repeat_from);
  // A format with no repeating section describes ONE day, not several
  // locations — so it becomes one activity carrying everything answered.
  // Returning early here is what left Tecolote with no activity at all.
  if (!repeating) return buildDayActivity(sections, answers, rows, existing);

  const locations = splitList(
    rows[repeating.repeat_from as string],
    answers[repeating.repeat_from as string],
  );

  // Keep everything the interview did not create, in its original order.
  const claimed = new Set(locations.map((l) => l.trim().toLowerCase()));
  const manual = existing.filter((a) => {
    if ((a as unknown as { interview_pass?: number }).interview_pass) return false;
    if (String(a.work_area || '').startsWith(INTERVIEW_TAG)) return false;
    // An activity the interview just rebuilt under the same work area must not
    // also survive here, or the report ends up with the location twice.
    return !claimed.has(String(a.work_area || '').trim().toLowerCase());
  });

  const built: Activity[] = locations.map((location, i) => {
    const pass = i + 1;
    const at = (qid: string) => (answers[passKey(qid, pass)] || '').trim();

    const start = at('start_time');
    const stop = at('stop_time');
    const lunch = at('lunch_deducted').toLowerCase() === 'yes';
    const hours = shiftHours(start, stop, lunch);

    // The summary carries the work, then the things asked about separately, so
    // nothing answered is left sitting only in the interview record.
    const lines = [
      ...toBullets(at('summary')),
      ...(at('traffic_control_detail')
        ? toBullets(`Traffic control: ${at('traffic_control_detail')}`) : []),
      ...toBullets(at('anything_missed')),
    ];

    // Match by pass first, then by work area. The second case is the one that
    // matters on a report that already had activities: naming a location the
    // report already covers must UPDATE that activity, not add a second one
    // for the same place.
    const norm = (v: string) => v.trim().toLowerCase();
    const prior = existing.find(
      (a) => (a as unknown as { interview_pass?: number }).interview_pass === pass,
    ) || existing.find((a) => norm(String(a.work_area || '')) === norm(location));

    // Keep what is already there whenever the interview has no answer for it.
    // The questions fill gaps and add locations; they never blank a field that
    // was filled in some other way - by dictation, Quick Create, or by hand.
    const keep = <T,>(answer: T, existingValue: T, isEmpty: (v: T) => boolean): T =>
      isEmpty(answer) ? existingValue : answer;
    const emptyStr = (v: string) => !v.trim();
    const emptyArr = (v: unknown[]) => v.length === 0;

    return {
      // Keep the original id so photos, ordering and anything else pointing at
      // this activity survive a re-run of the questions.
      id: prior?.id || newId(),
      work_area: location || prior?.work_area || '',
      stations: keep(at('stations'), prior?.stations || '', emptyStr),
      summary: keep(lines.join('\n'), prior?.summary || '', emptyStr),
      manpower: keep((rows[passKey('crew', pass)] || []).map((r) => ({
        id: newId(),
        trade: String(r.trade ?? r.name ?? '').trim(),
        name: String(r.person ?? '').trim(),
        qty: num(r.qty, 1),
        hours,
        start_time: start,
        stop_time: stop,
        company: String(r.company ?? '').trim(),
        classification: String(r.note ?? '').trim(),
        is_3rd_party: false,
        is_extra_work: false,
        is_consultant: false,
        locked: false,
        apply_end_time: true,
      })).filter((r) => r.trade), prior?.manpower || [], emptyArr),
      equipment: keep((rows[passKey('equipment', pass)] || []).map((r) => ({
        id: newId(),
        name: String(r.name ?? r.trade ?? '').trim(),
        description: String(r.note ?? '').trim(),
        qty: num(r.qty, 1),
        hours,
        start_time: start,
        stop_time: stop,
        company: String(r.company ?? '').trim(),
        is_3rd_party: false,
        is_extra_work: false,
        is_consultant: false,
        is_rental: false,
        locked: false,
        apply_end_time: true,
      })).filter((r) => r.name), prior?.equipment || [], emptyArr),
      extra_work_manpower: prior?.extra_work_manpower || [],
      extra_work_equipment: prior?.extra_work_equipment || [],
      consultant_manpower: prior?.consultant_manpower || [],
      interview_pass: pass,
    } as unknown as Activity;
  });

  return [...built, ...manual];
}

/** Shared with the interview UI: rows first, then split text on lines only. */
function splitList(
  rowsForQuestion: Record<string, unknown>[] | undefined,
  value: string | undefined,
): string[] {
  // The TEXT wins when there is any, and the rows are only a fallback.
  //
  // Rows are captured once from a recording; the text is what the inspector can
  // see and edit. Preferring rows meant correcting a location on screen changed
  // nothing - the interview carried on asking about the place that had been
  // typed over, because the stale rows still drove the labels. Since every
  // structured answer now renders its rows back into the text, the two agree
  // after a recording, and disagree only when a human has edited it - in which
  // case the human is right.
  const typed = (value || '').trim();
  if (!typed) {
    return (rowsForQuestion || [])
      .map((r) => String(r.item ?? r.name ?? r.value ?? '').trim())
      .filter(Boolean);
  }
  return (value || '')
    .split(/\r?\n|;/)
    .map((p) => p.replace(/^[-•\d.)\s]+/, '').trim())
    .filter(Boolean);
}

/**
 * One activity carrying the whole day, for a format with no repeating section.
 *
 * Tecolote is eight numbered sections describing a single day's work, not
 * several locations. Its answers still have to land in the report as real
 * activity data — with crew and equipment as rows — so the editor shows it, the
 * resource tables count it, and the export prints it from the same place every
 * other report is printed from.
 *
 * The summary is laid out the way the format reads: each numbered heading, then
 * its lines beneath. A section with nothing gets its plain statement, exactly as
 * the printed report does, so what is on screen and what is in the document say
 * the same thing.
 */
function buildDayActivity(
  sections: ProfileSection[],
  answers: Record<string, string>,
  rows: Record<string, Record<string, unknown>[]>,
  existing: Activity[],
): Activity[] {
  const at = (id: string) => (answers[id] || '').trim();

  const lines: string[] = [];
  for (const section of sections) {
    // Crew and equipment become ROWS, not prose — they belong in the resource
    // tables where they can be counted, not buried in a summary.
    if (section.id === 'labor' || section.id === 'equipment') continue;

    const body: string[] = [];
    for (const q of section.questions) {
      if (q.kind === 'yesno') continue;      // a gate, not content
      const value = at(q.id);
      if (!value) continue;
      const parts = value.split('\n').map((v) => v.trim()).filter(Boolean);
      if (q.print_label) {
        if (parts.length === 1) body.push(`${q.print_label}: ${parts[0]}`);
        else { body.push(`${q.print_label}:`); body.push(...parts.map((v) => `    ${v}`)); }
      } else {
        body.push(...parts);
      }
    }

    const heading = section.number ? `${section.number}. ${section.title}` : section.title;
    lines.push(heading || '');
    lines.push(...(body.length ? body : [section.empty_statement || 'Nothing to report.']));
    lines.push('');
  }

  const summary = lines.join('\n').trim();

  // Nothing was answered — do not replace the report with an empty shell.
  if (!summary && !(rows.crew || []).length && !(rows.equipment || []).length) {
    return existing;
  }

  const start = at('shift_start') || at('start_time');
  const stop = at('shift_end') || at('stop_time');
  const hours = shiftHours(start, stop, false);

  const from = at('excavation_start') || at('pipe_start') || at('backfill_start');
  const to = at('excavation_end') || at('pipe_end') || at('backfill_end');
  const stations = from && to ? `${from} to ${to}` : (from || to || '');

  const prior = existing.find(
    (a) => (a as unknown as { interview_pass?: number }).interview_pass === 1,
  );
  const manual = existing.filter(
    (a) => !(a as unknown as { interview_pass?: number }).interview_pass,
  );

  const dayActivity = {
    // Keep the id so photos and ordering survive answering the questions again.
    id: prior?.id || newId(),
    work_area: at('work_area') || prior?.work_area || 'Daily Progress',
    stations,
    summary,
    manpower: (rows.crew || []).map((r) => ({
      id: newId(),
      trade: String(r.trade ?? r.name ?? '').trim(),
      name: '',
      qty: num(r.qty, 1),
      hours,
      start_time: start,
      stop_time: stop,
      company: String(r.company ?? '').trim(),
      classification: String(r.note ?? '').trim(),
      is_3rd_party: false,
      is_extra_work: false,
      is_consultant: false,
      locked: false,
      apply_end_time: true,
    })).filter((r) => r.trade),
    equipment: (rows.equipment || []).map((r) => ({
      id: newId(),
      name: String(r.name ?? r.trade ?? '').trim(),
      description: String(r.note ?? '').trim(),
      qty: num(r.qty, 1),
      hours,
      start_time: start,
      stop_time: stop,
      company: String(r.company ?? '').trim(),
      is_3rd_party: false,
      is_extra_work: false,
      is_consultant: false,
      is_rental: false,
      locked: false,
      apply_end_time: true,
    })).filter((r) => r.name),
    extra_work_manpower: prior?.extra_work_manpower || [],
    extra_work_equipment: prior?.extra_work_equipment || [],
    consultant_manpower: prior?.consultant_manpower || [],
    interview_pass: 1,
  } as unknown as Activity;

  return [dayActivity, ...manual];
}
