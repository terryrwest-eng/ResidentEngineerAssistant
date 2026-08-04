/**
 * Daily Reporter V3 — Activity Gap Detection
 *
 * Finds the details that did not make it into an activity.
 *
 * WHY: the day is captured by talking to the phone at each site, and the thing
 * that goes wrong is forgetting to SAY something — crew size, equipment, how
 * traffic control was set up, when they started, when they finished. Nobody
 * notices until the report is being written up that evening, by which point the
 * answer is a guess.
 *
 * This is deliberately plain checking, not an AI call: if the parsed activity
 * has no manpower rows then crew was never mentioned. That is instant, free,
 * works with no signal, and cannot invent a problem that isn't there.
 */

import type { Activity } from '@/types';

export interface ActivityGap {
  /** Stable key for React and for tests */
  key:
    | 'location'
    | 'summary'
    | 'crew'
    | 'equipment'
    | 'traffic_control'
    | 'start_time'
    | 'end_time'
    | 'hours';
  /** Short label for a chip */
  label: string;
  /** What to actually say to fill it */
  hint: string;
}

/** Words that indicate traffic control was talked about at all. */
const TC_PATTERN = new RegExp(
  [
    'traffic control', '\\btc\\b', 'flagg', 'flagger', '\\bcones?\\b', 'delinea',
    'lane closure', 'closed the lane', 'detour', 'k-rail', 'arrow board',
    'shoulder closure', 'shadow vehicle', 'crash truck', 'signage', 'road plate',
  ].join('|'),
  'i',
);

/** Every manpower row on the activity, across all three manpower tables. */
function allManpower(a: Activity) {
  return [
    ...(a.manpower || []),
    ...(a.extra_work_manpower || []),
    ...(a.consultant_manpower || []),
  ];
}

/** Every equipment row on the activity, across both equipment tables. */
function allEquipment(a: Activity) {
  return [...(a.equipment || []), ...(a.extra_work_equipment || [])];
}

/**
 * Detail the activity is missing, in the order it is most useful to be told.
 *
 * Start and end time are only reported when there ARE rows that lack them —
 * when nothing was said about crew or equipment at all, "no crew" is the useful
 * message and "no start time" is just noise on top of it.
 */
export function findActivityGaps(activity: Activity): ActivityGap[] {
  const gaps: ActivityGap[] = [];

  const manpower = allManpower(activity);
  const equipment = allEquipment(activity);
  const rows = [...manpower, ...equipment];

  if (!activity.work_area?.trim()) {
    gaps.push({
      key: 'location',
      label: 'Location',
      hint: 'Where the work was — the work area for this activity',
    });
  }

  if (!activity.summary?.trim()) {
    gaps.push({
      key: 'summary',
      label: 'Summary',
      hint: 'What work was actually performed',
    });
  }

  if (manpower.length === 0) {
    gaps.push({
      key: 'crew',
      label: 'Crew',
      hint: 'How many people and what trades were on site',
    });
  }

  if (equipment.length === 0) {
    gaps.push({
      key: 'equipment',
      label: 'Equipment',
      hint: 'What equipment was on site, and how many of each',
    });
  }

  if (!TC_PATTERN.test(activity.summary || '')) {
    gaps.push({
      key: 'traffic_control',
      label: 'Traffic control',
      hint: 'Whether there was traffic control, and how it was set up',
    });
  }

  if (rows.length > 0) {
    if (!rows.some(r => r.start_time?.trim())) {
      gaps.push({
        key: 'start_time',
        label: 'Start time',
        hint: 'What time they started',
      });
    }
    if (!rows.some(r => r.stop_time?.trim())) {
      gaps.push({
        key: 'end_time',
        label: 'End time',
        hint: 'What time they finished, if the work is done',
      });
    }
  }

  // Hours counts only rows that have a resource picked — an empty placeholder
  // row waiting to be filled in is not a missing-hours problem.
  const filledManpower = manpower.filter(r => r.trade?.trim());
  if (filledManpower.length > 0 && filledManpower.some(r => !r.hours)) {
    gaps.push({
      key: 'hours',
      label: 'Hours',
      hint: 'How long the crew worked — some rows have no hours',
    });
  }

  return gaps;
}

/**
 * The prompt shown while recording, so the detail gets said in the first place
 * rather than chased afterwards. Same five things findActivityGaps looks for.
 */
export const DICTATION_CHECKLIST: { label: string; hint: string }[] = [
  { label: 'Crew', hint: 'how many, what trades' },
  { label: 'Equipment', hint: 'what was on site' },
  { label: 'Traffic control', hint: 'was there any, how was it set up' },
  { label: 'Start time', hint: 'when they started' },
  { label: 'End time', hint: 'if they finished' },
];
