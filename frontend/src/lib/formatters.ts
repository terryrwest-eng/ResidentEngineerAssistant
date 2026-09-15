/**
 * Daily Reporter V3 — Summary & Text Formatters
 *
 * Provides utilities for sanitizing AI output and activity summary text
 * to ensure consistent, clean bullet points without HTML tags.
 */

/**
 * Returns today's date as YYYY-MM-DD in the LOCAL timezone.
 *
 * WHY NOT toISOString(): that converts to UTC first, so anywhere west of
 * Greenwich (e.g. Pacific) it rolls over to tomorrow's date in the late
 * afternoon — new reports were being dated a day ahead after ~5 PM.
 */
export function localDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a quantity with thousands separators and a unit: "1,210 SF", "90.75 T".
 *
 * WHY: quantities were being printed with bare `String(n)`, so a five-figure
 * square-footage arrived as "12100" — a number you have to stop and count the
 * digits of. Thousands separators are the difference between reading a figure
 * and parsing it.
 *
 * Trailing zeros are dropped (8.0 -> "8") because whole hours are the common
 * case and "8.00 HRS" reads like a precision that is not there.
 */
export function formatQty(
  value: number | string | null | undefined,
  unit = '',
  maxDecimals = 2,
): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (n === null || n === undefined || Number.isNaN(n)) return unit ? `0 ${unit}` : '0';
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

/** Hours, as they appear on a report: "8 HRS", "10.5 HRS". */
export function formatHours(value: number | string | null | undefined): string {
  return formatQty(value, 'HRS');
}

/**
 * A date as a person reads it: "Mon, Jul 27, 2026".
 * Parses at noon so a YYYY-MM-DD string never shifts a day across timezones.
 */
export function formatReportDate(date: string | null | undefined): string {
  if (!date) return '';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

/**
 * A shift-time LABEL line: Start / End / Stop / Finish, then "time", then either
 * a separator or a time. "Stop" and "Finish" both mean End.
 *
 * KEPT IN STEP WITH _TIME_LINE in backend/app/services/summary_format.py, which
 * places "Start Time: 6:30 AM" / "End Time: 3:00 PM" at the top of every
 * location's write-up. If the two ever disagree about what a time line is, this
 * cleaner puts a bullet back in front of lines the backend placed without one.
 *
 * The separator-or-digit requirement keeps an ordinary sentence out: "Start time
 * was pushed to 8 because of the rain" has neither straight after "time", so it
 * stays a bulleted sentence. A bare "Start Time" still matches, so it is dropped.
 */
const TIME_LINE = /^[\s>*•–—-]*(start|end|stop|finish)\s*time\s*(?:[:–—-]\s*(.*?)|(\d.*?))?\s*$/i;

/**
 * Clean summary text to ensure plain-text bullet points starting with '• '
 * and remove raw HTML tags like <ul>, <li>, <p>, etc.
 *
 * EXCEPT the shift-time lines, which stay unbulleted, in the one shape. This
 * runs when an activity is added, when the interview replaces the activities,
 * and on EVERY report load - so without the exception, the labelled time lines
 * came back as "• Start Time: 6:30 AM" the first time a report was opened, on
 * every path that writes them.
 */
export function cleanSummaryBullets(text: string | null | undefined): string {
  if (!text) return '';
  let t = String(text).trim();
  if (!t) return '';

  // If text contains HTML tags like <li>, <br>, <p>, <ul>
  if (/<[a-z][\s\S]*>/i.test(t)) {
    // Convert <li> tags to newlines with bullet character
    t = t.replace(/<li[^>]*>/gi, '\n• ');
    // Convert block-closing tags and <br> to newlines
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(?:p|div|li|tr|ul|ol)>/gi, '\n');
    // Remove all remaining HTML tags
    t = t.replace(/<[^>]+>/g, '');
    // Decode common HTML entities
    t = t
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"');
  }

  // Split lines, clean up whitespace, and ensure bullet points
  const rawLines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const cleanedLines: string[] = [];

  for (const line of rawLines) {
    // The shift times are labelled lines, not list items. Kept unbulleted and
    // put in the one shape; a label with nothing after it is not a fact, so it
    // is dropped rather than printed.
    const time = TIME_LINE.exec(line);
    if (time) {
      const value = (time[2] ?? time[3] ?? '').trim();
      if (value) {
        const label = time[1].toLowerCase() === 'start' ? 'Start Time' : 'End Time';
        cleanedLines.push(`${label}: ${value}`);
      }
      continue;
    }

    // "1. Work Summary & Pipe Installation" is a section heading, not a list
    // item. The old strip pattern was a character class matching ONE character,
    // so it removed the digit and left the dot — printing as ". Work Summary" —
    // and then bulleted it.
    if (/^\d+\.\s+\S/.test(line)) {
      cleanedLines.push(line);
      continue;
    }

    // Strip leading bullet chars/symbols/numbers if present
    // Same four characters as before (bullet, star, en dash, hyphen), without the
    // escapes lint rejects - the hyphen goes last so it cannot read as a range.
    const content = line.replace(/^[•*–-]\s*/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (content) {
      cleanedLines.push(`• ${content}`);
    }
  }

  return cleanedLines.join('\n');
}

/** A summary taken apart into its shift times and everything else. */
interface ShiftSplit {
  start: string;
  end: string;
  body: string[];
  hadTimeLines: boolean;
}

function splitShiftTimes(text: string): ShiftSplit {
  const body: string[] = [];
  let start = '';
  let end = '';
  let hadTimeLines = false;

  for (const line of text.split('\n')) {
    const time = TIME_LINE.exec(line.trim());
    if (!time) {
      if (line.trim()) body.push(line);
      continue;
    }
    hadTimeLines = true;
    const value = (time[2] ?? time[3] ?? '').trim();
    if (!value) continue;
    if (time[1].toLowerCase() === 'start') start = start || value;
    else end = end || value;
  }

  return { start, end, body, hadTimeLines };
}

/**
 * Add a new dictation to what an activity already says.
 *
 * WHY NOT JUST APPEND: the Dictate button can be pressed more than once on the
 * same activity - the morning, then the afternoon. Appending put the second
 * recording's "Start Time:" line in the middle of the write-up, or printed the
 * times twice. The times belong at the top, once.
 *
 * A time in the NEW dictation wins - saying "we actually started at 7" is a
 * correction. A time it does not mention keeps whatever was already there.
 * Everything else keeps its order: what was already written, then what was
 * just said. With no time lines on either side this is exactly the old append.
 */
export function mergeDictatedSummary(current: string, incoming: string): string {
  if (!incoming) return current || '';
  if (!current) return incoming;

  const cur = splitShiftTimes(current);
  const inc = splitShiftTimes(incoming);
  if (!cur.hadTimeLines && !inc.hadTimeLines) return `${current}\n${incoming}`;

  const start = inc.start || cur.start;
  const end = inc.end || cur.end;
  const head = [
    ...(start ? [`Start Time: ${start}`] : []),
    ...(end ? [`End Time: ${end}`] : []),
  ];
  return [...head, ...cur.body, ...inc.body].join('\n');
}
