# Improvement Plan — Resident Engineer Assistant (Execution Spec)

_Compiled 2026-07-26 from a full review of backend, frontend, Chrome extension, export pipeline, and real sample documents. Line numbers are valid as of commit `df7f8ce`; every task also includes a searchable anchor string in case lines drift._

## Priorities (from Terry)

- Primary daily workflow is **Dictate All** → generate → manually fix. Most time-saving path, but sometimes a long dictation produces a **completely fabricated** report ("didn't hear me and made it up").
- **Makeup reports**: batch-create reports for missed days from handwritten contractor timesheets (some handwriting is hard to read) + subcontractor emails saved as PDFs.
- Dispatch / DO schedule / paving schedule = minor features, used briefly per project. Low priority.
- Equipment under `LR - Labor Regular Time` is intentional (no OT for equipment). Not a bug.

---

# PHASE 1 — Critical bug fixes (do first, everything else builds on these)

### Task 1.1 — Fix `/api/ai/parse-report` (it has never worked)

**File:** `backend/app/routers/ai.py`
**Anchor:** `from app.services.reports import create_report` (line 2258)

The endpoint imports `create_report` from `app/services/reports.py`, which does **not** exist (that module only has `get_report`, `save_report`, `list_reports`, `delete_report`, `get_report_count`). Every successful Gemini parse ends in `ImportError` → HTTP 500.

Steps:
1. At line 2258 change the import to `from app.services.reports import save_report`.
2. Where the report dict is assembled (before line 2286), add:
   - `report_data["id"] = str(uuid.uuid4())` (import `uuid` at top if missing).
   - For every activity in `report_data["activities"]`: assign `act["id"] = str(uuid.uuid4())` and for every row in `manpower`/`equipment`/`extra_work_manpower`/`extra_work_equipment`/`consultant_manpower`: assign `row["id"] = str(uuid.uuid4())`. (Without IDs, report-chat's surgical merge can't address them.)
   - Rename `summary_html` → `summary` on each activity: `act["summary"] = act.pop("summary_html", act.get("summary", ""))`. (Word exporter reads `act.get("summary")` — see Task 1.2.)
3. At line 2286 change `saved = await create_report(report_data)` → `saved = await save_report(report_data)` and return `report_data["id"]` in the response.
4. **Verify:** upload any completed .docx/.pdf report via the Import button (ActivityList header) → a new draft appears in History → open it → summaries visible → Export Word shows summaries.

### Task 1.2 — Unify `summary` vs `summary_html` at the boundaries

**Files:** `backend/app/services/word.py` (lines 265, 480 — anchor `act.get("summary", "")`), `backend/app/routers/reports.py` (create at ~line 29, update at ~line 89)

AI endpoints emit `summary_html`; the model, Word export, and notes HTML read `summary`. The frontend papers over this inconsistently.

Steps:
1. In `routers/reports.py`, add a normalizer called in **both** `create_report` and `update_report` after `request.json()`:
   ```python
   def _normalize_activities(report_dict):
       for act in report_dict.get("activities", []):
           if not act.get("summary") and act.get("summary_html"):
               act["summary"] = act.pop("summary_html")
   ```
2. In `word.py` lines 265 and 480, change to `act.get("summary") or act.get("summary_html", "")` as a belt-and-suspenders fallback.
3. **Verify:** dictate a report, save, export Word → bullets present.

### Task 1.3 — Historical weather: archive-gap crash + fallback

**File:** `backend/app/routers/weather.py`
**Anchor:** `daily.get("weather_code", [0])[0]` (line 120)

Open-Meteo's archive API lags ~5 days behind; for recent past dates `daily` arrays come back empty → `IndexError` → error masked as HTTP 200. Backfill (Phase 5) depends on this working.

Steps:
1. Guard every `[0]` access on the archive path (lines ~120-141): if `daily` is missing/empty, **retry via the forecast API with `past_days=7`** (Open-Meteo forecast endpoint accepts `past_days` up to 92 — covers the archive gap).
2. Apply the same guard on the forecast path (lines ~200+).
3. **Verify:** `GET /api/weather?lat=32.8&lon=-117.2&date=<yesterday>` and `date=<10 days ago>` both return data.

### Task 1.4 — Data-directory split (silent data loss on Railway)

**Files:** `backend/app/routers/schedule.py` (~line 40), `backend/app/routers/pdf_search.py` (~line 34), `backend/app/routers/dispatches.py` (lines 36-48)
**Anchor:** `os.path.dirname(os.path.dirname(os.path.dirname(__file__)))`

`main.py:26` honors `DAILY_REPORTER_DATA_DIR` (the Railway volume), but these three routers re-derive `data/` from `__file__` — schedules/specs/dispatches land on ephemeral container disk and vanish on redeploy.

Steps:
1. Create `backend/app/core/paths.py`:
   ```python
   import os
   DATA_DIR = os.environ.get("DAILY_REPORTER_DATA_DIR") or os.path.join(
       os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data")
   ```
2. In `main.py`, replace the inline resolution (lines 26-28) with `from app.core.paths import DATA_DIR`.
3. In the three routers, replace their local `_BASE_DIR`/path logic with `from app.core.paths import DATA_DIR` and build subdirs from it. Also `dispatches.py:48` `_SETTINGS_PATH` and any settings-path duplicates found by `grep -rn "settings.json" backend/app`.
4. **Verify:** `grep -rn "dirname(__file__)" backend/app/routers/` returns nothing path-building; set `DAILY_REPORTER_DATA_DIR=/tmp/x` and confirm schedule upload writes under it.

### Task 1.5 — New reports get the UTC date, not local

**File:** `frontend/src/stores/reportStore.ts`
**Anchor:** `report_date: new Date().toISOString().split('T')[0]` (line 24)

After ~4-5 PM Pacific this yields tomorrow's date.

Steps:
1. Add a helper and use it at line 24:
   ```ts
   const localDate = () => { const d = new Date();
     return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
   ```
2. `grep -rn "toISOString().split" frontend/src` and fix any other *date* (not timestamp) uses the same way.
3. **Verify:** system clock ≥ 5 PM PDT → New Report shows today.

### Task 1.6 — Route-order bug: `GET /api/schedule/list` unreachable

**File:** `backend/app/routers/schedule.py` — `@router.get("/{schedule_id}")` is declared at line 488, `@router.get("/list")` at line 517. FastAPI matches in declaration order, so `/list` returns `404 "Schedule 'list' not found"`.
**Fix:** move the `/list` route (whole function) above the `/{schedule_id}` route. **Verify:** `GET /api/schedule/list` returns JSON.

> Note: an earlier review draft claimed `reports.py:172/215` were missing `await` on `get_report`. **False alarm** — that router imports the *sync* `get_report` from `app.services.database`. No change needed there.

---

# PHASE 2 — Dictation anti-hallucination (the "made-up report" fix)

The failure chain: (a) recording silently degrades or an unsupported codec is used → (b) Pass 1 transcription fails/truncates with no retry and only an "empty string" guard → (c) Pass 2 (JSON mode, default temperature) fabricates plausible content from garbage. Fix all three layers and put the transcript in front of the user before anything is built.

### Task 2.1 — Split bulk dictate into two endpoints (transcribe / parse)

**File:** `backend/app/routers/ai.py`, current endpoint `/bulk-dictate-activities` (lines 1852-2018)

Steps:
1. New endpoint `POST /api/ai/bulk-transcribe` — Pass 1 only (reuse lines 1867-1932 logic):
   - Request: `{ audio_data, mime_type, duration_seconds }` (add `duration_seconds: float = 0` to the request model — anchor `class BulkDictateRequest`).
   - Wrap the Gemini call in `_gemini_call_with_retry` (line 34 — currently NOT used here).
   - Config: raise `max_output_tokens` 16384 → 32768; add `thinking_config` with a modest budget (e.g. 2048 — transcription needs hearing, not reasoning).
   - **Sanity gate** after transcription: if `duration_seconds >= 30` and `len(raw_transcription) < duration_seconds * 3` (a slow speaker produces ≥ ~3 chars/sec), return `{ status: "failed", reason: "transcription_too_short", transcription: raw_transcription }`. Never proceed silently.
   - Check `pass1_response.candidates[0].finish_reason`; on `MAX_TOKENS`/safety block return `status: "failed"` with the reason instead of `.text` crashing.
   - Response: `{ status: "ok" | "failed", transcription, reason? }`.
2. New endpoint `POST /api/ai/bulk-parse` — Pass 2 only (reuse lines 1937-2005 logic):
   - Request: `{ transcription: str, current_activities?: list }` (`current_activities` used in Phase 4 delta mode; ignore for now).
   - Config: `temperature=0`, keep JSON mime type, **add `response_schema`** (build `genai_types.Schema` matching the current prompt's shape: activities[], locations, general_notes). This eliminates the `summary`/`summary_html` remap at lines 1997-1999 — schema names the field `summary_html` explicitly.
   - Wrap in `_gemini_call_with_retry`.
3. Keep the old `/bulk-dictate-activities` as a thin wrapper calling both (backward compat for the Android APK until it's rebuilt).
4. **Verify:** POST a real recording to `/bulk-transcribe` → readable transcript; feed it to `/bulk-parse` → same JSON shape as before; POST 5 s of silence with `duration_seconds=300` → `status: "failed"`.

### Task 2.2 — Frontend: recording hardening + "here's what I heard" step

**File:** `frontend/src/components/report/BulkDictateButton.tsx` (647 lines)

Current state: `startRecording` (lines 72-119) already uses `recorder.start(250)` timeslice and persists the blob — good. Missing: codec negotiation, an `onerror` handler, a live audio-level indicator, and any user-visible transcript before activities are built.

Steps:
1. **Codec negotiation** (line 77, anchor `new MediaRecorder(stream, { mimeType: 'audio/webm' })`): iOS Safari doesn't support `audio/webm` → the constructor throws → user sees the *misleading* "Microphone access denied" from the bare `catch` (line 116). Replace with:
   ```ts
   const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
   const mimeType = candidates.find(c => MediaRecorder.isTypeSupported(c)) ?? '';
   const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
   ```
   Track the chosen type in a ref; use it for the Blob type (line 86) and send it to the API (line 138 currently hardcodes `'audio/webm'`).
2. **`recorder.onerror` handler** (after line 80): set an error state and stop — today a mid-recording error silently produces a short blob.
3. **Live level meter** (inside `startRecording`): `AudioContext` + `AnalyserNode` on the stream; render a simple bar in the recording UI. A dead mic becomes visible *while talking*, not after 5 wasted minutes.
4. **Split `processRecording`** (lines 127-160): step 1 calls `scanApi.bulkTranscribe(base64, mimeType, recordingDuration)` → new phase `'transcript'` renders the transcription in a scrollable, **editable** `<textarea>` with buttons **"Looks right — build activities"** (→ `scanApi.bulkParse(editedText)` → existing results phase) and **"Re-record"**. On `status: "failed"` show the reason + Retry (blob is already persisted). Editable text means a misheard name can be fixed *before* parsing — cheaper than fixing five table rows after.
5. Add `bulkTranscribe` / `bulkParse` to `scanApi` in `frontend/src/lib/api.ts` (next to `bulkDictate`, anchor `bulkDictate`).
6. **Verify:** normal dictation round-trips; muted-mic recording shows level meter flat + failed status; edited transcript is what gets parsed.

### Task 2.3 — Same hardening for the other audio endpoints

**File:** `backend/app/routers/ai.py` — `/transcribe` (lines 629-763), `/transcribe-smart` (892-1022), `/report-chat` audio path (~1409-1455).

Steps: extract a shared helper `async def _transcribe_audio(client, model, audio_bytes, mime_type, duration_seconds, context_note) -> tuple[str, bool]` implementing retry + finish_reason check + the sanity gate, and call it from all three (plus `/bulk-transcribe`). Set `temperature=0` on every Pass-2/JSON call in these endpoints. **Verify:** each endpoint still round-trips; silence → clean error, not fabrication.

---

# PHASE 3 — Project context pack (fewer wrong names → fewer manual fixes)

### Task 3.1 — Settings storage

**File:** `backend/app/routers/settings.py` (DEFAULT_SETTINGS dict — anchor `"resource_aliases": {"equipment": {}, "manpower": {}}`, line 81)

Add:
```python
"project_context": {
    "crew_names": [],        # exact spellings: "Lopez, Salvador"
    "companies": [],         # "OHL", "RJ Noble", "PRSI", "DIII", "Hudson"
    "equipment_fleet": [],   # "6-033 (#416) — CAT 330 Excavator"
    "vocabulary": [],        # project terms: "CQS-1H", "digout", "Miramar plant"
    "notes": "",             # free text: typical shifts, project quirks
},
```
Add the matching field to `SettingsPayload` (anchor `class SettingsPayload`) and to `AppSettings` in `frontend/src/lib/settingsApi.ts` (lines 36-47).

### Task 3.2 — Inject into prompts

**File:** `backend/app/routers/ai.py`

1. Add helper `_project_context_block() -> str` that loads settings and renders:
   ```
   PROJECT CONTEXT — names and terms you may hear (use these exact spellings):
   CREW: ... / COMPANIES: ... / EQUIPMENT: ... / TERMS: ...
   ```
   Merge in the existing dead `CONSTRUCTION_VOCAB` constant (lines 771-794) — it's well-curated and currently referenced by nothing.
2. Append the block to: Pass-1 prompt sites — `/transcribe` (line 672), `/transcribe-smart` (~942), `/bulk-transcribe` (was lines 1900-1907), report-chat audio pass 1; Pass-2/parse prompts of the same endpoints; and `rewrite` (1784-1811), `generate-report` (1209-1222), `report-chat` system prompt (1457-1541).
3. **Verify:** with "Salado, Ubaldo" in crew_names, dictating "Salado" transcribes with correct spelling.

### Task 3.3 — "Learn from my reports" seeding

**File:** `backend/app/routers/settings.py` — new `POST /api/settings/learn-context`: iterate the last ~30 reports (`list_reports`), collect distinct manpower `name`/`company`, equipment `name`/`description`, merge-dedupe into `project_context`, return counts.
**File:** `frontend/src/pages/SettingsPage.tsx` — new **"Project Context"** tab (copy the "Resource Codes" tab pattern): TagList editors per list + "Learn from my reports" button.
**Verify:** button populates the lists from existing reports.

---

# PHASE 4 — Roll-forward + review screen (daily loop ≈ 1-minute dictation)

### Task 4.1 — "Start from yesterday" (roll-forward)

1. **Store** (`frontend/src/stores/reportStore.ts`): new action `cloneFromReport(src: Report, opts: { keepHours: boolean; keepSummaries: boolean })` — deep-copies activities + resources with **fresh ids** (report id `''`, `isSaved=false`), `report_date` = today (Task 1.5 helper), `general.notes=''`, weather fields cleared.
2. **Backend:** none needed — `GET /api/reports?limit=1` already returns the newest index row; fetch full report by id.
3. **UI** (`frontend/src/pages/NewReportPage.tsx`, header actions ~line 250): button **"Start from Yesterday"** visible when the report is empty → fetches latest report → `cloneFromReport` → toast "Loaded N activities from <date>". Options popover: keep hours / keep summaries (default: keep resources, clear summaries).
4. **Verify:** yesterday's crews/equipment appear; nothing autosaves until Save (existing model).

### Task 4.2 — Delta dictation on a non-empty report

**Files:** `BulkDictateButton.tsx`, `ai.py` `/bulk-parse`

When the report already has activities (roll-forward), send them: `bulk-parse` request gains `current_activities`. Prompt switches to the **surgical diff contract already proven in report-chat** (system prompt lines 1457-1541): return `modified_activities` (partial, keyed by id) + `new_activities` + `deleted_activity_ids`. Frontend applies via existing `updateActivity`/`addActivity`/`removeActivity` (same merge code as `ReportChat.tsx`). **Never** full-array replacement (documented data-loss cause — GEMINI.md Landmine #15).
**Verify:** "same as yesterday but Lopez is out and laborers worked 10 hours" edits without touching other rows.

### Task 4.3 — Post-dictate review panel

**File:** new `frontend/src/components/report/DictationReviewPanel.tsx`; wire into BulkDictateButton results phase.

Per generated activity show flag chips, computed client-side after the resource-matcher pass (the mappers in `BulkDictateButton.tsx` already call `getResourceMatcher()`):
- unmatched resource (matcher confidence < 0.95) → inline searchable code dropdown (reuse `ResourceResolutionDialog.tsx` internals — today it's only wired to dispatch import),
- missing hours / times / company, activity with 0 manpower,
- split/merge buttons between adjacent activities (wrong location-splitting is a frequent manual fix).
"Apply to report" adds everything at once. **Verify:** a dictation with a made-up trade name routes through the dropdown instead of silently defaulting to `LL-03- Laborers`.

---

# PHASE 5 — Backfill wizard (batch makeup reports)

### Task 5.1 — Backend router

**New file:** `backend/app/routers/backfill.py`; register in `main.py` (anchor: the router-include block, ~line 16 imports + `app.include_router` calls). Storage under `DATA_DIR/backfill/{batch_id}/` (Task 1.4 paths).

Endpoints:
1. `POST /api/backfill/upload` — `files: list[UploadFile]` → save each; classify: try filename date first (reuse `FILENAME_DATE_PATTERN` from `dispatches.py:44`), then one cheap AI call per file (first page only, 150 DPI) returning `{doc_type: timesheet|sub_email|dispatch|schedule|other, work_date, confidence}`. Persist + return `{batch_id, files:[{file_id, filename, doc_type, work_date, confidence}]}`.
2. `POST /api/backfill/generate` — body `{batch_id, groups: [{date, file_ids}], project_defaults_from_settings: true}`. For each group **sequentially** (append per-date status to `status.json` in the batch dir after each date so a crash loses nothing):
   - **Timesheets** → new `TIMESHEET_PROMPT`: clone `NOTE_SCAN_PROMPT` (ai.py:189-243) + `STANDARD_EXTRACTION_RULES` (ai.py:92-187) with two changes: (a) allow **multiple activities** (current scan collapses to exactly one — keep the location-splitting rules from bulk-parse), (b) **handwriting rule**: *"If a name, number, or word is not clearly legible, output the literal string `[illegible]` in that field and add it to an `uncertain_fields` array. NEVER guess a name or number."* Two-pass (verbatim transcription at 300 DPI → structured parse, `temperature=0`, `response_schema`) — same Landmine-#6 pattern as schedule.py.
   - **Sub email PDFs** → parse pass extracting narrative work details; merge into matching activity (by location/company) or its own activity flagged `source: "sub_email"`.
   - **Weather** → call the internal fetch from `weather.py` with the group date (Task 1.3 fallback makes this safe). Requires a stored default lat/lon or ZIP — read `default_zip_code` from settings (backend already has it; UI exposure is Task 8.2).
   - **Build + save**: general info from settings defaults, `status: "draft"`, plus `backfill: {batch_id, flags: [...uncertain fields...], source_files: [...]}` on the report JSON (harmless extra key — model uses `extra="ignore"`, raw-JSON save path keeps it).
3. `GET /api/backfill/{batch_id}/status` — returns `status.json` (frontend polls during generate).
4. `GET /api/backfill/{batch_id}/file/{file_id}` — serves the stored source file (for side-by-side review).
5. `GET /api/backfill/{batch_id}/export.zip` — zip of `generate_word_document()` outputs for all reports in the batch.

### Task 5.2 — Frontend page

**New file:** `frontend/src/pages/BackfillPage.tsx`; route in `App.tsx` (route table, lines ~27-37); entry buttons on `DashboardPage` and `ToolsPage`.

Three steps in one page (no modal wizard):
1. **Upload** — multi-file drag-drop (images + PDFs) → `/backfill/upload` → table of files with type + date chips.
2. **Group** — files bucketed by date, drag a file to another date to reclassify, dropdown to fix doc type; dates missing a timesheet get a warning banner.
3. **Generate & review** — progress list (poll status); per finished date a card: report link (`/report/{id}`), flag count ("2 illegible fields, 1 unmatched resource"), and a **side-by-side** expander: source image (from the file endpoint) next to the extracted activities, so bad handwriting is a visual fix. "Export all Word docs" button when done.

**Verify (acceptance):** upload one real timesheet photo + one sub PDF for one date → one draft report with weather filled, `[illegible]` markers where handwriting is bad, opens in the normal editor.

---

# PHASE 6 — Prompt & model quality

1. **Model name to config** — `backend/app/core/config.py` (~line 29): add `GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-pro")` and `GEMINI_MODEL_LITE` for classification tasks. Replace the 4 hardcoded `"gemini-2.5-pro"` strings: `ai.py:75`, `schedule.py:53`, `pdf_search.py:38`, `dispatch_parser.py:28`. (2.5 Pro retires **2026-10-16** — this makes the swap a config change.)
2. **One shared style guide + few-shots** — new module `backend/app/services/prompts.py`: single `REPORT_STYLE_GUIDE` (merge the three drifted banned-word lists from `generate-report` ai.py:1196-1207, `rewrite` ai.py:1801-1811, `email-summary` ai.py:1723-1727) + **2 real input→output pairs** modeled on the 05-16 sample report (rough notes → finished bullets). Fix the voice contradiction: delete the passive exemplar ("Excavation was completed…") in rewrite rule 3; standard is active field voice ("The crew excavated…") per `STANDARD_EXTRACTION_RULES`.
3. **Continuity context** — in `generate-report` and `rewrite`: fetch the prior 1-2 reports for the same project (by date) and append a `PRIOR DAYS (for continuity of naming and progress):` block with their activity summaries.
4. **`response_schema` + `temperature=0`** on every extraction endpoint (scan-notes 493, scan-extra-work, scan-consultant, both transcribe pass-2s, parse-report, parse-dispatch pass 2, schedule pass 2). Retire `_clean_json` where schema is enforced.
5. **Token budgets on a thinking model** — raise `analyze-questions` 1000→8192 (anchor `max_output_tokens=1000`), `generate-tc` 2048→8192, `rewrite` 4096→8192; everywhere check `finish_reason` before `.text`.
6. **Retry + async hygiene** — consolidate the 3 identical `_gemini_call_with_retry` copies (`ai.py:34`, `schedule.py:68`, `dispatch_parser.py:68`) into `backend/app/services/gemini.py`; replace `time.sleep` with `await asyncio.sleep` (current version blocks the event loop); use it on **every** Gemini call (today 3 of 21 in ai.py); reuse one `genai.Client` instead of per-request construction (`_get_gemini_client`, ai.py:75-84).
7. **Misc prompt fixes** — report-chat: stop asking the model to invent timestamp IDs (ai.py:1505) — generate IDs server-side after the response; `email-summary`: read `summary` **or** `summary_html` (ai.py:1699); TC prompt: remove the "write a generic description if no TCP" fabrication license (ai.py:2730); fix `_find_tc_plan_pdf` reading `original_name` which is never written — use `filename` (ai.py:2799 vs pdf_search.py:115-124).

---

# PHASE 7 — PMWeb extension hardening

1. **Automate Phase 5 (Notes)** — `chrome-extension/injected.js` lines 1397-1429 currently copy HTML to clipboard + `alert()` instructions. Replace: find the RadEditor via `$find` on the editor's client id (inspect the Notes tab DOM; Telerik exposes `.set_html(html)`), else fall back to `iframe.contentDocument.body.innerHTML = notesHtml` + firing its change event; keep clipboard as last-resort fallback.
2. **Remove blocking dialogs from the orchestrated run** — pass `{interactive: false}` through `fillAllRows` (injected.js:169) and `fillAllActivities` (:774): skip the resume `prompt()`s (:226, :794) and completion `alert()`s (:356, :923) when false; orchestrator already knows row counts from the payload.
3. **Real progress + persistence** — after each phase, `window.postMessage({type:'PMWEB_PHASE_DONE', phase, ok, failures})` → `content.js` relays → store in `chrome.storage.local.progress`. Popup renders from `chrome.storage.onChanged` (survives popup close — currently the bar fakes "Phase 1/5" forever, popup.js:539/617). Replace the always-success `alert('✅ Data Entry Complete!')` with a failure summary: accumulate per-row failures instead of bare `continue` (injected.js:271, 276, 303, 350, 840, 870, 917).
4. **Verification pass** — after Phase 3, re-read the grid's rendered rows (count + resource text per row), compare to payload, include mismatches in the completion report. No green check on a partial fill.
5. **Hours from backend** — `fillSingleRow` (injected.js:725-747) recomputes hours from times with lunch rule `>=6h` (docs say ≥5; backend already ships `total_hours` with correct OT split from `word.py:709-753`). Use `data.total_hours`/`data.qty` directly; delete the local recompute. Also strip the emoji from the shift value (popup.js:551-556 sends `"☀️ Day"` — likely never matches a Telerik item → shift silently unset; send `"Day"`/`"Night"`).
6. **Idempotence** — before adding rows, count existing data rows in the grid; if > 0, ask once (single confirm in the popup, not mid-run) whether to continue appending or abort.
7. **`precipAmount`** — popup.js:573 hardcodes `'0.00'`; pass actual precip from the weather data in `/pmweb-full`.
8. **Restore `window.confirm`** — injected.js:1229-1233 permanently overrides `confirm` to auto-yes; restore `originalConfirm` in a `finally` at orchestrator end.
9. **Backend auth (small but important)** — backend is public on Railway with `allow_origins=["*"]`: add an `X-Api-Key` check middleware in `main.py` (key from env), send it from `frontend/src/lib/api.ts` (axios default header) and extension fetches (popup.js), configurable in the extension's Set URL flow. Fix CORS to a concrete origin list.

---

# PHASE 8 — Cleanup & quality of life (fit in anywhere)

1. **Quick Create data wipe** (low priority — dispatch flow rarely used, but it's silently broken): `AutoCreateDialog.tsx:477-480` navigates to `/report/new`, and `NewReportPage.tsx:101` runs `closeReport()` + `newReport()`, destroying the generated report. Fix: in `AutoCreateDialog`, `await saveReport()` then navigate to `/report/{id}`; in `NewReportPage` mount effect, only reset when the store report is empty/pristine. Also fix the TC double-count: flaggers are added both by `buildActivity` (`dispatchHelpers.ts:264-271`) and again as a second activity (`AutoCreateDialog.tsx:338-345, 374-388`) — drop one (keep the dedicated TC activity, pass an option to `buildActivity` to skip TC rows).
2. **Expose `default_zip_code` in Settings** — backend already stores it (`settings.py:84`); add to `AppSettings` (`settingsApi.ts:36-47`) + a field in `SettingsPage`; use it in `GeneralInfoForm.tsx:160` before falling back to `window.prompt`. Add `project_number` / `project_location` defaults the same way and include them in `NewReportPage.tsx:114-119` `newReport({...})`.
3. **Mojibake repair** — stored reports contain double-encoded UTF-8 (`â€¢` for `•`). One-time script: walk `data/reports/*.json`, apply `text.encode('cp1252', errors='ignore').decode('utf-8', errors='ignore')` repair to string fields where the `â` signature is detected, back up originals first. Find and fix the ingest point (likely a `.decode()` mismatch on an upload path) before running it.
4. **History page correctness** — filtered pagination count: `database.py:380-387` `get_report_count()` ignores filters; add the same WHERE clause as `list_reports`. Client sort (`ReportHistoryPage.tsx:133-143`) only sorts the visible page — either move sort server-side or drop the sort buttons.
5. **Overnight shift time range** — `word.py:111-135` `_get_activity_time_range` picks `max` by clock time, so 11:00 PM beats 3:30 AM. If stop < start, treat stop as next-day (add 24 h) before comparing; include equipment rows, not just manpower.
6. **Weather line leading comma** — `word.py:221` / `:447`: if temps absent but wind present, line starts with `", Wind: …"`. Join non-empty segments with `", "` instead.
7. **General Notes newlines** — `word.py:231` uses `_extract_plain_text` (collapses `\n`); switch to `_extract_summary_lines` like activity summaries.
8. **Dead code sweep** — delete: `DISPATCH_PARSE_PROMPT_LEGACY` (ai.py:2319-2403), `chrome-extension/injected.js.bak`, stub routers `scanning.py`/`tools.py` (not registered; route-shadow risk), unused `dispatchApi.batchUpload/list/delete` client methods **unless** reused by Phase 5, duplicate `generateId` ×5 → one export from `lib/dispatchHelpers.ts`, stale types (`types/index.ts:178-189, 200-220`), dashboard dead quick-action links (`DashboardPage.tsx:101,107` — wire `?action=scan|dictate` via `useSearchParams` or remove), the 3 identical extension icon PNGs (~1.1 MB) → real 16/48/128 sizes.
9. **Schedule row-count check** — `schedule.py:301` counts lines starting `"SHIFT"` but the prompt emits `"GROUP"`; fix the prefix and actually warn on mismatch.

---

# PHASE 9 — UI/UX refresh ("make it look better")

The Flat 2.0 token system in `frontend/src/index.css` (lines 12-67: full palette, shadows, radii, spacing) is a good foundation — the problems are inconsistent application, desktop-style tables on a phone, and zero dark mode for a night-paving crew. Work top-down:

1. **Dark mode — the highest-value visual change for this user.** Shifts are 8:30 PM night work; a white `#FAFBFC` screen in the field at night is glare. Add a dark token set under `:root[data-theme="dark"]` (map every `--color-*`/`--shadow-*` var in `index.css:12-67`), a toggle in Settings + auto (`prefers-color-scheme` and/or after-sunset default), and store choice in settings. Because the whole app uses CSS vars, this is mostly one CSS block + audit of any hardcoded hex in components (`grep -rn "#[0-9A-Fa-f]\{6\}" frontend/src --include="*.tsx"`).
2. **Mobile-first resource entry.** `ResourceTable.tsx` is a wide 12-column grid — on a phone it's horizontal-scroll misery and tap targets are small. At `< 640px` render each row as a **card** (resource name as title; qty/hours/times as large steppers and time chips; flags as toggle chips). Keep the table on desktop. Bump all interactive elements to ≥ 44px touch targets (gloved hands).
3. **Report page structure.** `NewReportPage` is one long scroll with 5 collapsed sections per activity. Add: sticky mini-nav (chips: General / Schedule / Activities / Export) that scrolls to section; per-activity completeness indicator (has summary / has crew / has hours) so what still needs attention is visible without expanding; expand the first resource section by default when it has rows.
4. **One overlay pattern.** 11 different modals/overlays exist with drifting styles (`ParseReportDialog`, `DispatchImportDialog`, `EmailSummaryDialog`, `AutoCreateDialog`, `PhoneScannerModal`, `ResourceResolutionDialog`, `AIReportAssistant`, `ReportChat`, `PMWebPreview`, `ActivityUpdatePanel`, `BulkDictateButton`). Extract one `<Sheet>` component: bottom-sheet on mobile, centered card on desktop, consistent header/close/footer, safe-area padding; migrate all 11.
5. **Feedback & motion.** Replace remaining `alert()`/`window.prompt()` (weather ZIP, extension URL) with in-app dialogs/toasts; skeleton loaders for history/dashboard lists instead of spinners; subtle transitions (150-200ms) on section expand, sheet open, card hover — tokens already define the shadows/radii to lean on.
6. **Empty states & dashboard.** Dashboard should answer "did I do today's report?" at a glance: a Today card (report status + resume button + weather), then recent reports. Add friendly empty states with a next-action button (New/Backfill/Dictate) instead of blank lists. Kill the dead Scan/Dictate quick-action tiles (`DashboardPage.tsx:101,107`) or wire them (Phase 8.8).
7. **Small consistency pass.** One icon set usage style (lucide already in place), consistent button hierarchy (primary = one per view), consistent card paddings from the spacing scale, number-formatting helper for hours/tons (`1,210 SF`, `90.75 T`), and a proper app icon + splash for the Android build.

---

# Build order & session-sized chunks

| Session | Content | Done when |
|---|---|---|
| 1 | Phase 1 (all 6 fixes) | parse-report imports a PDF end-to-end; weather works for any past date |
| 2 | Phase 2 (2.1 + 2.2) | Transcript confirmation step live; silence → clean error |
| 3 | Phase 2.3 + Phase 3 | All audio endpoints hardened; context pack in Settings + prompts |
| 4 | Phase 5 backend (5.1) | Batch generate from CLI/API works on real scans |
| 5 | Phase 5 frontend (5.2) | Full backfill wizard usable → **makeup reports done** |
| 6 | Phase 4 (roll-forward + review panel) | Daily loop: roll forward + delta dictation + one review pass |
| 7 | Phase 6 | Prompts consolidated, schema-enforced, model in config |
| 8 | Phase 7 | One-click PMWeb with verification; API key auth |
| 9 | Phase 9.1-9.3 (dark mode, mobile resource cards, report page structure) | Night-usable, phone-usable |
| 10 | Phase 9.4-9.7 + Phase 8 | Consistent overlays/feedback; cleanup swept |

Notes:
- Phases 1→2→3 are strictly ordered; Phase 5 needs Phase 1 (+3 helps accuracy); Phase 4 needs 2; Phases 6-9 are independent of each other.
- The makeup reports themselves need the real timesheet scans + sub email PDFs uploaded when Phase 5 lands (not in the repo today).
- After each session: `python -m compileall backend/app` clean, `npm run build` zero TS errors, deploy per usual (Railway), `npx cap sync android` when frontend changed.
