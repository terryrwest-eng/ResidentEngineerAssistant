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
16. **Gemini 2.5 Pro retirement** — The app uses `gemini-2.5-pro` (default in `_get_gemini_client()`). Google is retiring it **Oct 16, 2026**. Successor is `gemini-3.1-pro` (~60% more on input, ~20% more on output).
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
