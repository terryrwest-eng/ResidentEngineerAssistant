# GEMINI.md — Daily Reporter V3 — Shift-Change Log

## Architecture Overview

### Stack

- **Frontend:** Vite + React 19 (SPA), TypeScript, Tailwind CSS 4, custom Flat 2.0 CSS design system
- **Backend:** FastAPI (Python), SQLite + file-per-report JSON storage
- **State:** Zustand (`src/stores/reportStore.ts`)
- **HTTP Client:** Axios (`src/lib/api.ts`)
- **Storage:** SQLite for indexing + individual .json files per report in `data/reports/`
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
│   │   │   │                 # ResourceTable, PMWebPreview
│   │   │   └── ui/           # NavigationGuard, etc.
│   │   ├── stores/           # reportStore.ts (Zustand)
│   │   ├── lib/              # api.ts, constants.ts
│   │   └── types/            # TypeScript interfaces
│   └── vite.config.ts        # Proxy: /api → localhost:8000
├── backend/
│   ├── app/
│   │   ├── routers/          # reports.py, export.py, auth.py, ai.py, tools.py
│   │   ├── services/         # word.py, pmweb_mappings.py, reports.py
│   │   └── main.py
│   ├── data/                 # All persistent data (gitignored)
│   │   ├── reports/          # Individual report JSON files (atomic writes)
│   │   ├── photos/
│   │   └── specs/
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
| 4. AI Scanning | ⏳ NEXT | Timesheet/ticket scan, voice dictation |
| 5. Field Tools | ⏳ PENDING | Calculators, converters |
| 6. Trackers | ⏳ PENDING | Excavation, pay items, punch list, redline |
| 7. Documents | ⏳ PENDING | Smart PDF search |
| 8. History & Search | ⏳ PENDING | Report list, filter, calendar |
| 9. Photos | ⏳ PENDING | Photo stamper, phone scanner |
| 10. Settings & Auth | ⏳ PENDING | PMWeb URL, API keys, user management |

---

## Known Landmines

1. **OneDrive file locking** — Vite can crash with `EPERM: operation not permitted` on `.vite/deps_temp_*`. Just restart `npm run dev`.
2. **CSS @import order** — Google Fonts `@import` MUST be first line in `index.css`, before `@import "tailwindcss"`.
3. **useBlocker** — Removed from NavigationGuard due to React Router version issues. Only `beforeunload` is hooked. In-app nav prompt relies on explicit save checks.
4. **Content-Type for uploads** — Must be `null` (not `undefined`) for multipart. Set in `scanApi.scanNotes()`.
5. **PMWeb naming** — "Combined Resource Table" = 11-col (Chrome extension). "Consolidated Resources" = 6-col (Word doc). Never swap.

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
