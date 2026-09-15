/**
 * The summary cleaner keeps the shift-time lines as the labelled lines they are,
 * and a second dictation into the same activity keeps them at the top, once.
 *
 * THE BUG: cleanSummaryBullets put "• " in front of every line. It runs when an
 * activity is added (Dictate All), when the interview's activities replace the
 * old ones, and on EVERY report load - so the "Start Time: 6:30 AM" lines the
 * backend placed without a bullet came back as "• Start Time: 6:30 AM" the
 * first time the report was opened, on every path that writes them.
 *
 * AND: the Dictate button appended each new recording to the summary, so
 * dictating twice into one activity buried the second "Start Time:" mid-way
 * down, or printed the times twice. mergeDictatedSummary is what the editor
 * now uses instead.
 *
 * Drives the REAL formatters.ts, transpiled with the TypeScript compiler that is
 * already a dependency here. It has no imports, so nothing is stubbed.
 *
 * No test framework, matching the backend suites and conversationDraft.test.mjs.
 *
 *   node frontend/src/lib/formatters.test.mjs
 */

import ts from 'typescript';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const results = [];
const check = (name, cond, detail = '') => {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'formatters-'));
const outFile = join(outDir, 'formatters.mjs');

const source = readFileSync(join(here, 'formatters.ts'), 'utf8');
writeFileSync(outFile, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);

const { cleanSummaryBullets: clean, mergeDictatedSummary: merge } = await import(pathToFileURL(outFile).href);

const same = (name, input, expected, why = '') => {
  const got = clean(input);
  check(name, got === expected, why || JSON.stringify(got));
};

// ── The bug ──────────────────────────────────────────────────────────────────
const placed = [
  'Start Time: 6:30 AM',
  'End Time: 3:00 PM',
  '• Traffic control was set in the southbound #1 lane.',
  '• The crew grouted all joints.',
  '• Traffic control was picked up at 3:00 PM.',
].join('\n');

same('the time lines the backend placed come through with no bullet', placed, placed);

check(
  'opening the report again does not change them (it runs on every load)',
  clean(clean(clean(placed))) === placed,
);

// ── One shape, whatever arrived ──────────────────────────────────────────────
same('a dash becomes a colon, and the body is still bulleted',
  'Start Time - 6:30 AM\nTraffic control was set.',
  'Start Time: 6:30 AM\n• Traffic control was set.');

same('a bullet in front of a time line is taken off',
  '• Start Time: 6:30 AM\n• End Time - 3:00 PM',
  'Start Time: 6:30 AM\nEnd Time: 3:00 PM');

same('Stop and Finish both mean End',
  'Stop Time: 3:00 PM\nFinish Time - 4:00 PM',
  'End Time: 3:00 PM\nEnd Time: 4:00 PM');

same('an en dash and any case',
  'START TIME – 6:30 am',
  'Start Time: 6:30 am');

same('no separator but a time straight after is still a label',
  'Start Time 6:30 AM',
  'Start Time: 6:30 AM');

same('a time line inside an HTML list comes out unbulleted too',
  '<ul><li>Start Time: 6:30 AM</li><li>Crew arrived</li></ul>',
  'Start Time: 6:30 AM\n• Crew arrived');

// ── What must NOT happen ─────────────────────────────────────────────────────
same('a label with nothing after it is dropped, not printed',
  'Start Time:\n• The crew grouted all joints.',
  '• The crew grouted all joints.',
  'an empty label reads as a fact lost between the field and the page');

same('a bare label with nothing at all is dropped too',
  'End Time\n• The crew grouted all joints.',
  '• The crew grouted all joints.');

same('a sentence that STARTS with the words stays a bulleted sentence',
  'Start time was pushed to 8 because of the rain.',
  '• Start time was pushed to 8 because of the rain.',
  'neither a separator nor a time follows "time", so it is not a label');

same('a sentence that merely mentions the words is untouched',
  'The start time was agreed with OHLA the night before.',
  '• The start time was agreed with OHLA the night before.');

// ── Everything it already did, still done ────────────────────────────────────
same('a numbered section heading is kept as a heading',
  '1. Work Summary & Pipe Installation\n- Laid pipe\nplain line',
  '1. Work Summary & Pipe Installation\n• Laid pipe\n• plain line');

check('nothing in, nothing out', clean('') === '' && clean(null) === '' && clean(undefined) === '');

// ── Dictating into the same activity more than once ──────────────────────────
const morning = [
  'Start Time: 6:30 AM',
  'End Time: 3:00 PM',
  '• Traffic control was set in the southbound #1 lane.',
  '• The crew grouted all joints.',
].join('\n');

check('the first dictation into an empty activity is taken as it came',
  merge('', morning) === morning);

let got = merge(morning, '• The crew backfilled to Sta 12+50.\n• Traffic control was picked up at 3:00 PM.');
check('a second dictation with no times keeps the times at the top and adds to the end',
  got === `${morning}\n• The crew backfilled to Sta 12+50.\n• Traffic control was picked up at 3:00 PM.`,
  JSON.stringify(got));

got = merge(morning, 'Start Time: 7:00 AM\n• The crew arrived late.');
check('a time in the new dictation is a correction, and wins',
  got.startsWith('Start Time: 7:00 AM\nEnd Time: 3:00 PM\n'), JSON.stringify(got));
check('  the times are never printed twice',
  got.split('Start Time').length === 2 && got.split('End Time').length === 2, JSON.stringify(got));
check('  nothing already written is lost, and the new words go last',
  got.includes('• The crew grouted all joints.') && got.endsWith('• The crew arrived late.'),
  JSON.stringify(got));

got = merge('• Traffic control was set.', 'Start Time: 6:30 AM\nEnd Time: 3:00 PM\n• The crew grouted all joints.');
check('times that arrive with a later dictation are lifted above what was already written',
  got === 'Start Time: 6:30 AM\nEnd Time: 3:00 PM\n• Traffic control was set.\n• The crew grouted all joints.',
  JSON.stringify(got));

check('with no times on either side it is exactly the old append',
  merge('• First.', '• Second.') === '• First.\n• Second.');

check('an empty new dictation changes nothing', merge(morning, '') === morning);

const merged = merge(morning, 'Start Time: 7:00 AM\n• The crew arrived late.');
check('a merged summary survives being reopened unchanged', clean(merged) === merged, JSON.stringify(clean(merged)));

rmSync(outDir, { recursive: true, force: true });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
