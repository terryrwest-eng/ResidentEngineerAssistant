# GEMINI.md — Daily Reporter V3 — Shift-Change Log

## Architecture Overview

### Stack

- **Frontend:** Vite + React 19 (SPA), TypeScript, Tailwind CSS 4, custom Flat 2.0 CSS design system
- **Backend:** FastAPI (Python), SQLite + file-per-report JSON storage
- **State:** Zustand (`src/stores/reportStore.ts`)
- **HTTP Client:** Axios (`src/lib/api.ts`)
- **Storage:** SQLite for indexing + individual .json files per report in `data/reports/`
- **Deployment:** Railway with persistent volume at `/app/data` (reports, photos, specs survive redeploys)
- **AI:** Google `google-genai` SDK
- **Design:** Flat 2.0 — light theme, Inter font, bottom tab navigation

### Navigation Layout

- **Top Header** (sticky, 56px) — page title + server status
- **Bottom Tab Bar** (fixed, 64px) — Home | History | New (FAB) | Tools | Settings
- **NO sidebar. NO click-outside-to-dismiss modals.**
- Toast position: `bottom: 80px` (above bottom nav)

### Save Model (Word/Excel style)

```
New Report → Memory only (no file, no auto-save)
User types → isDirty=true, no auto-save yet
User hits Save → creates file → assigns ID → isSaved=true
After first save → auto-save on every change (2s debounce)
Navigate away while dirty → beforeunload browser prompt
```

### Key Directories

```
DAILY-REPORTER-V3/
├── frontend/
│   ├── src/
│   │   ├── pages/            # Route-level pages
│   │   ├── components/
│   │   │   ├── layout/       # TopHeader, BottomNav
│   │   │   ├── report/       # GeneralInfoForm, ActivityList, ActivityEditor,
│   │   │   │                 # ResourceTable, PMWebPreview,
│   │   │   │                 # AIReportAssistant, BulkDictateButton,
│   │   │   │                 # ActivityUpdatePanel, ParseReportDialog,
│   │   │   │                 # DispatchImportDialog
│   │   │   └── ui/           # NavigationGuard, etc.
│   │   ├── hooks/            # useIMEInput (composition-aware inputs)
│   │   ├── stores/           # reportStore.ts (Zustand)
│   │   ├── lib/              # api.ts, constants.ts
│   │   └── types/            # TypeScript interfaces
│   └── vite.config.ts        # Proxy: /api → localhost:8000
├── backend/
│   ├── app/
│   │   ├── routers/          # reports.py, export.py, auth.py, ai.py, tools.py, schedule.py
│   │   ├── services/         # word.py, pmweb_mappings.py, reports.py
│   │   └── main.py
│   ├── data/                 # All persistent data (gitignored)
│   │   ├── reports/          # Individual report JSON files (atomic writes)
│   │   ├── photos/
│   │   ├── specs/
│   │   └── schedules/
│   └── requirements.txt
├── chrome-extension/         # PMWeb Auto-Fill (carried over as-is)
└── GEMINI.md
```

### PMWeb Integration

- **Combined table (11 cols)** — Resource, Pay Type, Classification, Specialist, Remarks, Subcontractor, Qty, Company, Hours, Start, Finish
  - Chrome extension auto-fill + frontend PMWebPreview
  - `GET /api/export/{id}/pmweb` → `aggregate_for_pmweb()`
- **Consolidated table (6 cols)** — Word document Page 2 only
  - `_aggregate_for_word()` in `word.py`
- **Resource codes**: `pmweb_mappings.py` — 39 labor (LL-) + 160 equipment (LE-) codes

---

## Build Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1. Foundation | ✅ DONE | Vite scaffold, bottom nav, CSS design system, backend skeleton |
| 2. Report Builder | ✅ DONE | GeneralInfoForm, ActivityEditor, ResourceTable, Word/Excel save model |
| 3. Export | ✅ DONE | Word .docx generator, PMWeb Combined preview, export router |
| 4. AI Scanning | ✅ DONE | Scan, dictation, rewrite, assistant, bulk dictate, media update, parse report |
| 5. Field Tools | ✅ DONE | Pipe volume, excavation, unit converter, concrete calculators |
| 6. Trackers | ⏳ PENDING | Excavation, pay items, punch list, redline |
| 7. Documents | ✅ DONE | Smart PDF search (exhaustive multimodal, semantic matching) |
| 8. History & Search | ✅ DONE | Report list, search, date filter, status filter, pagination, delete |
| 9. Photos | ⏳ PENDING | Photo stamper, phone scanner |
| 10. Settings & Auth | ⏳ PENDING | PMWeb URL, API keys, user management |

---

## Known Landmines

1. **OneDrive file locking** — Vite can crash with `EPERM: operation not permitted` on `.vite/deps_temp_*`. Just restart `npm run dev`.
2. **CSS @import order** — Google Fonts `@import` MUST be first line in `index.css`, before `@import "tailwindcss"`.
3. **useBlocker** — Removed from NavigationGuard due to React Router version issues. Only `beforeunload` is hooked. In-app nav prompt relies on explicit save checks.
4. **Content-Type for FormData** — Must be `null` (not `undefined`) for multipart. Set in `scanApi.scanNotes()`, `pdfApi.ask()`, and all scan endpoints. The axios default is `application/json`; if you don't override it, FastAPI returns 422 because it can't parse Form(...) fields.
5. **PMWeb naming** — "Combined Resource Table" = 11-col (Chrome extension). "Consolidated Resources" = 6-col (Word doc). Never swap.
6. **Gemini JSON mode + audio = hallucination** — NEVER use `response_mime_type='application/json'` on a call that includes audio. The model prioritizes filling the JSON schema over faithful transcription. Always use a two-pass approach: text mode for transcription, then JSON mode to parse the text.
7. **scanning.py stubs** — `backend/app/routers/scanning.py` has stub routes for `/ai/scan-notes` and `/ai/transcribe` that return "not yet implemented". It is NOT imported in `main.py` (only `ai.py` is), but if someone adds it, those stubs will shadow the real endpoints.
8. **`as` operator precedence** — TypeScript `as X || fallback` doesn't work: `as` binds tighter than `||`, so the fallback never fires. Always use `Array.isArray(x) ? x as T : fallback` instead.
9. **`captureInput: true` in Capacitor** — NEVER enable this. It intercepts all touch events before Gboard's gesture detector, completely breaking swipe/glide typing on Android. The setting was removed in the 2026-05-27 fix.
10. **`defaultValue` inputs don't auto-update** — GeneralInfoForm uses `defaultValue` (not `value`) for IME compatibility. If external code updates the store (e.g., weather auto-fill, AI report chat), the DOM input won't reflect the change unless the component remounts. Use a `key` prop with a revision counter to force remount (see `weatherRevision` pattern in GeneralInfoForm).
12. **PyMuPDF (fitz) for schedule parsing** — `schedule.py` uses PyMuPDF to render image-based schedule PDFs to 300 DPI PNG images before sending to Gemini. If PyMuPDF is not installed, the endpoint returns a 500 with a helpful message. Install: `pip install PyMuPDF`. The import is lazy (`import fitz` inside the endpoint).
13. **Schedule storage** — Schedules are stored in `data/schedules/{uuid}/` subdirectories, each containing a `.json` (parsed data) and `.pdf` (original). The `DispatchImportDialog` fetches the most recent schedule via `GET /api/schedule/active`.
14. **WebChromeClient full delegation** — `MainActivity.java` uses `PermissionGrantingWrapper` that delegates ALL `WebChromeClient` methods to Capacitor's original. If you add new WebChromeClient methods, you MUST add delegation. Never create a `new WebChromeClient()` — always wrap the existing one.
15. **Report Chat uses MERGE, not REPLACE** — The `/api/ai/report-chat` endpoint returns surgical diffs, NOT full activity arrays. `modified_activities` contains partial updates keyed by activity `id`. `new_activities` is for brand new ones. `deleted_activity_ids` is for removals. The frontend merges via `updateActivity()`, `addActivity()`, `removeActivity()`. NEVER switch back to full-array replacement — that caused data loss (dropped manpower/equipment the model wasn't asked to touch).
16. **One model, set in one place** — The app runs `gemini-3.6-flash`, defined once as `GEMINI_MODEL_NAME` in `app/core/config.py` and used as the default for every `_get_gemini_client()`. Override it without code changes by setting the `GEMINI_MODEL` environment variable. This replaced `gemini-2.5-pro`, which Google retires **Oct 16, 2026**.
17. **Never use `thinking_budget`** — Gemini 3 models reject the numeric `thinking_budget` parameter that Gemini 2.5 used; they take `ThinkingConfig(thinking_level=...)` instead, one of `MINIMAL`/`LOW`/`MEDIUM`/`HIGH`. Passing both in one request is an error. Requires `google-genai>=2.x` — the older 1.x SDK has no `thinking_level` field at all.
18. **Thinking tokens come out of `max_output_tokens`** — they are not a separate allowance. Too small a cap plus heavy thinking means the model returns *no text* and `response.text` is `None`. Give text endpoints room (16384+) and don't call `.strip()` on `response.text` without checking it first.
19. **PMWeb Day Type follows the date and the Shift picked for the run** - `pmwebDayType` in `chrome-extension/core.js` (2026-10-11): a City holiday (WHITEBOOK 1-2 list), a Saturday or a Sunday day shift is `2 -Non-Working Day`; a Sunday night or evening shift and every other day is `1 -Working Day`. Every Shift box starts at Day, so a Sunday night run must be picked as Night. A non-holiday day the RE calls non-working (1/02/2026) is set by hand after the last Auto-Fill run, because Phase 4 writes the drop-down on every run.
20. **`setComboBox` in `injected.js` says true whenever it could type** - matched item or not - and false when anything in it throws, even after the item was picked. Its return value is not proof either way. Phase 4 reads the Day Type back with `comboSelectedText` (the selected item's text, via `$find`, never throwing) and reports a miss as a run problem (2026-10-11). Phase 1's weather and shift boxes are not read back.
21. **`PMCore.setContextReport` throws when the app refuses the pick** (2026-10-11). Auto-Fill reads the server's context, so a refused POST used to leave PMWeb filling from the previous report while the extension showed the new one. Every caller must stop on the error: the popup's `selectReport` returns false and its queue returns; the side panel's goes through `busy()`.
22. **Every Move in the resource picker posts the picker back** (2026-10-13). The picker's frame loads a new document after each Move, ticks cleared, staged rows kept. While it loads, `pmPopup()` returns null, which is not the picker closing. `fillResourcesFast` used to break its wait on that null and report "pass N staged nothing" (records 1306 and 1299). The pass loop now waits for `pickerReady()` (document complete, `Sys.Application` initialized, tree component built, no Move still on its way), clears every tick and re-ticks the pass's resources so the Move button always shows, retries a pass that staged nothing once, refuses to save a pass that staged more than it wanted, and returns stage `'picker'` (never the row-at-a-time fallback) when the picker never gets ready. The first tree read also waits: reading the tree before it was built threw, and the throw sent fills to the slow filler. Proved on record 1307: 6 passes, 15 rows, first try.
23. **A resource row with no PMWeb code is skipped, and a report with no coded rows at all falls back to the slow filler** (2026-10-13). The export names a crew row by its trade, or by the man's name when the time sheet gives no craft; a name never maps to a code. 1/02/2026's two men had no craft, so Phase 3 found nothing to pick and fell back.
24. **An activity's work area reaches PMWeb's On Site grid through `split_work_area`** in `backend/app/services/pmweb_mappings.py` (2026-10-13, commits 9143d34 and 25326f9 on `main`). Both PMWeb endpoints call it; never split `work_area` inline again. "Location - Company - Title" reads by position as always. A shorter work area is read by what its parts are: the part naming a company on the activity's rows is the company, the other part is the location (first) or the description (after the company). A company part naming several firms ("OHLA / Dean's Welding / Penhall", "OHLA & Picket Fences") gives PMWeb the first one, Terry's rule of 2026-10-13. With no location part, `injected.js` takes the place from the description (`pmPlacesNamed`, no fallback to the raw words) and leaves Location blank when none is named. Test: `python3 backend/tests/test_work_area_split.py`.
25. **Attach photos needs the photo server running on this PC** (2026-10-13). The side panel's "Attach photos" asks `background.js` (the extension's service worker, new in 2.3) for the selected report date's photos; the worker fetches them from `http://127.0.0.1:8765`, served by `2026-10-13_photo_server.py` in the Morena job folder's `19 - Daily Report Reconstruction\_agent_output\_scripts`. The fetch is in the worker, not the panel, because the panel runs as part of the PMWeb page and Chrome asks permission before a public site reaches this PC. `token-sync.js` is excluded from port 8765: on any other `127.0.0.1` page it would find no sign-in and clear the extension's token. The panel refuses a record whose saved Report Date differs from the selected report, or whose date box holds an unsaved change; skips photos already on the Attachments grid by name; hands PMWeb one group of up to 6 photos at a time and waits for the grid and a fresh upload box before the next; and stops if the tab count exceeds the rows on the grid's page (page size is 250 now).
---

## Session Log

### 2026-05-05 — Initial Build
- Vite + React + FastAPI scaffold
- Bottom tab navigation replacing sidebar
- SQLite + file-per-report storage with atomic writes

### 2026-05-06 — Phases 2 & 3
- Word/Excel save model: `reportStore.ts`
- Report builder: `GeneralInfoForm`, `ActivityList`, `ActivityEditor`, `ResourceTable`
- PMWeb constants: `lib/constants.ts` (39 labor + 160 equipment codes)
- Word export service: `backend/app/services/word.py` (exact legacy format preserved)
- PMWeb Combined preview: `PMWebPreview.tsx` — 11-col, Copy + Auto-Fill
- Export router: `backend/app/routers/export.py`
- Fixed CSS import order (fonts before tailwindcss)

### 2026-05-12 — Phase 4 (AI Activity Manager)
- Re-architected the Activity Manager Co-Pilot for V3.
- Backend endpoint (`POST /api/ai/activity-manager`) using `google-genai` and robust JSON schemas.
- Frontend chat UI (`ActivityManagerChat.tsx`) utilizing Flat 2.0 design overlay and strict Zustand activity array replacements.
- Connected via `AI Manager` button in `ActivityList.tsx`.
- Resolved critical TypeScript configuration errors (`ignoreDeprecations` for TS 6.0 compatibility) and strict typing mismatches across `ResourceTable`, `ActivityEditor`, `ScanPage`, `TrackersPage`, and `reportStore.ts`.
- Addressed Python 3.14 compatibility compilation issues for `pydantic-core` and `Pillow` dependencies using `PYO3_USE_ABI3_FORWARD_COMPATIBILITY`. The frontend and backend builds now compile cleanly.

### 2026-05-13 — Phase 4 Completion (7 AI Features Port)
- **Backend endpoints added** to `ai.py`:
  - `POST /api/ai/rewrite` — Polish rough notes into RE-quality bullets
  - `POST /api/ai/bulk-dictate-activities` — One recording → split by location into multiple activities
  - `POST /api/ai/update-activity` — Smart Merge from photo/video/audio/document
  - `POST /api/ai/parse-report` — Upload .docx/.pdf → create new draft report
  - (Already existed: `/analyze-questions`, `/generate-report`)
- **Frontend API client** (`api.ts`) — Added 6 new methods: `rewrite`, `analyzeQuestions`, `generateReport`, `bulkDictate`, `updateActivity`, `parseReport`
- **New components:**
  - `AIReportAssistant.tsx` — Full chat panel with WWWW badges, rewrite, analyze→generate flow (Features #1, #2, #6)
  - `BulkDictateButton.tsx` — Record entire day → AI splits by location (Feature #4)
  - `ActivityUpdatePanel.tsx` — Upload media to update existing activity, Smart Merge/Replace toggle (Feature #5)
  - `ParseReportDialog.tsx` — Import .docx/.pdf completed reports (Feature #7)
- **Wiring:**
  - `ActivityEditor.tsx` — Added Rewrite, AI Assistant, and Media Update buttons in summary toolbar
  - `ActivityList.tsx` — Added Import and Dictate All buttons in header + empty state
- TypeScript compiles cleanly with zero errors.
- **Pending user requests (next session):**
  - Master Lists (Projects, Contractors) in Settings + report editing
  - Report History Migration from original app's massive JSON file

### 2026-05-14 — Resource Table Upgrade (PMWeb Feature Parity)
- **TypeScript types updated** (`types/index.ts`):
  - `ManpowerRow` — Added `start_time`, `stop_time`, `is_3rd_party`, `locked`
  - `EquipmentRow` — Added `start_time`, `stop_time`, `is_3rd_party`, `is_consultant`, `is_rental`, `locked`
- **Resource Matcher ported** (`lib/resourceMatcher.ts`):
  - TypeScript port of V1's `resourceMatcher.js`
  - Fuzzy matches raw AI output to PMWeb LL/LE codes
  - Specificity scoring prefers generic titles (e.g., "LE-109- Excavator") over manufacturer-specific
  - Singleton factory using hardcoded constants from `constants.ts`
- **ResourceTable rebuilt** (`components/report/ResourceTable.tsx`):
  - Full column set: Select, Resource (PMWeb dropdown), Name/Equip#, Qty, Hrs, Start, Stop, Company (dropdown), 3rd/EW/Con checkboxes, Rental (equip only), Duplicate, Lock
  - Bulk Apply row: apply Hours, Start, Stop, Company, and checkboxes to all unlocked rows
  - Multi-select rows with checkbox → bulk delete
  - Row lock toggle (protected from bulk apply)
  - Searchable PMWeb resource dropdown with filter
- **BulkDictateButton updated** (`components/report/BulkDictateButton.tsx`):
  - Mappers include all new fields (start_time, stop_time, is_3rd_party, is_rental, etc.)
  - Integrated `getResourceMatcher()` for auto-matching AI output to PMWeb codes
- **ActivityEditor updated** — removed deprecated `isExtraWork`/`isConsultant` props
- TypeScript compiles cleanly with zero errors.
- **Pending:**
  - Bulk Dictate recording stops early — may need investigation of browser VAD / buffer limits
  - Master Lists (Projects, Contractors) in Settings
  - Report History Migration

### 2026-05-18 — Bulk Dictate Fix + Word Export Audit + Android
- **BulkDictateButton.tsx** — Fixed operator precedence bug (`as` binds tighter than `||`). Used `Array.isArray()` guards. Added comprehensive debug logging.
- **Word export** — Audited against example report images. Added underline to activity titles in `word.py`.
- **Railway deployed** with fixes.
- **Android feature parity** — Fixed `MainActivity.java` WebChromeClient to properly delegate to Capacitor's existing client instead of replacing it. Runtime mic/camera permission requests. `npx cap sync android` completed.

### 2026-05-19 — Transcription Hallucination Fix
- **Root cause**: `/api/ai/transcribe` endpoint used a single-pass approach with `response_mime_type='application/json'` forcing. When forced into JSON mode, the model hallucinated plausible construction content instead of faithfully transcribing what was spoken.
- **Fix**: Rewrote `/transcribe` as a **two-pass approach**:
  - Pass 1 (TEXT mode): Uses `DICTATION_SYSTEM_PROMPT` — no JSON forcing, model focuses purely on hearing the audio correctly.
  - Pass 2 (JSON mode): Takes the verified transcription text and parses it into structured activities.
- **ScanPage.tsx** — Fixed the same operator precedence bug that was fixed in BulkDictateButton.tsx. All 3 mapper functions (`_mapActivities`, `_mapExtraWorkResult`, `_mapConsultantResult`) now use `Array.isArray()` guards. Added debug logging.
- **Pending:**
  - Bulk Dictate recording stops early — may need investigation of browser VAD / buffer limits
  - Master Lists (Projects, Contractors) in Settings
  - Report History Migration

### 2026-05-20 — AI Report Chat (Voice + Text)
- **New endpoint** `POST /api/ai/report-chat` in `ai.py`:
  - Full report manipulation via natural language (general info + activities)
  - Two-pass audio processing: Pass 1 transcribes faithfully (text mode), Pass 2 processes intent (JSON mode)
  - If audio is unintelligible, returns honest "I couldn't hear you" instead of hallucinating
  - Accepts both text messages and base64 audio
- **New API method** `scanApi.reportChat()` in `api.ts`
- **New component** `ReportChat.tsx`:
  - Flat 2.0 overlay (same style as existing ActivityManagerChat)
  - Voice input: tap mic to record, tap again to send
  - Text input: type and send
  - Transcription display: shows what AI heard from voice
  - Apply/Discard workflow for proposed report changes
  - Quick-start hint buttons in empty state
- **Report page integration** (`NewReportPage.tsx`):
  - Floating Sparkles FAB button (bottom-right, above nav)
  - Opens ReportChat overlay
- **Pending:**
  - Bulk Dictate recording stops early — may need investigation of browser VAD / buffer limits
  - Master Lists (Projects, Contractors) in Settings
  - Report History Migration

### 2026-05-21 — Weather Auto-Fill + PDF Search
- **Weather router** (`backend/app/routers/weather.py`):
  - Ported from legacy app — Open-Meteo API (free, no key needed)
  - `GET /api/weather?lat=...&lon=...` — GPS coords
  - `GET /api/weather/by-zip?zip=92101` — ZIP code geocoded
  - Returns temp high/low, wind, sky condition ID mapped to frontend chips
- **Weather button** (`GeneralInfoForm.tsx`):
  - "Fetch Weather" button in weather section header
  - Tries GPS geolocation first, falls back to ZIP code prompt
  - Auto-fills temp high, temp low, wind info, and sky condition chip
- **PDF Search router** (`backend/app/routers/pdf_search.py`):
  - Stores PDFs locally in `data/specs/` (no R2 needed)
  - `POST /api/pdf/upload` — multi-file upload
  - `POST /api/pdf/ask` — Gemini 2.5 Pro multimodal analysis (sends raw PDF bytes)
  - `GET /api/pdf/documents` — list all
  - `DELETE /api/pdf/{doc_id}` — delete with cleanup
- **PDF Search UI** (`ToolsPage.tsx`):
  - New "PDF Search" tab in Field Tools
  - Document library: upload, select, delete
  - Conversational search: chat UI with persistent history
  - Auto-selects newly uploaded docs
- **Frontend API methods** (`api.ts`):
  - `weatherApi.fetchByCoords()`, `weatherApi.fetchByZip()`
  - `pdfApi.upload()`, `pdfApi.ask()`, `pdfApi.list()`, `pdfApi.delete()`
- **Pending:**
  - Bulk Dictate recording stops early — may need investigation of browser VAD / buffer limits
  - Master Lists (Projects, Contractors) in Settings
  - Report History Migration

### 2026-05-22 — PDF Search Fix + Railway Persistent Volume
- **PDF Search 422 fix** (`api.ts`): `pdfApi.ask()` was sending FormData with default `Content-Type: application/json` header. FastAPI returned 422 because it couldn't parse Form fields. Fixed by setting `Content-Type: null` to let axios auto-detect multipart boundary.
- **Exhaustive search prompt** (`pdf_search.py`): Replaced generic Q&A prompt with aggressive SEARCH_SYSTEM_PROMPT:
  - Full document scan: every page, section, table, footnote, diagram caption
  - Semantic matching: finds content even with different terminology
  - Match classification: 🔴 DIRECT / 🟡 RELATED / 🔵 CONTEXTUAL
  - Structured output: page numbers, section refs, verbatim quotes, relevance explanation
  - Summary with total match counts and sections scanned
  - Thinking budget (16K tokens) for deep analysis on large documents
- **Railway persistent volume**: Created `resident_engineer_assistant-volume` mounted at `/app/data` (5GB). Reports, photos, and uploaded PDFs now survive deployments. Affects web AND Android (same backend).
- **Pending:**
  - Bulk Dictate recording stops early — may need investigation of browser VAD / buffer limits
  - Master Lists (Projects, Contractors) in Settings
  - Report History Migration

### 2026-05-27 — Swipe/Glide Typing Fix (Android)
- **Root cause (3 layers):**
  1. `captureInput: true` in `capacitor.config.ts` — intercepted all touch events before Gboard's gesture detector
  2. Incomplete `WebChromeClient` delegation in `MainActivity.java` — only 6 of 30+ methods delegated to Capacitor's original, losing IME handling
  3. React controlled inputs (`value` + `onChange`) — overwrote input DOM value during IME composition, breaking mid-swipe state
- **Fix 1** (`capacitor.config.ts`): Removed `captureInput: true`
- **Fix 2** (`src/hooks/useIMEInput.ts`): Created composition-aware hook that pauses store updates during `compositionstart`→`compositionend`
- **Fix 3** (`GeneralInfoForm.tsx`): Switched all text inputs from `value` to `defaultValue` with composition event handlers. Added `weatherRevision` key counter for weather auto-fill remount.
- **Fix 4** (`MainActivity.java`): Replaced incomplete anonymous `WebChromeClient` with `PermissionGrantingWrapper` — a named inner class that delegates ALL 20+ methods to Capacitor's original, overriding only `onPermissionRequest`
- TypeScript compiles cleanly with zero errors.
- **Pending:**
  - Build APK and test swipe typing on-device
  - Bulk Dictate recording stops early
  - Master Lists (Projects, Contractors) in Settings
  - Report History Migration

### 2026-05-27 — Equipment Table Defaults Cascade from Manpower
- **Feature**: Equipment table bulk apply defaults (start/stop times, hours, company) now automatically cascade from manpower table within the same activity
- **`ResourceTable.tsx`**: Added `defaultHours` and `defaultCompany` props. Added `useEffect` to sync bulk apply state when default props change (skips initial mount to avoid clobbering). New rows also inherit cascaded defaults.
- **`ActivityEditor.tsx`**: Added `deriveManpowerDefaults()` helper — computes mode (most common value) of start/stop times, hours, and company from filled manpower rows. Contract manpower cascades to contract equipment. Extra work manpower cascades to extra work equipment.
- **Flow**: User fills manpower table → equipment table's bulk apply row auto-populates with matching values → new equipment rows also use those defaults
- TypeScript compiles cleanly with zero errors.

### 2026-05-27 — Word Export Bullet Formatting Fix
- **Root cause**: `_extract_plain_text()` in `word.py` collapsed ALL whitespace (including `\n`) into single spaces. Summaries with bullet points became one long text block in the .docx output.
- **Fix**: Added `_extract_summary_lines()` — converts HTML `<li>`, `<br>`, `</p>` tags AND plain `\n` newlines into separate lines. Each line becomes its own paragraph in the Word doc. Bullet-prefixed lines (•, -, *, –) get a 0.25" left indent.
- **Scope**: Backend-only change (`word.py`). Both web app and APK use the same Railway backend API, so one deploy covers both.
- Deployed to Railway.

### 2026-05-28 — 7-Bug Fix (Dictation Data, Weather, Settings Wiring)
- **DICTATION_SYSTEM_PROMPT** (`ai.py`):
  - Pass 1 output format now includes: company, start/stop times, scope flags (Extra Work, 3rd Party, Consultant, Rental), and STATIONS line
  - Previously only captured trade/name/qty/hours — all other fields were dropped before Pass 2 could parse them
  - Pass 2 bulk-dictate prompt now extracts `stations` field per activity
- **General Notes prompt** (`ai.py`):
  - Changed from "1-3 sentence professional summary" (too vague) to explicit "superintendent elevator pitch" directive
  - Now produces high-level executive overview, not detailed activity recap
- **Weather ID mismatches** (`weather.py`):
  - Backend returned `sunny`/`rainy`/`foggy` but frontend expects `clear`/`rain`/`fog`
  - Fixed all WMO code mappings to match frontend `SKY_CONDITIONS` constants
  - Drizzle codes (51/53/55) now map to `drizzle` instead of `rain`
- **Historical weather** (`weather.py` + `api.ts` + `GeneralInfoForm.tsx`):
  - New `OPEN_METEO_ARCHIVE_URL` for past dates
  - `_fetch_weather()` auto-switches between forecast (today/future) and archive (past) API
  - Both endpoints accept optional `?date=YYYY-MM-DD` parameter
  - Frontend passes `gen.report_date` to weather fetch calls
- **Settings wiring** (`NewReportPage.tsx` + `GeneralInfoForm.tsx`):
  - New reports now pre-fill `project_name` and `resident_engineer` from settings defaults
  - Project Name field now has `<datalist>` autocomplete from `settings.projects[]`
  - Graceful fallback if settings API fails
- **Frontend mappers** (`BulkDictateButton.tsx`, `ScanPage.tsx`):
  - `stations` field now extracted from AI response instead of hardcoded `''`
- All changes verified: Python syntax clean, TypeScript zero errors.

### 2026-05-28 — New Report Button + Company Combobox + Default Times
- **New Report button** (`NewReportPage.tsx`):
  - Root cause: `else if (!report)` guard skipped creating a new report if Zustand store still held the old one from a previous session
  - Fix: Always call `closeReport()` first when navigating to `/report/new` (no ID), then create a fresh report with settings defaults
- **Company dropdown → combobox** (`ResourceTable.tsx`):
  - Root cause: Company column was a strict `<select>` — if a company wasn't in settings, it couldn't appear (or be selected after AI dictation)
  - Fix: Converted to `<input>` + `<datalist>` — settings companies appear as autocomplete suggestions, but any free-text company name is accepted (including AI-dictated ones)
  - Applied to both bulk apply row and individual data rows
- **Default times** (`NewReportPage.tsx`):
  - Root cause: `newReport()` call only passed `project_name` and `resident_engineer` — missing `start_time` and `end_time`
  - Fix: Added `start_time: s.default_start_time` and `end_time: s.default_stop_time` to the defaults
- Deployed to Railway + Android synced.

### 2026-06-10 — Dispatch + Schedule Import Feature
- **New router** `backend/app/routers/schedule.py` (404 lines):
  - `POST /api/schedule/upload` — Upload image-based schedule PDF → PyMuPDF renders to 300 DPI images → Gemini 2.5 Pro vision extracts table data → saves JSON + PDF to `data/schedules/{uuid}/`
  - `GET /api/schedule/active` — Returns most recently uploaded schedule
  - `GET /api/schedule/list` — Lists all schedules with metadata
  - `DELETE /api/schedule/{id}` — Deletes schedule directory
- **New endpoint** `POST /api/ai/parse-dispatch` appended to `ai.py` (200 lines):
  - `DISPATCH_PARSE_PROMPT` — extracts job columns from paving dispatch PDFs
  - Uses Gemini Files API temp-file upload pattern (same as parse-report)
  - Extracts: job info, crew assignments, equipment, subs (trucking/grinders/brooms), oil truck, rentals
  - Ignores: Crew Down, EQ Down, Misc, Yard Mechanics, Office/Field, Legend, S/T certs
- **New component** `DispatchImportDialog.tsx` (1193 lines):
  - 4-phase modal: Upload → Select Jobs → Shift & Time → Preview + Add
  - Phase 2: Selectable job cards with expand/collapse, contract type badges, crew counts
  - Phase 3: Loads active schedule, shift dropdown with digout table preview, end time input with auto-calculated hours
  - Phase 4: Preview activity + "Add to Report" button
  - CONTRACT jobs → regular manpower/equipment, CHANGE ORDER jobs → extra_work arrays
  - 3rd party subs (trucking, grinders, brooms) → is_3rd_party rows
  - Equipment auto-matched to PMWeb codes via `getResourceMatcher().match()`
  - Overnight shift hours calculation
- **Types** (`index.ts`): 11 new interfaces (DispatchJob, ScheduleShift, etc.)
- **API** (`api.ts`): `scanApi.parseDispatch()` + `scheduleApi` (upload, getActive, list, delete)
- **Wiring** (`ActivityList.tsx`): Dispatch button (Truck icon) in header + empty state
- **main.py**: Registered schedule router + SCHEDULES_DIR in data directories
- Python syntax ✅, TypeScript zero errors ✅

### 2026-06-10 — Dispatch Upgrade (Resource Resolution + Collapsible Tables + Schedule Section + Chat)
- **Collapsible resource tables** (`ActivityEditor.tsx`):
  - All 5 resource sections (manpower, equipment, extra work MP, extra work EQ, consultants) now collapsible
  - `CollapsibleResourceSection` component: clickable header bar with icon, label, count badge, chevron
  - Collapsed by default — click to expand, cleans up activity view significantly
- **Resource alias system** (backend + frontend):
  - `resource_aliases` field added to `DEFAULT_SETTINGS` in `settings.py`
  - `PUT /api/settings/resource-aliases` — merges new aliases into existing
  - `settingsApi.saveResourceAliases()` added to frontend
  - `ResourceMatcher` upgraded: `setAliases()`, `addAlias()`, aliases checked FIRST before fuzzy scoring
  - `loadResourceAliases()` and `saveResourceAliases()` exported for use across app
- **Resource Resolution Dialog** (`ResourceResolutionDialog.tsx`):
  - Modal showing unmatched resources with searchable PMWeb code dropdowns
  - Pre-selects best guess if confidence ≥ 0.7
  - "Remember this mapping" checkbox (default: checked) → saves aliases server-side
  - Wired into DispatchImportDialog as Phase 3.5 between shift selection and preview
- **Schedule section on report page** (`ScheduleSection.tsx`):
  - New collapsible section between General Info and Activities on NewReportPage
  - Upload, view, delete schedules (paving/digout + 3-week construction lookahead)
  - Shows active schedule with expandable shift tables
  - Removed schedule tab from ToolsPage (ScheduleManager still present as dead code)
- **Chat schedule integration** (`ReportChat.tsx` + `ai.py`):
  - ReportChat fetches active schedule on mount
  - Schedule data included in every report payload sent to AI
  - Backend `report-chat` endpoint injects schedule context into system prompt
  - AI can now reference specific shifts, DO numbers, tonnage, and dimensions
- TypeScript zero errors ✅, Python syntax verified ✅
- **Pending:**
  - 3-week lookahead schedule backend support (current parser is paving-focused)

### 2026-06-11 — Two-Pass AI Fix (Schedule + Dispatch Hallucination)
- **Root cause**: Both `schedule.py` and `ai.py` (parse-dispatch) used `response_mime_type='application/json'` with media (images/PDF). This is **Landmine #6** — JSON forcing with media causes the model to prioritize filling the JSON schema over faithful reading, leading to:
  - Schedule: skipping real digout rows, inventing rows that don't exist
  - Dispatch: miscounting manpower quantities (operators, laborers, rakers)
- **Schedule parser** (`schedule.py`):
  - Old: Single-pass with JSON forcing + image parts
  - New: Pass 1 (text mode + thinking_budget=8192) → faithful pipe-delimited transcription with row counts. Pass 2 (JSON mode, text-only) → parse verified text to JSON
  - Added inter-pass logging: text preview, data line count, grand total verification
- **Dispatch parser** (`ai.py`):
  - Old: Single-pass with JSON forcing + PDF file
  - New: Pass 1 (text mode + thinking_budget=8192) → structured text transcription with TOTAL counts per person category. Pass 2 (JSON mode, text-only) → parse to JSON
  - Added empty-response guard (< 50 chars → return empty instead of crashing)
  - `DISPATCH_PARSE_PROMPT` renamed to `DISPATCH_PARSE_PROMPT_LEGACY` (kept for reference)
- Dead ScheduleManager code removed from `ToolsPage.tsx`
- Build + deploy fixes: JSX unclosed div, unused variables, settingsApi import path
- Python syntax ✅, TypeScript/Vite production build ✅, deployed to Railway ✅

### 2026-06-16 — Dispatch Import Resource Matching Fix
- **3 fabricated LE codes removed** (`DispatchImportDialog.tsx`):
  - `LE-141- End Dump` (real LE-141 = JLG Telehandler) → now runs `matcher.match('End Dump Truck')` → matches `LE-23- Super 10 End Dump Truck` or routes to resolution dialog
  - `LE-155- Grinder` (real LE-155 = Trench Roller) → now runs `matcher.match('Pavement Grinder')` → matches `LE-71- Pavement Grinder` or routes to resolution dialog
  - `LE-151- Sweeper` (real LE-151 = Mini Excavator) → now runs `matcher.match('Street Sweeper')` → matches `LE-19- Street sweeper` or routes to resolution dialog
- **Truck drivers → Teamsters** (`DispatchImportDialog.tsx` L225):
  - Changed from `LL-04- Operator` to `LL-11- Teamster` for trucking sub manpower rows
- **Fuzzy matcher made very strict** (`resourceMatcher.ts`):
  - Auto-match threshold raised from `0.70` → `0.95` in 4 locations
  - Only exact matches (1.0), substring matches (0.95), and saved aliases (1.0) auto-apply
  - Everything else routes to the Resource Resolution Dialog for manual selection
- **Alias "remember" system audited** — confirmed working correctly:
  - Resolution dialog → saveResourceAliases() → backend merges → loadResourceAliases() on next dispatch
  - Full chain: UI checkbox → in-memory addAlias() + server persist → reload on next session
- TypeScript zero errors ✅

### 2026-06-22 — Word Export Consolidation + Time Parser + PMWeb Midnight Fix
- **Word export consolidation** (`word.py`):
  - `_process_resource_list` (activity view): Replaced dedup-by-skip with group-by-sum. Resources grouped by `(resource, hours, company, is_rental)`, qty summed. 9 operators with qty=1 → single line `QTY 9`.
  - `_aggregate_for_word` (consolidated table): Same consolidation logic, scoped per-activity.
  - Nameless equipment (rentals): No longer skipped — passes through with blank name.
- **Time parser bug** (`DispatchImportDialog.tsx`):
  - Root cause: `parseTimeToMinutes("8 PM")` returned 0 because regex required a colon. `calcHours("8 PM", "03:30")` → `(210-0)/60 = 3.5 hrs` instead of correct 7.5 hrs.
  - Fix: Added bare hour regex `(\d{1,2})\s*(AM|PM)` as fallback in `parseTimeToMinutes`.
  - Added `cleanTime()` function — strips trailing text like "NIGHT WORK" from time strings. Applied to all 15 `start_time:` assignments in `buildActivity()`.
- **PMWeb extension midnight crossing** (`injected.js`):
  - `txtHours` (duration column) went negative for night shifts crossing midnight (e.g., 7:30 PM → 3:30 AM = -16 hrs).
  - Fix: `if (rawMinutes < 0) rawMinutes += 1440`. Also lowered lunch deduction threshold from ≥7 hrs to ≥5 hrs.
  - `parseTime` in extension also fixed for bare hour formats.
- **Dispatch AI trucking rules** (`ai.py` DISPATCH_JSON_PROMPT):
  - "same trucks load at [time]" = same trucks doing another load, NOT additional trucks. Do not create separate entry.
  - "5 x 1" type notations = travel pay, NOT additional trucks. Ignore entirely.
  - Trucking count = primary count only (e.g., "4 @ 8 PM" = 4 trucks).
  - Example in prompt updated from `count: 5` to `count: 4`.
- **Design clarification**: In-app resource table shows individual rows (each person, qty=1, with name). Consolidation only in Word export + PMWeb.
- TypeScript zero errors ✅, deployed to Railway ✅.

### 2026-06-25 — Grind & Overlay Schedule Support
- **Schedule parser** (`schedule.py`):
  - AI auto-detects schedule type: DIGOUT (has Width/Length columns) vs GRIND_OVERLAY (only SF/Tons/Depth)
  - `schedule_type` field stored in JSON (`'digout'` or `'grind_overlay'`), defaults to `'digout'` for backward compat
  - Pass 1 prompt updated to detect and declare TYPE= on first line
  - Pass 2 prompt updated to set width=0, length=0 for G&O rows
  - Response models, upload, list, active endpoints all return `schedule_type`
- **Types** (`index.ts`):
  - `Schedule.schedule_type: 'digout' | 'grind_overlay'` added
- **buildActivity** (`dispatchHelpers.ts`):
  - New params: `scheduleType`, `stationRanges` (both defaulted for backward compat)
  - G&O summary format: `• Grind & Overlay — Shift 1:\n  STA 10+00 to STA 15+00\n  - WB DO #26 — 0.15' depth — 5,000 SF (375 tons)`
  - Digout summary format: unchanged
  - Stations field populated from station ranges for G&O
- **DispatchImportDialog** (`DispatchImportDialog.tsx`):
  - Detects `schedule_type` from loaded schedule (both getActive and inline upload)
  - Phase 2 table conditionally hides W/L columns for G&O
  - Station Ranges input section appears for G&O: start/stop station pairs with "Add skipped section" button
  - Both buildActivity calls pass `scheduleType` and filtered `stationRanges`
- **ScheduleSection** (`ScheduleSection.tsx`):
  - G&O badge on shift headers
  - W/L columns hidden for G&O schedules
  - Total row colSpan adjusted
- **AutoCreateDialog** (`AutoCreateDialog.tsx`):
  - Passes `detectedScheduleType` to buildActivity (stations empty for auto-create)
- TypeScript zero errors ✅, Vite build ✅, Python syntax ✅.
- **Pending**: Deploy to Railway, rebuild Android APK (Capacitor sync done — APK build still required from Android Studio).

### 2026-06-30 — Android Sync (Catch-Up)
- **Context**: Android APK was last synced on 2026-05-28. Six sessions of frontend changes had never been pushed to Android.
- **Steps taken**:
  - `npm run build` — Vite production build, 1826 modules, TypeScript zero errors ✅
  - `npx cap sync android` — Copied `dist/` → `android/app/src/main/assets/public` ✅
- **Changes now in the Android project** (pending APK build in Android Studio):
  - Dispatch + Schedule Import (DispatchImportDialog, ScheduleSection, schedule router)
  - Resource Resolution Dialog + collapsible tables + alias system
  - Two-pass AI fix for schedule parser + dispatch parser (Landmine #6 pattern)
  - Resource matching fixes (Teamsters, 0.95 strict threshold, 3 fabricated LE codes removed)
  - Word export consolidation + time parser fix + PMWeb midnight crossing fix
  - Grind & Overlay schedule support
- **Next**: Open `frontend/android/` in Android Studio → Build APK(s) → install on device.

### 2026-07-01 — Custom Resource Codes in Settings
- **Problem**: Resource table dropdowns were hardcoded to 39 labor (LL-) + 149 equipment (LE-) codes from `constants.ts`. The existing "Master Lists" tab in Settings stored generic names ("Excavator", "Laborer") but was completely disconnected from the dropdowns — dead feature.
- **Backend** (`settings.py`): Added `custom_resource_codes: { labor: [], equipment: [] }` to `DEFAULT_SETTINGS`, new `CustomResourceCodes` Pydantic model, added field to `SettingsPayload`.
- **Frontend types** (`settingsApi.ts`): Added `CustomResourceCodes` interface and `custom_resource_codes` field to `AppSettings`.
- **Settings UI** (`SettingsPage.tsx`): Replaced dead "Master Lists" tab → new **"Resource Codes"** tab. User types a description (e.g., "Grade Checker"), code auto-assigns next available number (LL-40, LE-161, etc.). Shows count of built-in + custom codes. TagList for removal.
- **ResourceTable** (`ResourceTable.tsx`): Loads custom codes from settings on mount via `settingsApi.get()` and merges with `DEFAULT_MANPOWER` / `DEFAULT_EQUIPMENT` arrays. Custom codes appear at the end of the dropdown.
- **ResourceResolutionDialog** (`ResourceResolutionDialog.tsx`): Same merge pattern — loads custom codes in parent, passes merged `pool` prop to `ResolutionItem` instead of hardcoding.
- **ResourceMatcher** (`resourceMatcher.ts`): `loadResourceAliases()` now also loads custom codes, invalidates the cached matcher, and rebuilds with extended pool. AI-dictated entries can fuzzy-match to custom codes.
- TypeScript compiles cleanly with zero errors. Deployed to Railway + Android synced.

### 2026-07-02 — Chrome Extension PMWeb Resource Sync
- **Feature**: Added "Sync PMWeb Resources" to the Chrome Extension to scrape all Labor and Equipment codes from PMWeb and automatically append them to `custom_resource_codes` in the app.
- **Extension UI** (`popup.html` & `popup.js`): Added "Find New PMWeb Resources" button in settings sync section. Injects worker into `MAIN` world and triggers sync via custom event.
- **Extension Extraction** (`injected.js` & `content.js`): `PMWEB_SYNC_TRIGGER` listener finds the Telerik `ddlResources` combo box, calls `requestItems('', false)` to load all from server, extracts the text, and sends back `PMWEB_SYNC_RESULT` via `window.postMessage` bridge.
- **Backend API** (`settings.py`): New endpoint `POST /api/settings/sync-pmweb-resources`. Separates `LL-` and `LE-` prefixes and deduplicates them using `list(dict.fromkeys())`.
- **Frontend UI Deduplication**: Wrapped merged array building with `Array.from(new Set(...))` in `ResourceTable.tsx`, `ResourceResolutionDialog.tsx`, and `resourceMatcher.ts` to ensure users don't see duplicates in dropdowns when PMWeb scraped codes perfectly match `DEFAULT_MANPOWER`/`DEFAULT_EQUIPMENT`.
- **Telerik Pagination Fix (Added)**: Modified `injected.js` to automatically click the "Add" button if needed, and loop `combo.requestItems('', true)` to paginate through all items, bypassing the 20-item load-on-demand limit.
- **Backend Delta Counting (Added)**: `settings.py` now filters incoming codes against `BUILTIN_LABOR` and `BUILTIN_EQUIPMENT` before appending, so it only counts and returns the number of *truly new* items added.
- TypeScript builds cleanly ✅. Deployed to Railway ✅.

### 2026-07-17 — Report Chat Merge Architecture (Anti-Data-Loss)
- **Root cause**: Report chat prompt told Gemini to "return the FULL activities array in modified_activities." The model had to reproduce ALL manpower/equipment rows across ALL activities — even ones the user didn't ask to change. Models are bad at faithful JSON reproduction, so it dropped equipment, manpower, and hallucinated entries.
- **Backend prompt rewrite** (`ai.py` lines 1421–1505):
  - Changed from "return full array" to **surgical diff-based updates**
  - `modified_activities` now contains ONLY the activities being changed, with ONLY the changed fields, keyed by `id`
  - Sub-arrays (manpower, equipment) are only included if the user's change affects them
  - New `new_activities` array for brand new activities (separate from modifications)
  - New `deleted_activity_ids` array for removals
  - Strong "ask, don't guess" instructions for ambiguous requests
- **Backend response model** (`ReportChatResponse`): Added `new_activities` and `deleted_activity_ids` fields
- **Frontend API types** (`api.ts`): Added `new_activities` and `deleted_activity_ids` to return type
- **Frontend merge logic** (`ReportChat.tsx`):
  - Replaced `replaceActivities(fullArray)` with surgical per-activity merges
  - `modifiedActivities` → loops through patches, calls `updateActivity(id, partialUpdates)` for each
  - `newActivities` → calls `addActivity()` for each
  - `deletedActivityIds` → calls `removeActivity(id)` for each
  - All three store methods already existed — no store changes needed
  - Updated `PendingChanges` interface, both send flows (text + voice), and the preview card
- **Not affected**: `AIReportAssistant.tsx` (uses separate `/api/ai/activity-manager` endpoint, already does partial updates)
- TypeScript builds cleanly ✅.
- **Pending**: Deploy to Railway. Gemini 2.5 Pro retiring Oct 16, 2026 — will need to upgrade to 3.1 Pro eventually.

### 2026-07-17 — Email Summary Feature
- **New endpoint** `POST /api/ai/email-summary` in `ai.py`:
  - Takes all activities + project name + report date
  - Combines all activity summaries into one flowing paragraph-form narrative
  - Rules: preserve ALL content (no shortening), no headers/bullets (email body form), no greetings/sign-offs, professional construction tone
  - Uses `_gemini_call_with_retry()` for resilience
- **New API method** `scanApi.emailSummary()` in `api.ts`
- **New component** `EmailSummaryDialog.tsx`:
  - Auto-generates on mount
  - Copy to clipboard (with fallback for mobile/insecure contexts)
  - Regenerate button
  - Loading state with pulse animation
- **Button placement**: ActivityList header bar, between Dispatch and Import buttons
  - Only shows when `activities.length > 0`
  - Label: "📧 Email Summary"
- TypeScript builds cleanly ✅.

### 2026-07-20 — PMWeb Full Automation (1-Click Auto-Fill)
- **Problem**: Filling PMWeb required manually pressing 5 different buttons across 5 different tabs, risking data mismatch and requiring tedious navigation.
- **Backend changes (`export.py` & `word.py`)**:
  - `generate_notes_html()` created in `word.py` to strip tables and generate pure HTML for the Notes tab.
  - Added endpoints `/api/export/{id}/notes-html` and `/api/export/{id}/pmweb-full`. 
  - `/pmweb-full` bundles all 5 phases of report data into a single payload, doing inline activity consolidation.
- **Chrome Extension UI (`popup.html` & `popup.js`)**:
  - Replaced the multi-button layout with a single "🚀 Auto-Fill Everything" orchestrator button.
  - Added visual progress states and a Monday auto-detection banner.
  - Added logic to automatically save and auto-increment the Record # on successful completion.
- **Extension Orchestrator (`injected.js`)**:
  - Added a massive `PMWEB_FILL_EVERYTHING` event listener orchestrating all 5 phases.
  - Includes robust helpers for navigating tabs, handling Telerik datepickers/comboboxes, and injecting HTML notes into the RadEditor iframe.
- Tested compilation locally, deployed to Railway ✅.

### 2026-10-11 - PMWeb Day Type (Claude Code, MCN reconstruction session)
- `chrome-extension/core.js`: new `pmwebDayType` decides the Additional Information Day Type from the report date, the City holiday list and the run's shift; `buildFullPayload` uses it and logs the value and reason. Before this the Day Type came from `export.py`'s `is_working_day = weekday < 5`, which entered holidays as Working Day and Sunday nights as Non-Working Day.
- Terry's rule, 2026-10-10: Saturday, daytime Sunday or holiday is Non-Working Day; approved 2026-10-11.
- Tested with node (37 cases) and two independent reviews (every date 2024-2032 on all shifts; popup, side panel, queue). Not committed. Reload the extension and refresh open PMWeb tabs.

### 2026-10-11 - Two older extension faults (Claude Code, MCN reconstruction session)
- Found in the review of the Day Type change; Terry said yes to fixing them. Two separate fixes, neither committed.
- **A refused report pick**: `core.js` `setContextReport` now throws on a non-OK response before recording the pick or dropping fetched rows. `popup.js` `selectReport` shows the error with `alert` and returns false; `runQueueNext` returns when it is false. `panel.js` unchanged: its `selectReport` already let errors out to `busy()`, which shows them. See landmine 21.
- **Phase 4 Day Type**: `injected.js` adds `comboSelectedText` and reads the Day Type back after `setComboBox`, up to three times half a second apart (a postback may be redrawing the box), and compares the selected item's text for equality after collapsing spaces and case. What the box holds decides it, not `setComboBox`'s return. A box that cannot be read back or holds another value, or a missing Update Records button, goes into `problems`: the queue marks the entry "check it", the side panel's status line lists it, and the console prints it. `pmAlert` only logs while `window.__pmUnattended` is true, its default. A read that throws counts as unread and the run goes on to Update Records and the Notes. See landmine 20.
- Not covered: nothing confirms PMWeb saved the Day Type after Update Records; the read-back runs before the click.
- Tested with node against the real files: 50 checks (refused pick on 401/403/500 and a network failure; accepted pick; popup and side panel queues; twelve Phase 4 cases, including a read that throws, a box found only on the second ask and a look-alike "11 -Working Day"). An independent review found no defect introduced and listed the gaps above, which were then closed except the save confirmation. Not tested on a live PMWeb page. Reload the extension and refresh open PMWeb tabs.
- Found in that review, older than these fixes and not changed: the side panel's Auto-Fill Everything, Fetch and Fill buttons read the app's report context at the click, and the web app moves that context whenever a report is opened or saved in the app (PC or phone), so a manual run can fill PMWeb from a report other than the one the panel shows. The queues re-send the pick before each run and are protected. The popup's in-memory rows survive a new pick; stored activities carry no report stamp; the popup queue entry can stick at "running"; a double-click on the popup's Run starts two runs.

### 2026-10-13 - Short work areas, several companies, Attach photos (Claude Code, MCN reconstruction session)
- **Backend, deployed** (`main` 9143d34 and 25326f9, Railway rebuilt from `main`): the PMWeb export read every work area by position, so "AR Concrete - curb ramps and concrete flatwork" went into PMWeb with "AR Concrete" in Location and Company and Activities blank (1/06 and 1/07/2026). `split_work_area` now reads it (landmine 24). Terry approved the fix and the push ("ok"), then the first-company rule. Tested: `test_work_area_split.py` 22 checks; `test_extension_context`, `test_word_export`, `test_no_consolidation`, `test_resource_lookup`, `test_shift_times`, `test_parse_report` all pass; across the 359 activities of the rebuilt reports 285 split as before and the 74 that change are the 55 two-part work areas and 19 multi-company or misspelled company parts. Proved in PMWeb on record 1314 (1/12/2026): the AR Concrete row went in with Company "AR Concrete" and the description in Activities.
- **Extension, not committed** (this branch, loaded unpacked from disk): `injected.js` takes an empty location from the description (`pmPlacesNamed`); `panel.js` "Attach photos"; new `background.js`; `manifest.json` 2.3 (background worker, `token-sync.js` excluded from port 8765). See landmine 25. An adversarial review (three lenses, then a verifier per finding) found three real faults, all fixed before use: `token-sync.js` clearing the token on a photo-server page, a second photo server binding the same port on Windows, and the date check reading an unsaved Report Date. Two low ones were fixed as well (Stop before a group is handed over; refusing to start during a fill). Its paging concern was refuted on the live page (the Attachments grid's page size is 250); a guard stops the run if the tab count ever exceeds the rows shown.
- Reload the extension in `chrome://extensions` and refresh open PMWeb tabs after these changes.
- Attach photos proved live on record 1410 (5/11/2026): 10 photos sent and found on the Attachments grid by name in about 20 seconds.


### 2026-10-20 — Morena Pipelines Multi-Activity Export & Guided Interview
- **Root Cause (`word_tecolote.py` & `word.py`)**:
  - When "Walk me through it" (`GuidedInterview`) was used for Activity 1 and "Dictate" (`BulkDictateButton` / `ActivityEditor`) was used for Activity 2, `_section_body()` in `word_tecolote.py` returned early from `report.interview.composed` (which only held Activity 1) and never read `report.activities`, dropping Activity 2's narrative from Section 1 even though Sections 7 & 8 rolled up its crew and equipment.
  - `build_report_preview()` in `word.py` used `get_profile(gen.get("project_name"))` instead of `profile_for_report(report)`.
- **Fixes Applied**:
  - `backend/app/services/word_tecolote.py`: Prints the day-level header once at the top (`Construction Daily Progress Report`, `Report Date`, `Resident Engineer (RE) Arrival Time`, `Contractor`, `Weather`), then prints **each activity as its own separate block** starting with the **Activity Title** at the top of that activity, followed by that activity's own sections `1.` through `8.` (narrative sections `1..6`, `7. Labor Force Tracking` for that activity's crew, and `8. Equipment Log` for that activity's equipment).
  - `frontend/src/components/report/ReportPreview.tsx`: Renders each activity's title header (`is_activity_header`) above its sections `1..8`.
  - `backend/app/services/word.py`: `build_report_preview()` now uses `profile_for_report(report)`.
  - `backend/app/services/report_profiles.py`, `backend/app/routers/interview.py`, `backend/app/routers/ai.py`: Renamed `TECOLOTE_SECTIONS` / `TECOLOTE_EQUIPMENT_GROUPS` to `MORENA_PIPELINES_SECTIONS` / `MORENA_PIPELINES_EQUIPMENT_GROUPS` (keeping aliases for backward compatibility) and added `more_activities` gate + repeating `additional_activity` section (`number=0`) so "Walk me through it" on Morena Pipelines can capture multiple activities/crews per shift.
  - `frontend/src/lib/interviewApi.ts`, `frontend/src/lib/reportFlow.ts`, `frontend/src/components/report/GuidedInterview.tsx`, `frontend/src/components/report/InterviewSummary.tsx`: Added section-level `gate` support in `GuidedInterview`, filtered `number > 0` in `InterviewSummary`, and updated `buildDayActivity()` in `reportFlow.ts` to materialize each additional interview activity (`interview_pass: 2, 3, ...`) alongside Activity 1 and any dictated/manual activities.
- **Verification**: `test_word_export.py` (35/35 passed), `test_composer.py` (34/34 passed), `npm run build` (`tsc -b && vite build` clean).

### 2026-10-23 — Fix Cross-Project Interview Answer Bleed & Station/Time Edge Cases
- **Root Cause (`NewReportPage.tsx` & `interview.py`)**:
  1. When starting a second report on `/report/new` after finishing a previous report in the same session, `NewReportPage.tsx` reset `useReportStore` (`closeReport()` / `newReport()`) but never cleared its local `answers`, `answerRows`, `profileKey`, `flowStage`, or `jumpTo` state. Also, `useEffect([report?.id])` returned early when `!report?.id` (`''`) instead of clearing `answers` / `answerRows`.
  2. In `backend/app/routers/interview.py` (`compose_report`), `everything` dumped every key in `request.answers` into `EVERY ANSWER GIVEN TODAY`, even keys belonging to a different project profile (`morena`'s `locations`, `stations`, `summary`, `traffic_control_detail`, `anything_missed`), causing Gemini to merge Morena Conveyance North facts into Morena Pipelines Section 1.
  3. In `frontend/src/lib/reportFlow.ts`, `firstLine()` did not ignore `"NA"` / `"N/A"`, producing `"CTS conduit trench to NA"`, and `shiftHours()` treated a stop time without AM/PM (e.g. `"11:45"` after `"9:00 PM"`) as `11:45 AM` the next day (`14.75` hours instead of `2.75` hours).
- **Fixes Applied**:
  - `frontend/src/pages/NewReportPage.tsx`: Reset `flowStage`, `profileKey`, `jumpTo`, `showPreview`, `answers`, and `answerRows` whenever navigating to `/report/new` (tracking `location.key`), when `!report?.id`, when clicking `Start another report` in `ResumeOrStart`, and when picking a project in `ProjectPicker`. Restricted legacy `locations` seeding to `morena` profile only.
  - `backend/app/routers/interview.py`: Filtered `everything` in `compose_report` to only question IDs belonging to the active profile's composed sections (`valid_qids`) and stripped `"NA"` / `"N/A"` / `"none"` values.
  - `frontend/src/lib/reportFlow.ts`: Filtered `"NA"` / `"N/A"` / `"none"` in `firstLine()` and inferred AM/PM when `stop` omits meridiem.
  - Cleaned up `2026-10-23` Morena Pipelines report (`6ed0c55d-eda1-4240-9c59-6c338126eb5c`) on Railway and verified via `/api/export/6ed0c55d-eda1-4240-9c59-6c338126eb5c/preview`.
- **Deployed**: Committed and pushed to `main` (`fb42340`).

### 2026-10-23 — General Notes in Morena Pipelines Export/Preview & Form Remount Fix
- **Root Cause (`word_tecolote.py`, `reportStore.ts`, `NewReportPage.tsx`)**:
  1. `word_tecolote.py` (`build_tecolote_content` / `generate_tecolote_document`) never included `gen.get('notes')` (`General Notes`), so General Notes was omitted from both the Morena Pipelines Word export and `ReportPreview`.
  2. `GeneralInfoForm.tsx` uses `defaultValue={gen.notes}` for IME swipe-typing compatibility, and `NewReportPage.tsx` keyed `<GeneralInfoForm>` only by `revision` (which `loadReport` in `reportStore.ts` did not increment), causing the textarea to appear blank or stale after a refresh/load edge case.
- **Fixes Applied**:
  - `backend/app/services/word_tecolote.py`: Added top-level `General Notes` section (`number: 0`, `title: "General Notes"`) right after the header and before Activity 1 whenever `gen.get("notes")` is non-empty, and updated `generate_tecolote_document` to render `number=0` headings without a `"0. "` prefix.
  - `frontend/src/stores/reportStore.ts`: Incremented `revision` inside `loadReport` so `defaultValue` inputs always remount with loaded server data.
  - `frontend/src/pages/NewReportPage.tsx`: Included `report.id` in `<GeneralInfoForm key={`gen-${report.id}-${revision}`} />` and `<ActivityList key={`act-${report.id}-${revision}`} />`.
  - Updated `6ed0c55d-eda1-4240-9c59-6c338126eb5c` on Railway to replace `"Marina Boulevard"` with `"Morena Boulevard"` in `general.project_location` and `general.notes`.
- **Deployed**: Committed and pushed to `main` (`b2f2c6e`).

### 2026-10-28 — Guided Interview ("Walk me through it") Full Report Composition for Morena Conveyance North & Morena Pipelines
- **Root Causes (`interview.py`, `reportFlow.ts`, `GuidedInterview.tsx`, `NewReportPage.tsx`, `InterviewSummary.tsx`)**:
  1. `materializeActivities()` in `frontend/src/lib/reportFlow.ts` completely ignored `composed` when building activities for repeating-location profiles (`morena` / Morena Conveyance North), pasting raw `summary`, `traffic_control_detail`, and `anything_missed` answers verbatim into `activity.summary` and dropping `start_time`, `stop_time`, `traffic_control_removed`, and `day_close` answers (`extra_detail`, `visitors`, `day_missed`).
  2. `compose_report()` in `backend/app/routers/interview.py` did not expand repeating location passes (`location:1`, `location:2`, ...) for `morena`, did not pass `shift_start` / `shift_end` to Section 1 (`work_summary`) on `morena_pipelines`, and skipped `additional_activity` (`number=0`) passes on `morena_pipelines`.
  3. In `GuidedInterview.tsx`, clicking `Finish` on the last question called `await commit(draft)` followed immediately by `await onComplete()`, which read the stale `answers` / `answerRows` closures in `NewReportPage.tsx` before React re-rendered, dropping the final question's answer from `/api/interview/compose`.
  4. `InterviewSummary.tsx` rendered expanded at the top of the report editor, displaying raw Q&A answers verbatim above the composed report.
- **Fixes Applied**:
  - `backend/app/routers/interview.py`: Updated `compose_report()` to expand repeating location passes (`location:1`, `location:2`, ...) and `day_close` (`general_notes`) for `morena` (Morena Conveyance North), include `shift_start` / `shift_end` and `extra_activity:N` passes for `morena_pipelines` (Morena Pipelines), respect `question.gate` values, and place `Start Time:` / `End Time:` lines at the top of each composed activity via `with_opening_times()`.
  - `frontend/src/lib/reportFlow.ts`: Updated `materializeActivities()` to populate each `morena` location activity's `summary` from `composed["location:N"]` (cleaned with `cleanSummaryBullets`) and updated `buildDayActivity()` to populate `morena_pipelines` additional activities from `composed["extra_activity:N"]`.
  - `frontend/src/components/report/GuidedInterview.tsx` & `frontend/src/pages/NewReportPage.tsx`: Returned `{ nextAnswers, nextRows }` from `commit()` and passed them directly into `onComplete(finalAnswers, finalRows)` so the last question's answer is always included in composition; applied `general_notes` and shift start/end times to `report.general`; and ensured exiting to the editor after answering questions also runs composition.
  - `frontend/src/components/report/InterviewSummary.tsx`: Made `InterviewSummary` a collapsed-by-default drawer (`"Interview answers (N answered)"`) and added multi-pass display for repeating location questions.
- **Verification**: `test_word_export.py` (43/43 passed), `test_composer.py` (34/34 passed), `npm run build` (`tsc -b && vite build` clean).

### 2026-11-02 — Main Command-Center App Dashboard, Tasks/Reminders, 2-Hour AI Meeting Note-Taker & Email Assistant
- **What Was Built**:
  1. **Main Application Command-Center Dashboard (`/`, `frontend/src/pages/AppDashboardPage.tsx`)**:
     - App starts on the top-level Command Center Dashboard (`/`), while the Daily Reporting Dashboard lives at `/reporting` (`frontend/src/pages/DashboardPage.tsx`).
     - Every major module on the Command Center Dashboard expands in-place (`▾`) to display live insights, previews, or interactive tools:
       - **Daily Reporting (`/reporting`)**: Today's report status, activity count, recent reports table, and 1-click launch buttons (`Today's Report`, `Talk It Through`, `Backfill`, `Report History`).
       - **Tasks, Reminders & AI Meeting Note-Taker (`/tasks`)**: Quick-add scheduled task/meeting bar with natural-language date/time parsing, active tasks list, and aggregated open follow-up checklist items.
       - **Email Assistant & Outlook Connection (`/email`)**: Embedded AI email composer, saved drafts count, and 1-click Outlook/Mail launch.
       - **Smart PDF Spec & Drawing Search (`/pdf-search`)**: Indexed PDF count, document pills, and inline AI question bar.
       - **Field Calculators (`/tools`, `/calculators`)**: Standalone calculators (`Pipe Water Volume`, `Excavation CY`, `Concrete Calculator`, `Unit Converter`) + inline mini calculators on the dashboard.
       - **Project Trackers (`/trackers`)**: Live counts for Excavation entries, Pay Items, Open Punch List items, and Pending Redlines.
       - **Settings (`/settings`)**: Default project, RE/Inspector, shift hours, vocabulary count, and AI connection status.
  2. **Scheduled Tasks, Phone Notifications & 2-Hour AI Meeting Note-Taker (`backend/app/routers/tasks.py`, `frontend/src/pages/TasksPage.tsx`, `frontend/src/lib/notifications.ts`, `frontend/src/lib/meetingAudioStore.ts`)**:
     - Per-user storage in `data/users/<user-id>/tasks/<task-id>/task.json` + recorded audio files (`paths.py`: `tasks_dir()`).
     - Natural-language schedule extraction (`parse_natural_schedule`): typing e.g. `"Meeting with traffic department tomorrow at 11:00AM"` automatically populates `scheduled_date` and `scheduled_time = "11:00"`.
     - Phone notifications via `@capacitor/local-notifications` (synced into `frontend/android` with `POST_NOTIFICATIONS` and `SCHEDULE_EXACT_ALARM` in `AndroidManifest.xml`) + Web Notification API / in-app alert banner on Desktop/Web.
     - 2-hour (`7,200` seconds) `MediaRecorder` audio capture flushing 10-second chunks to IndexedDB (`dr_v3_meeting_audio_db` in `meetingAudioStore.ts`) so screen locks or refreshes never lose recorded audio.
     - Two-pass Gemini AI processing (`POST /api/tasks/{task_id}/process-meeting`, obeying Landmine #6: Pass 1 uploads audio via `client.files.upload` and runs in plain-text mode; Pass 2 runs in JSON mode) producing:
       - **Part 1**: Checkable `checklist` (follow-up items) + `structured_notes` (`overall_goal`, `what_took_place`, `important_quantities`, `follow_up_items`, `outcome`, `additional_useful_notes`).
       - **Part 2**: Formatted Daily Report Activity (`work_area`, `stations`, `summary`) + `POST /api/tasks/{task_id}/send-to-report` which appends/updates the activity in that day's report if one exists, or automatically creates a new report for that date (seeded with `settings.json` defaults) and adds the activity to it.
  3. **Email Assistant & Outlook Connection (`backend/app/routers/email_assistant.py`, `frontend/src/pages/EmailPage.tsx`)**:
     - AI email drafting (`POST /api/email/generate`) from a Task/Meeting, a Daily Report, or a custom prompt.
     - Saved contacts (`contacts.json`) and saved drafts (`drafts.json`) per user in `emails_dir()`.
     - Direct handoff to **Outlook Desktop** (`POST /api/email/export-eml` generating an RFC-5322 `.eml` file with `X-Unsent: 1` that opens as an editable compose window in Windows Outlook), **Outlook 365 Web** (`outlook.office.com/mail/deeplink/compose`), **Gmail Web**, **Phone/Default Mail App** (`mailto:`), and optional SMTP (`POST /api/email/send-smtp`).
- **Verification**: Backend unit & integration tests verified (`parse_natural_schedule`, `create_task`, `send_task_to_report_endpoint` auto-create + idempotent update, `export_eml_draft`), `npm run build` (`tsc -b && vite build` clean, 0 errors), and `npx cap sync android` completed.


### 2026-11-06 — Rebuilt Reports Push to Live App + PMWeb 107-Record Automated Batch Refile (`chrome-extension/injected.js`, `chrome-extension/panel.js`)
- **What Was Done**:
  1. **Live Daily Reporter App (`https://residentengineerassistant-production.up.railway.app`)**:
     - Pushed all 146 corrected MCN reports (`146 succeeded, 0 failed`) and deleted the 3 duplicate reports (`3/3 deleted`).
  2. **PMWeb Chrome Extension (`chrome-extension/injected.js`, `chrome-extension/panel.js`)**:
     - Embedded `GOOD_NOTES_BY_DATE` (all 107 corrected HTML notes) and `MASTER_REFILE_LIST` (all 107 bad PMWeb reports: 99 `COPY` records + 8 `INPLACE` Drafts) directly into `chrome-extension/injected.js`.
     - Fixed `triggerCopyRecord()` on Telerik `RadToolBarSplitButton`: calling `.click()` or `fireMouseClick()` with `clientX=0, clientY=0` on `.rtbChoiceArrow` / `.rtbSplBtnActivator` caused Telerik to invoke the parent `New (Alt+n)` command instead of `Copy`. Updated `triggerCopyRecord()` to open the split dropdown via `it._showDropDown()` + real-coordinate `MouseEvent` on `.rtbChoiceArrow` and click `a.ToolbarButtonCopy` (`span.rtbText`) with real bounding-box `clientX, clientY` coordinates.
     - Fixed `currentPmUrlId()` to verify `/DailyReports\.aspx/i.test(location.pathname)` so `/PMWeb/ErrorPage.aspx?Id=19006` is never mistaken for a Daily Report record ID.
     - Executed the complete 107-record Batch Refile in PMWeb (`107 / 107` verified in `__pmwebRefileDone`: 99 copied into clean Drafts with corrected notes and original Report Dates while withdrawing the originals, plus 8 `INPLACE` Drafts updated with corrected notes and normalized Record #s).
- **Known Landmines Added**:
  - **Telerik `RadToolBarSplitButton` (`Copy` vs `New`)**: Never call bare `.click()` or dispatch `MouseEvent` with `clientX=0, clientY=0` on `.rtbSplBtnActivator` or `.rtbChoiceArrow` — Telerik hit-tests the coordinates against the split arrow and falls back to the main button (`New`). Always open via `it._showDropDown()` and dispatch `MouseEvent` with real `getBoundingClientRect()` coordinates on `a.ToolbarButtonCopy`.
  - **`Withdrawn` Originals Hold Base `Record #` Until Admin Deletion**: Because Terry's PMWeb role cannot hard-delete `Withdrawn` records, each `Withdrawn` original continues holding its base `Record #` in PMWeb until an administrator deletes the `Withdrawn` originals. New Draft copies must save with `v2` / `v3` while the `Withdrawn` original exists; attempting to save the base `Record #` without `v2` while the `Withdrawn` original still exists causes PMWeb to redirect to `/PMWeb/ErrorPage.aspx?Id=19006`.
  - **Never Auto-Resume on `/PMWeb/Default.aspx`**: PMWeb's outer shell (`/PMWeb/Default.aspx`) shares `sessionStorage` with its inner content frame (`SearchDocument.aspx` / `DailyReports.aspx`). `maybeResumeAfterReload()` in `injected.js` is restricted to `DailyReports.aspx` and `SearchDocument.aspx` so `Default.aspx` never clears `__pmwebRefileState` or sets `__pmwebRefileStopped`.

### 2026-11-06 (Part 2) — Orphan `11/6/2026` Cleanup, "Submit All Draft Reports" Button & Local Agent Command Bridge
- **What Was Built (`chrome-extension/injected.js`, `chrome-extension/panel.js`, `chrome-extension/popup.html`, `chrome-extension/popup.js`, `chrome-extension/background.js`)**:
  1. **Version 8 Cleanup Queue (`injected.js`)**:
     - Fixes `Id=128932` (`1285 Day`, `origId=123938`) by saving its `Main` tab with `Record # = '1285 Day v2'` and `Report Date = '11-26-2025'`, writing its clean `2025-11-26` note, and withdrawing `123938`.
     - Fixes `Id=128946` (`1303.1 Day`, `origId=124329`) by saving its `Main` tab with `Record # = '1303.1 Day v2'` and `Report Date = '12-24-2025'` and writing its clean `2025-12-24` note.
     - Cleans up the 22 orphan duplicate `11-06-2026` Draft copies (`128914`, `128915`, `128917`–`128931`, `128938`, `128961`, `128988`, `128991`, `128992`) by deleting each record or, if PMWeb refuses deletion, renaming it `DUP-DEL-<id>` (`01-01-2020`) and withdrawing it on the `Workflow` tab, while leaving the real `1296 Day v3` (`Id=128916`, `12-15-2025`) untouched.
  2. **"Submit All Draft Reports" & "Submit This Draft Report" Buttons (`panel.js`, `popup.html`, `popup.js`, `injected.js`)**:
     - Added **"Submit All Draft Reports"** (with confirmation and progress reset) and **"Submit this Draft report"** to both the PMWeb side panel (`panel.js`) and the toolbar popup (`popup.html` / `popup.js`).
     - Added `submitOnPage()` and the `processSubmitDraftsStep()` state machine (`__pmwebSubmitDraftsState` / `__pmwebSubmitDraftsDone`) in `injected.js` to iterate through all 107 refiled Draft daily reports (`KNOWN_DRAFT_COPY_BY_ORIG` + `__pmwebRefileDone` + any visible `Draft` rows on `SearchDocument.aspx`) and submit each Draft through the `Workflow` tab.
  3. **Local Agent Command Bridge (`background.js`, `panel.js`)**:
     - Added `PMWAP_AGENT_POLL` in `background.js` and a 3-second poll on `DailyReports.aspx` / `SearchDocument.aspx` in `panel.js` to `http://127.0.0.1:8766/agent-cmd` so Antigravity can trigger extension actions and navigations directly once the extension is reloaded in `chrome://extensions`.


### 2026-11-18 — Resident Engineer / Field Inspector Voice Overhaul, Deterministic Prose Cleaner & Open-Source Narrative Model Pipeline
- **Root Causes Identified**:
  1. Prompts across `ai.py` (`CONSTRUCTION_VOCAB`, `STANDARD_EXTRACTION_RULES`, `DICTATION_SYSTEM_PROMPT`, `ai_rewrite`, `generate_report`, `bulk_parse`, `transcribe_smart`), `interview.py` (`HOUSE_STYLE`), `backfill.py`, `tasks.py`, and `email_assistant.py` either primed Gemini with parenthetical definitions (`BMPs (Best Management Practices)`, `CLSM (Controlled Low-Strength Material)`) or instructed third-person/impersonal phrasing (`No first person`), causing the model to output legal parentheticals (`seven (7)`, `cathodic protection (CP)`, `12:00 AM (midnight)`), stiff corporate verbs (`commenced`, `utilized`, `to identify items needing remediation`), and third-person self-references (`The inspector visited...`, `The Resident Engineer...`).
  2. `_other_day_context()` in `backend/app/routers/ai.py` injected `"No report exists for YYYY-MM-DD."` directly into the prompt without warning that it was an internal lookup note, causing the model to copy `"No report exists for 2026-11-09."` verbatim into `general_notes`.
- **Fixes Applied & Deployed (`main` commit `b74e730` → Railway `Resident_Engineer_Assistant`)**:
  1. **`backend/app/services/summary_format.py`**:
     - Added shared `INSPECTOR_VOICE_RULES` (zero parentheses inside the prompt text to obey the Anti-Priming Rule; enforces first-person `"I"` / active-verb Resident Engineer perspective for Terry's own inspections/walks/meetings vs. company name / `"The crew"` for contractor work, plain digit quantities, bare standard acronyms, `wacker` / `vibratory plate` compaction terms, zero source meta-talk, and plain field language with verbatim MCN report examples).
     - Added deterministic post-processor `clean_inspector_prose(text, where)` with diagnostic logging that strips leaked `"No report exists for YYYY-MM-DD"` notices, legal number parens (`seven (7)` -> `7`), clock parens (`12:00 AM (midnight)` -> `12:00 AM`), acronym expansion parens, trailing alias tags (`cathodic protection (CP)` -> `cathodic protection`), third-person `"The inspector..."` / `"The Resident Engineer..."` self-references (while preserving named outside specialty inspectors like `"The San Diego Electrical Inspector"` and `"Kleinfelder inspector"`), timesheet/photo meta-talk (`"The timesheet records that..."`), passive `"A walkthrough was conducted"` -> `"Walked the site"`, stiff corporate words + compaction terms (`jumping jack tamper` -> `wacker`, `vibratory plate compactor` -> `vibratory plate`), and remaining prose `( )` clauses while leaving Digout Schedule rows (`(172.58 tons)`) and code citations (`1535(b)`) untouched.
  2. **Wired Across Every Narrative Endpoint**:
     - `backend/app/routers/ai.py`: Updated `STANDARD_EXTRACTION_RULES`, `_clean_summary_bullets`, `_other_day_context`, `CONSTRUCTION_VOCAB`, `DICTATION_SYSTEM_PROMPT`, `scan_notes`, `transcribe`, `transcribe_smart`, `generate_report`, `activity_manager`, `report_chat`, `email_summary`, `FORMAT_REWRITE_PROMPT`, `ai_rewrite`, `PROOFREAD_SYSTEM_PROMPT`, `bulk_parse` (and `/bulk-dictate-activities`), `update_activity`, and `TC_GENERATION_PROMPT`.
     - `backend/app/routers/interview.py` & `backend/app/services/composer.py`: Updated `HOUSE_STYLE`, `COMPOSE_PROMPT`, `answer_question`, `compose_report`, and `_write_prose`.
     - `backend/app/routers/backfill.py`, `backend/app/routers/tasks.py`, `backend/app/routers/email_assistant.py`: Injected `INSPECTOR_VOICE_RULES` and `clean_inspector_prose`.
  3. **Dedicated Open-Source / Fine-Tuned Narrative Model Support (`backend/app/core/config.py`, `backend/app/services/narrative_model.py`)**:
     - Added optional `NARRATIVE_API_BASE`, `NARRATIVE_API_KEY`, `NARRATIVE_MODEL`, and `NARRATIVE_SECOND_PASS` config variables.
     - Keeps Pass 1 multimodal tasks (audio transcription + PDF/timesheet OCR) on Gemini (`gemini-3.6-flash`), while allowing pure narrative endpoints (`/rewrite`, `/generate-report`, `/email-summary`) and Pass 2 narrative polishing (`/bulk-parse`, `/transcribe-smart`, `/transcribe`, `composer`, `interview`) to run on a free local Ollama fine-tuned GGUF (`http://127.0.0.1:11434/v1`), Groq free tier (`https://api.groq.com/openai/v1`), or Fireworks serverless LoRA — with automatic logged fallback to Gemini when unset or unreachable.
  4. **Offline Fine-Tuning Dataset Builder & Unsloth QLoRA Training Kit (`$0.00` cost)**:
     - `backend/scripts/build_inspector_dataset.py`: Extracted **221 unique MCN daily reports** (`74` DRB-audited rebuilt JSON reports + `147` non-overlapping 2025/2026 `.docx` reports, `653` activities) into **1,407 ChatML examples** (`1,267` train + `140` val in `training_data/inspector_voice_train.jsonl` and `inspector_voice_val.jsonl`, gitignored) with `0` target cleanliness violations and `0` OneDrive cloud-stub hydrations.
     - `training_data/Train_Terry_Inspector_Voice_Colab.ipynb`, `training_data/train_unsloth_colab.py`, & `training_data/Modelfile.ollama`: Ready-to-run `$0` Google Colab QLoRA notebook and CLI script defaulting to `Qwen2.5-7B-Instruct` (`Q4_K_M` GGUF ~4.7 GB fits 100% inside this PC's 8 GB RTX 5060 Laptop GPU VRAM via Ollama, plus PEFT LoRA export for Fireworks/Together).
  5. **Global Cross-Agent Daily Report Skill (`daily-report-voice`)**:
     - Installed in both Antigravity (`C:\Users\Terry\.gemini\config\skills\daily-report-voice\SKILL.md`) and Claude Code (`C:\Users\Terry\.claude\skills\daily-report-voice\SKILL.md`), and linked in `C:\Users\Terry\.claude\about-terry.md`, `C:\Users\Terry\.claude\skills\submit-daily\SKILL.md`, and `.agents/AGENTS.md`.
- **Known Landmines Added**:
  - **Zero Parentheses Inside Narrative Prompts (Anti-Priming Rule)**: Never put `(` or `)` inside `INSPECTOR_VOICE_RULES`, `CONSTRUCTION_VOCAB`, `SECOND_PASS_BULLET_SYSTEM_PROMPT`, or `SECOND_PASS_PROSE_SYSTEM_PROMPT` (`test_inspector_voice.py` enforces this). Showing parenthetical definitions in system prompts primes LLMs to emit `( )` in output bullets.
  - **SoCalGas OneDrive Cloud Stubs (`C:\Users\Terry\OneDrive\Gas Co`)**: Contains `219,864` PDFs (`219,832` are OneDrive cloud-only stubs with `st_file_attributes & 0x401000 != 0`). Never open files there without checking `(path.stat().st_file_attributes & 0x401000) == 0` first.
- **Verification**: `test_inspector_voice.py` (23/23 passed), `test_rewrite_shape.py` (10/10 passed), `test_shift_times.py` (38/38 passed), `test_dictation.py` (passed), `test_composer.py` (34/34 passed), `test_conversation.py` (26/26 passed), `test_word_export.py` (43/43 passed), `test_backfill.py` (passed), `test_parse_report.py` (passed), `test_no_consolidation.py` (14/14 passed), `test_resource_lookup.py` (39/39 passed), West Superintendent scan (0 issues).


### 2026-11-19 — Fine-Tuned `terry-inspector` Model Deployed Live (Google Cloud Run + Railway + Local Ollama)
- **What Was Done**:
  1. **Local Ollama on RTX 5060 (`C:\Users\Terry\.ollama\models`)**:
     - Fixed hidden crash-loop bug where Windows User env `OLLAMA_MODELS` pointed to unplugged `D:\ollama\models` (causing `ollama app.exe` to crash-loop once per second and write 376 MB of logs). Updated `OLLAMA_MODELS` to `C:\Users\Terry\.ollama\models`, pinned `ollama.exe` and `ollama app.exe` to `GpuPreference=2;` (RTX 5060), imported `terry-inspector:latest` (`4.36 GiB` `Q4_K_M` GGUF trained on 221 MCN reports / 1,407 examples), and verified live inference (`100% GPU`, `5.0 GB` VRAM, `8192` context).
  2. **Google Cloud Run Serverless Deployment (`gen-lang-client-0325143849` on `My Billing Account 3` / `01DEB6-0AFA41-385170`)**:
     - Uploaded `ollama_models` to private `us-central1` bucket `gs://terry-inspector-models-0325143849` and built baked container image `us-central1-docker.pkg.dev/gen-lang-client-0325143849/terry-inspector/server:baked` (`ollama/ollama:latest` + authenticated Python `proxy.py` enforcing constant-time `hmac.compare_digest` bearer token verification on `/v1/*`).
     - Deployed Cloud Run service `terry-inspector-llm` (`https://terry-inspector-llm-ikqqu2jiea-uc.a.run.app`, `us-central1`, `8 vCPU`, `16 GiB RAM`, `--min-instances=0`, `--max-instances=1`, `OLLAMA_KEEP_ALIVE=15m`). Scales to `$0` when idle; warm inference verified at `8.06s`, cold start verified at `80.9s` (under `DEFAULT_NARRATIVE_TIMEOUT_SECONDS = 90.0s`).
  3. **Live Railway Connection (`ResidentEngineerAssistant`)**:
     - Configured `NARRATIVE_API_BASE=https://terry-inspector-llm-ikqqu2jiea-uc.a.run.app/v1`, `NARRATIVE_MODEL=terry-inspector`, `NARRATIVE_SECOND_PASS=true`, and 256-bit `NARRATIVE_API_KEY` on Railway (`deployment 1b9d0a6e-9258-4569-a0c1-f699abb4153d | SUCCESS`).
     - Verified live `/api/health` (`200 OK`) and end-to-end `polish_inspector_prose_if_enabled` execution against Cloud Run.
- **Known Landmines Added**:
  - **Google Front End Reserves `/healthz`**: Cloud Run edge load balancers intercept `/healthz` with a Google 404 page; always health-check `GET /` on `terry-inspector-llm`.
  - **Bake Model Into Artifact Registry Image Instead of GCS FUSE `mmap`**: Sequential `mmap` of a 4.4 GB GGUF over GCS FUSE takes ~92.5s on cold start (exceeding the 90s client timeout); baking `ollama_models` into the `us-central1` Artifact Registry image keeps cold start under 90s and warm calls at ~8s.
  4. **197-Item Master AI Exclusion Standard Added to `clean_inspector_prose` (`backend/app/services/summary_format.py`, `backend/tests/test_inspector_voice.py`)**:
     - Expanded deterministic post-processor to strip invisible LLM characters (`U+200B`–`U+200D`, `U+2060`, `U+FEFF`, `U+202F`, `U+00A0`), curly/angle smart quotes, Markdown bold/italics/hashes/code fences/bold-colon labels, arrows, dingbats, checkmarks/emoji, semicolons, prose em-dashes, spaced `&` (preserving `SDG&E`, `AT&T`, `T&M`, `PG&E`, and Digout Schedule lines), AI sentence-opener clichés, decorative AI adjectives/adverbs, corporate buzzwords, slash-hedges, and paired doublets while keeping literal construction terms (`bedrock`, `safety harness`, `elevation`, `landscape`, `100 percent`) intact.
     - Verified `test_inspector_voice.py` (`26/26 passed`), `test_rewrite_shape.py` (`10/10 passed`), `test_shift_times.py` (`38/38 passed`), and `test_no_consolidation.py` (`14/14 passed`), and synced both global `daily-report-voice/SKILL.md` files.
