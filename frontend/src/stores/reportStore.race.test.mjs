/**
 * Reproduces the save race that made entered hours disappear.
 *
 * THE BUG (present since the V3 initial deploy, c2e8a16, 2026-05-12):
 * saveReport captured `report` from the store, awaited the network call, then
 * wrote that SNAPSHOT back with `isDirty: false`. Auto-save fires 2s after any
 * change and a round-trip takes hundreds of ms, so anything typed during the
 * request was overwritten by the stale snapshot when the response landed — and
 * marked clean, so it never reached disk either.
 *
 * This models the store's save logic directly rather than booting React, so it
 * runs with plain node and no test framework, matching the backend suites.
 *
 *   node frontend/src/stores/reportStore.race.test.mjs
 */

const results = [];
const check = (name, cond, detail = '') => {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Minimal store with the two save implementations, old and new. */
function makeStore(saveImpl) {
  const state = { report: { id: 'r1', hours: 0 }, isDirty: false, isSaved: true, rescheduled: 0 };
  const get = () => state;
  const set = (patch) => Object.assign(state, patch);

  // Simulates a user edit: immutable replacement, exactly as updateActivity does.
  const edit = (hours) => set({ report: { ...state.report, hours }, isDirty: true });

  const save = () => saveImpl(get, set, () => { state.rescheduled += 1; });
  return { state, edit, save };
}

const network = () => new Promise((r) => setTimeout(r, 40));

// --- The original implementation -------------------------------------------
async function oldSave(get, set) {
  const { report } = get();
  set({ isSaving: true });
  await network();
  set({ report: { ...report, id: 'r1' }, isSaved: true, isDirty: false, isSaving: false });
}

// --- The fixed implementation ----------------------------------------------
async function newSave(get, set, reschedule) {
  const { report } = get();
  const sent = report;
  set({ isSaving: true });
  await network();
  const current = get().report;
  if (!current) { set({ isSaving: false }); return; }
  const changedDuringSave = current !== sent;
  set({
    report: { ...current, id: 'r1' },
    isSaved: true,
    isDirty: changedDuringSave,
    isSaving: false,
  });
  if (changedDuringSave) reschedule();
}

// ── Prove the bug exists in the old implementation ─────────────────────────

{
  const s = makeStore(oldSave);
  s.state.report = { ...s.state.report, hours: 8 };
  const saving = s.save();
  s.edit(10);              // user types 10 while the request is in flight
  await saving;
  check('OLD: mid-save edit is destroyed (the bug)', s.state.report.hours === 8,
        `hours=${s.state.report.hours}, expected the stale 8`);
  check('OLD: and it is marked clean, so it never reaches disk',
        s.state.isDirty === false);
}

// ── The fix ────────────────────────────────────────────────────────────────

{
  const s = makeStore(newSave);
  s.state.report = { ...s.state.report, hours: 8 };
  const saving = s.save();
  s.edit(10);
  await saving;
  check('NEW: mid-save edit survives', s.state.report.hours === 10,
        `hours=${s.state.report.hours}`);
  check('NEW: stays dirty so the edit is persisted', s.state.isDirty === true);
  check('NEW: schedules a follow-up save', s.state.rescheduled === 1,
        String(s.state.rescheduled));
}

// ── No change during save: must settle clean, no pointless re-save ─────────

{
  const s = makeStore(newSave);
  s.state.report = { ...s.state.report, hours: 8 };
  await s.save();
  check('NEW: untouched save marks clean', s.state.isDirty === false);
  check('NEW: untouched save does not reschedule', s.state.rescheduled === 0);
  check('NEW: value preserved', s.state.report.hours === 8);
}

// ── Several edits during one save: the LAST one wins ───────────────────────

{
  const s = makeStore(newSave);
  const saving = s.save();
  s.edit(4);
  s.edit(6);
  s.edit(9);
  await saving;
  check('NEW: last of several mid-save edits wins', s.state.report.hours === 9,
        `hours=${s.state.report.hours}`);
  check('NEW: still dirty after multiple edits', s.state.isDirty === true);
}

// ── Report closed mid-save must not be resurrected ─────────────────────────

{
  const s = makeStore(newSave);
  const saving = s.save();
  s.state.report = null;   // closeReport()
  await saving;
  check('NEW: a closed report is not resurrected', s.state.report === null);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
