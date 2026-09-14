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
 * Two things are stubbed, both only because they drag axios in and axios will
 * not resolve from a temp directory: getStoredUser (four lines of authClient
 * reading the same localStorage) and the conversation API, which here is a
 * recording fake so the server side of the sync can be driven on demand. The
 * logic under test - what is parked, what is restored, and which copy wins -
 * is all conversationDraft's own.
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

// The server, as a fake that records and can be posed.
writeFileSync(join(outDir, 'conversationApi.mjs'), `
export const server = { draft: null, puts: [], deletes: 0, savedAt: null, reachable: true };
export const conversationApi = {
  getDraft: async () => {
    if (!server.reachable) return { status: 'unavailable' };
    return server.draft ? { status: 'found', draft: server.draft } : { status: 'none' };
  },
  putDraft: async (d) => { server.puts.push(d); return server.savedAt; },
  deleteDraft: async () => { server.deletes += 1; },
};
`);

const source = readFileSync(join(here, 'conversationDraft.ts'), 'utf8')
  .replace("'@/lib/authClient'", "'./authClient.mjs'")
  .replaceAll("'@/lib/conversationApi'", "'./conversationApi.mjs'");

writeFileSync(outFile, ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
}).outputText);

const {
  CONVERSATION_DRAFT_KEY, loadConversationDraft, saveConversationDraft,
  clearConversationDraft, parkConversation, releaseConversation, newestConversation,
  checkForNewerConversation,
} = await import(pathToFileURL(outFile).href);

const { server } = await import(pathToFileURL(join(outDir, 'conversationApi.mjs')).href);

/** Let the fake server's promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A draft in the shape the SERVER returns it — snake_case, its own clock. */
const parked = (savedAt, overrides = {}) => ({
  report_date: '2026-09-12',
  profile: 'morena',
  history: [
    { role: 'assistant', text: 'Where did you work today?' },
    { role: 'inspector', text: 'Genesee Avenue, from the bridge north' },
  ],
  record: { slots: [{ key: 'locations', value: 'Genesee Avenue' }] },
  asked_keys: ['locations'],
  progress: { total: 20, known: 6, suspect: 0, empty: 14 },
  gaps: [],
  conflicts: [],
  ready: false,
  typed: '',
  saved_at: savedAt,
  device: 'the-other-phone',
  ...overrides,
});

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
check('  the device it was written on is remembered', typeof back?.device === 'string');

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


// ── 9. It reaches the other device ──────────────────────────────────────────
clearConversationDraft();
server.puts.length = 0;
server.deletes = 0;
server.savedAt = '2026-09-14T18:00:00Z';
parkConversation(draft());
await settle();
check('parking sends it to the server too', server.puts.length === 1);
check('  in the shape the server stores', server.puts[0]?.report_date === '2026-09-12'
  && Array.isArray(server.puts[0]?.asked_keys));
check('  and it is still on the device', loadConversationDraft() !== null);
check(
  "  stamped with the server's clock, not the phone's",
  loadConversationDraft()?.savedAt === '2026-09-14T18:00:00Z',
  'two devices cannot be compared on two clocks',
);

// ── 10. Nothing said, nothing parked anywhere ───────────────────────────────
server.puts.length = 0;
server.deletes = 0;
parkConversation(draft({ history: [{ role: 'assistant', text: 'Where did you work?' }] }));
await settle();
check('an untouched conversation parks nowhere', server.puts.length === 0 && server.deletes === 1);

// ── 11. Whichever was written last is the one you get ───────────────────────
server.savedAt = null;
clearConversationDraft();
storage.setItem(CONVERSATION_DRAFT_KEY, JSON.stringify({
  ...draft(), version: 1, userId: 'u-1', savedAt: '2026-09-14T12:00:00Z', device: 'this-one',
}));
const mine = loadConversationDraft();

server.draft = parked('2026-09-14T15:00:00Z');
let picked = await newestConversation(mine);
check('a newer conversation on the server wins', picked.draft?.record?.slots[0].value === 'Genesee Avenue');
check('  and is flagged as carried over', picked.carriedOver === true);

server.draft = parked('2026-09-14T09:00:00Z');
picked = await newestConversation(mine);
check('an older one on the server does not', picked.draft?.savedAt === '2026-09-14T12:00:00Z');
check('  and is not flagged', picked.carriedOver === false);

server.draft = parked('2026-09-14T12:00:00Z');
picked = await newestConversation(mine);
check(
  'the same conversation seen twice keeps the device copy',
  picked.draft?.savedAt === '2026-09-14T12:00:00Z',
  'the device copy may carry a sentence typed since',
);

// ── 12. Either side alone still works ───────────────────────────────────────
server.draft = parked('2026-09-14T15:00:00Z');
picked = await newestConversation(null);
check('nothing on the device, something on the server', picked.draft !== null && picked.carriedOver === true);

server.draft = null;
picked = await newestConversation(mine);
check('nothing on the server, something on the device', picked.draft?.savedAt === '2026-09-14T12:00:00Z');

picked = await newestConversation(null);
check('nothing anywhere is nothing, not a crash', picked.draft === null);

server.draft = parked('2026-09-14T15:00:00Z', { history: [] });
picked = await newestConversation(null);
check('a server draft with no thread is not restored', picked.draft === null);

// ── 13. Releasing releases both ─────────────────────────────────────────────
server.deletes = 0;
saveConversationDraft(draft());
releaseConversation();
await settle();
check('releasing clears the device', loadConversationDraft() === null);
check('  and the server', server.deletes === 1);


// ── 14. The phone left running catches up with the laptop ──────────────────
//
// This is the workflow the whole thing is for: answer on the phone, carry on
// at the laptop, shut the laptop, pick the phone back up. The phone was never
// closed, so anything that only runs on mount never runs at all.
server.reachable = true;
server.draft = parked('2026-09-14T15:00:00Z');

let update = await checkForNewerConversation('2026-09-14T12:00:00Z');
check('a phone that has fallen behind is told so', update.status === 'newer');
check('  and is handed the newer conversation', update.draft?.reportDate === '2026-09-12');

update = await checkForNewerConversation('2026-09-14T15:00:00Z');
check('its own last write is not an update', update.status === 'unchanged');

update = await checkForNewerConversation('2026-09-14T18:00:00Z');
check('an older copy on the server is not an update', update.status === 'unchanged');

// ── 15. A dead spot is not the end of the conversation ─────────────────────
server.reachable = false;
update = await checkForNewerConversation('2026-09-14T12:00:00Z');
check(
  'a lookup that could not run changes nothing',
  update.status === 'unavailable',
  'treating this as "gone" would wipe the screen every time the signal dipped',
);
server.reachable = true;

// ── 16. Written up on the other device ─────────────────────────────────────
server.draft = null;
update = await checkForNewerConversation('2026-09-14T12:00:00Z');
check('a released draft reads as gone', update.status === 'gone');

update = await checkForNewerConversation('');
check(
  'but a device that never parked anything is not told it is gone',
  update.status === 'unchanged',
  'otherwise a fresh conversation would announce its own death',
);

// ── 17. Parking hands back the stamp to compare against ────────────────────
clearConversationDraft();
server.puts.length = 0;
server.savedAt = '2026-09-14T20:00:00Z';
const stamp = await parkConversation(draft());
check('parking reports the stamp the server gave it', stamp === '2026-09-14T20:00:00Z');

server.draft = parked('2026-09-14T20:00:00Z');
update = await checkForNewerConversation(stamp);
check('  which then reads as unchanged, not as an update', update.status === 'unchanged');

rmSync(outDir, { recursive: true, force: true });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
