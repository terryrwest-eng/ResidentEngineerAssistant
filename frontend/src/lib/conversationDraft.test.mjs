/**
 * The conversation is parked on the device, and comes back.
 *
 * THE BUG: the conversation record lived only in React state. Closing the
 * screen at the last question threw away a whole shift of answers, twice, with
 * nothing written anywhere to go back to.
 *
 * This drives the REAL module rather than a model of it: the shipped
 * conversationDraft.ts is transpiled with the TypeScript compiler that is
 * already a dependency here and imported, against a fake localStorage. So what
 * is asserted below is what ships, not a copy of it that can drift.
 *
 * The ONE thing stubbed is getStoredUser, which is four lines of authClient
 * reading the same localStorage - stubbed only because authClient pulls in
 * axios, which will not resolve from a temp directory. The guard under test
 * lives in conversationDraft, not in the stub.
 *
 * No test framework, matching the backend suites and reportStore.race.test.mjs.
 *
 *   node frontend/src/lib/conversationDraft.test.mjs
 */

import ts from 'typescript';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const results = [];
const check = (name, cond, detail = '') => {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── A localStorage that behaves like a browser's ─────────────────────────────
function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const storage = makeStorage();
globalThis.localStorage = storage;

// ── Build the real module ────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'convdraft-'));
const outFile = join(outDir, 'conversationDraft.mjs');

// getStoredUser, as authClient defines it — same key, same tolerance.
writeFileSync(join(outDir, 'authClient.mjs'), `
export function getStoredUser() {
  try {
    const raw = localStorage.getItem('auth_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
`);

const source = readFileSync(join(here, 'conversationDraft.ts'), 'utf8')
  .replace("'@/lib/authClient'", "'./authClient.mjs'");

writeFileSync(outFile, ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
}).outputText);

const {
  CONVERSATION_DRAFT_KEY, loadConversationDraft, saveConversationDraft,
  clearConversationDraft, draftAnswerCount,
} = await import(pathToFileURL(outFile).href);

const USER = { id: 'u-1', name: 'Terry', email: 't@example.com', role: 'user', is_approved: true };
const signIn = (user) => {
  if (user) storage.setItem('auth_user', JSON.stringify(user));
  else storage.removeItem('auth_user');
};

const draft = (overrides = {}) => ({
  reportDate: '2026-09-12',
  profile: 'morena',
  history: [
    { role: 'assistant', text: 'Where did you work today?' },
    { role: 'inspector', text: 'Nobel Drive and Genesee Avenue' },
    { role: 'assistant', text: 'What time did you start?' },
  ],
  record: { slots: [{ key: 'locations', value: 'Nobel Drive' }] },
  askedKeys: ['locations'],
  progress: { total: 20, known: 4, suspect: 0, empty: 16 },
  gaps: [],
  conflicts: [],
  ready: false,
  typed: '',
  ...overrides,
});

// ── 1. The failure this exists to stop ──────────────────────────────────────
signIn(USER);
saveConversationDraft(draft());
const back = loadConversationDraft();
check('a parked conversation comes back', !!back);
check('  the record survives', JSON.stringify(back?.record) === JSON.stringify(draft().record));
check('  the thread survives', back?.history.length === 3);
check('  its own day survives, not today', back?.reportDate === '2026-09-12');
check('  asked keys survive', JSON.stringify(back?.askedKeys) === '["locations"]');
check('  the answer count is what the banner shows', draftAnswerCount(back) === 1);

// ── 2. Nothing said, nothing parked ─────────────────────────────────────────
clearConversationDraft();
saveConversationDraft(draft({ history: [{ role: 'assistant', text: 'Where did you work?' }] }));
check(
  'opening and closing the page leaves no draft',
  loadConversationDraft() === null,
  'a resume banner with nothing behind it is its own bug',
);

// ── 3. A sentence typed but not sent is still work ──────────────────────────
saveConversationDraft(draft({
  history: [{ role: 'assistant', text: 'Where did you work?' }],
  typed: 'Nobel Drive, north of the bridge',
}));
check('a typed but unsent answer is parked', loadConversationDraft()?.typed === 'Nobel Drive, north of the bridge');

// ── 4. A shared device does not hand the conversation over ──────────────────
clearConversationDraft();
saveConversationDraft(draft());
signIn({ ...USER, id: 'u-2' });
check('another user does not get it', loadConversationDraft() === null);
signIn(USER);
check('  and the owner still does', loadConversationDraft() !== null);

// ── 5. Rubbish in storage never becomes state ───────────────────────────────
const junk = [
  ['not json at all', 'not json at all'],
  ['a different version', JSON.stringify({ ...draft(), version: 2, userId: 'u-1' })],
  ['no history', JSON.stringify({ version: 1, userId: 'u-1', history: [] })],
  ['history of the wrong shape', JSON.stringify({ version: 1, userId: 'u-1', history: [{ nope: 1 }] })],
  ['history is not an array', JSON.stringify({ version: 1, userId: 'u-1', history: 'nope' })],
];
let survived = true;
for (const [what, raw] of junk) {
  storage.setItem(CONVERSATION_DRAFT_KEY, raw);
  let got;
  try {
    got = loadConversationDraft();
  } catch (err) {
    survived = false;
    check(`  ${what} threw`, false, String(err));
  }
  if (got !== null) {
    survived = false;
    check(`  ${what} was restored anyway`, false);
  }
}
check('nothing unreadable is restored, and nothing throws', survived);

// ── 6. Missing pieces are filled in, not left undefined ─────────────────────
storage.setItem(CONVERSATION_DRAFT_KEY, JSON.stringify({
  version: 1, userId: 'u-1',
  history: [{ role: 'inspector', text: 'we worked on Nobel' }],
}));
const sparse = loadConversationDraft();
check('a draft missing fields still restores', !!sparse);
check('  progress is a shape the page can render', sparse?.progress.total === 0 && sparse?.progress.known === 0);
check('  gaps and conflicts are arrays', Array.isArray(sparse?.gaps) && Array.isArray(sparse?.conflicts));
check('  the profile falls back', sparse?.profile === 'morena');

// ── 7. Storage that refuses is not a crash ──────────────────────────────────
globalThis.localStorage = {
  getItem() { throw new Error('site data blocked'); },
  setItem() { throw new Error('quota exceeded'); },
  removeItem() { throw new Error('site data blocked'); },
};
let threw = false;
try {
  saveConversationDraft(draft());
  loadConversationDraft();
  clearConversationDraft();
} catch {
  threw = true;
}
check('a browser that refuses storage does not break the conversation', !threw);
globalThis.localStorage = storage;

// ── 8. Written report, released draft ───────────────────────────────────────
clearConversationDraft();
saveConversationDraft(draft());
clearConversationDraft();
check('clearing releases it', loadConversationDraft() === null);

rmSync(outDir, { recursive: true, force: true });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
