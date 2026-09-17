/**
 * The phone list's one-line-per-row wording, and the section totals.
 *
 * Drives the REAL resourceSummary.ts and the real formatters.ts it uses, both
 * transpiled with the TypeScript compiler already in the tree. Nothing stubbed.
 *
 *   node frontend/src/lib/resourceSummary.test.mjs
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
const outDir = mkdtempSync(join(tmpdir(), 'resource-summary-'));
const transpile = (file, rewrite = (s) => s) => ts.transpileModule(
  rewrite(readFileSync(join(here, file), 'utf8')),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;

writeFileSync(join(outDir, 'formatters.mjs'), transpile('formatters.ts'));
writeFileSync(join(outDir, 'resourceSummary.mjs'), transpile(
  'resourceSummary.ts',
  (s) => s.replace("'@/lib/formatters'", "'./formatters.mjs'"),
));

const { resourceLine, resourceTotals, hasContent } = await import(
  pathToFileURL(join(outDir, 'resourceSummary.mjs')).href
);

const DOT = ' · ';

// ── A crew row reads as one line ─────────────────────────────────────────────
const crew = {
  id: 'a', trade: 'LL-03- Laborers', name: '', qty: 4, hours: 8,
  start_time: '7:00 AM', stop_time: '3:30 PM', company: 'OHL NA',
  is_extra_work: false, is_3rd_party: false, is_consultant: false, locked: false,
};
let line = resourceLine(crew, 'manpower');
check('the resource is the title', line.title === 'LL-03- Laborers', JSON.stringify(line));
check('quantity, hours, company and times read on one line',
  line.detail === `×4${DOT}8 hrs${DOT}OHL NA${DOT}7:00 AM–3:30 PM`, JSON.stringify(line.detail));
check('no flags means no chips', line.flags.length === 0);

// ── A named person ───────────────────────────────────────────────────────────
line = resourceLine({ ...crew, trade: 'LL-02- Foreman', name: 'Lopez, Salvador', qty: 1, hours: 10.5 }, 'manpower');
check('a person\'s name is the subtitle', line.subtitle === 'Lopez, Salvador');
check('half hours are kept', line.detail.includes('10.5 hrs'), line.detail);

// ── Equipment with its flags ─────────────────────────────────────────────────
line = resourceLine({
  id: 'b', name: 'LE-07- Paver', description: 'P-12', qty: 1, hours: 6,
  start_time: '', stop_time: '', company: 'Herc',
  is_extra_work: true, is_3rd_party: false, is_consultant: false, is_rental: true, locked: true,
}, 'equipment');
check('equipment title is the machine, subtitle the unit number',
  line.title === 'LE-07- Paver' && line.subtitle === 'P-12', JSON.stringify(line));
check('flags read in plain words',
  JSON.stringify(line.flags) === JSON.stringify(['Extra work', 'Rental', 'Locked']), JSON.stringify(line.flags));
check('missing times leave no dangling dash', line.detail === `×1${DOT}6 hrs${DOT}Herc`, line.detail);

// ── One time only ────────────────────────────────────────────────────────────
check('a start with no stop reads "from"',
  resourceLine({ ...crew, stop_time: '' }, 'manpower').detail.endsWith('from 7:00 AM'));
check('a stop with no start reads "until"',
  resourceLine({ ...crew, start_time: '' }, 'manpower').detail.endsWith('until 3:30 PM'));

// ── A row just added ─────────────────────────────────────────────────────────
const fresh = {
  id: 'c', trade: '', name: '', qty: 0, hours: 0,
  start_time: '7:00 AM', stop_time: '3:30 PM', company: 'OHL NA',
};
check('a row just added has no title yet', resourceLine(fresh, 'manpower').title === '');
check('and counts as empty, so removing it needs no "are you sure"', hasContent(fresh, 'manpower') === false,
  'its default times and company do not count');
check('a row with a resource picked does need confirming', hasContent(crew, 'manpower') === true);
check('so does a row with only a quantity', hasContent({ ...fresh, qty: 2 }, 'manpower') === true);

// ── Totals ───────────────────────────────────────────────────────────────────
const crewRows = [
  crew,
  { ...crew, id: 'd', trade: 'LL-02- Foreman', qty: 1, hours: 10 },
  { ...crew, id: 'e', trade: 'LL-05- Operator', qty: 2, hours: 8 },
];
check('crew totals count people and person-hours',
  resourceTotals(crewRows, 'manpower') === `3 rows${DOT}7 people${DOT}58 hrs`,
  resourceTotals(crewRows, 'manpower'));

check('one person reads "person", not "people"',
  resourceTotals([{ ...crew, qty: 1 }], 'manpower') === `1 row${DOT}1 person${DOT}8 hrs`,
  resourceTotals([{ ...crew, qty: 1 }], 'manpower'));

check('equipment totals count units',
  resourceTotals([{ id: 'f', name: 'LE-07- Paver', qty: 3, hours: 4 }], 'equipment') === `1 row${DOT}3 units${DOT}12 hrs`,
  resourceTotals([{ id: 'f', name: 'LE-07- Paver', qty: 3, hours: 4 }], 'equipment'));

check('a row with hours but no quantity still has its hours counted',
  resourceTotals([{ ...crew, qty: 0, hours: 8 }], 'manpower').endsWith('8 hrs'),
  resourceTotals([{ ...crew, qty: 0, hours: 8 }], 'manpower'));

check('no rows, no totals line', resourceTotals([], 'manpower') === '');

rmSync(outDir, { recursive: true, force: true });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
