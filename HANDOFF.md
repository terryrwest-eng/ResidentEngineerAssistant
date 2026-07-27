# HANDOFF — Resident Engineer Assistant

**Read this first, then `IMPROVEMENT_PLAN.md`** (the full execution spec: every task with
file paths, line numbers, exact changes and verification steps).

Branch: `claude/daily-reports-app-review-pipd8j`
Written: 2026-07-26, at the end of a remote (web) session, to resume on Claude Code desktop.

---

## 1. Where things stand

| Session | Status | What happened |
|---|---|---|
| Review of app, report format, PMWeb extension | done | Findings in `IMPROVEMENT_PLAN.md` |
| **Session 1 — critical fixes** | **done, pushed** | commit `1eb4a22` |
| **Session 2 — dictation anti-fabrication** | **done, pushed** | commit `da0144e` |
| Android asset sync | done, pushed | `115ee98` |
| Uploaded reports + timesheets merged | done, pushed | `1726891` |
| **Session 3 — Backfill wizard (makeup reports)** | **NOT STARTED — do this next** | |

### Session 1 fixed (all verified)
- `/api/ai/parse-report` **had never worked** — imported a `create_report()` that doesn't
  exist, so every upload burned a Gemini call then 500'd. Now saves properly, assigns
  UUIDs to report/activities/resource rows, renames `summary_html` → `summary`.
- `summary` vs `summary_html` normalized at both save endpoints + fallback in `word.py`.
- Historical weather crashed for recent dates (Open-Meteo archive lags ~5 days and returns
  empty arrays → IndexError masked as HTTP 200). Now falls back to the forecast API's
  `past_days` window, clean 404 if truly unavailable.
- Data paths centralized in `backend/app/core/paths.py` so `DAILY_REPORTER_DATA_DIR` is
  honored everywhere. **Default path unchanged — no migration needed.**
- New reports used UTC date → dated a day ahead after ~5PM Pacific. Fixed with
  `localDateString()` in `frontend/src/lib/formatters.ts`.
- `GET /api/schedule/list` was unreachable (declared after `/{schedule_id}`). Moved.
- Fixed a **pre-existing** TS7006 error that was breaking `npm run build` at HEAD.

> Correction to the original review: the "silent data loss on Railway" finding was **wrong**.
> The Dockerfile flattens `backend/` into `/app`, so every path derivation already resolved
> to `/app/data`. Nothing was ever lost. Also, the claim that `reports.py:172/215` were
> missing `await` was **wrong** — that router imports the *sync* `get_report`. Don't "fix" it.

### Session 2 fixed — the fabricated-report bug
Terry's worst problem: talk for 5 minutes, get a report that was entirely invented.

**Cause:** pass 1 transcribed, pass 2 built activities in JSON mode. If audio was truncated
or silent, pass 1 returned a few words and pass 2 — obliged to fill a schema — invented
plausible construction work. Only guard was "is transcript empty".

**Fix:**
- Split into `POST /ai/bulk-transcribe` and `POST /ai/bulk-parse`.
- New `_transcribe_audio()` used by **every** audio path: retry, `finish_reason` checks
  (MAX_TOKENS / safety), temperature 0.
- Sanity gate: 30s+ of audio yielding < ~3 chars/sec → status `suspect` (warns, doesn't
  block — long silences are legitimate).
- `/bulk-parse` is schema-enforced at temperature 0.
- `/transcribe`, `/transcribe-smart`, `/report-chat` audio all refuse to build/modify from
  failed or suspect audio. report-chat says so instead of rewriting the report on a guess.
- Frontend: **"Here's what I heard"** editable transcript confirmation before activities are
  built; codec negotiation (hardcoded `audio/webm` threw on iOS and was misreported as a mic
  permission error); live mic level meter + peak check for a dead mic.
- Legacy `/bulk-dictate-activities` kept for the shipped APK but returns zero activities
  instead of fabricating.

---

## 2. Environment notes

- **Tests:** `python3 backend/tests/*.py` — offline, Gemini and Open-Meteo mocked, no cost.
  See `backend/tests/README.md`. Use `DAILY_REPORTER_DATA_DIR=/tmp/x` to avoid real data.
- **Frontend:** `cd frontend && npm run build` must be zero TS errors.
- **Deploy:** `railway up`. **One deploy covers three surfaces** — backend API, web app
  (Dockerfile builds React → `/app/static`, FastAPI serves it), and the desktop app (a
  PyWebView shell that loads the Railway URL live, so it needs no rebuild).
  The **Android APK** is the exception: `npm run build && npx cap sync android`, then build
  in Android Studio. Deploy backend before installing a new APK.
- **The remote/web container had no `GEMINI_API_KEY`**, no Railway CLI, and the proxy blocks
  Open-Meteo. On desktop these all work — which is the main reason to continue there.
- Gemini model is hardcoded `gemini-2.5-pro` in 4 files; **it retires 2026-10-16**.
  Plan recommends `gemini-3.6-flash` (audio+vision, thinking budgets, cheaper) — see
  `IMPROVEMENT_PLAN.md` Phase 6 item 1.

---

## 3. NEXT UP: the Backfill wizard (makeup reports)

### 3.1 What Terry needs
Reconstruct daily reports for missed days from scanned handwritten contractor timesheets.
This is the highest-value remaining work.

### 3.2 The data (already committed to this branch)
- `Daily Reports/` — **61 finished reports** (.docx), Dec 2025 → Jul 2026. These are the
  **style target** and the source of few-shot examples.
- `[EXTERNAL] Time Sheets -  January 2026 C-346/` — 24 PDFs
- `[EXTERNAL] Re_ timesheets needed for 2025/` — 15 PDFs
- `reference_reports/` — empty scaffold for future uploads. Its local `.gitignore`
  re-allows `*.pdf/jpg/png` (the root `.gitignore` blocks them globally — **this bites
  silently**, source docs elsewhere in the repo will not commit).
- **More timesheets arriving** — Terry is still waiting on some from the contractor
  (expected the week of 2026-07-27). The pipeline must be per-date and incremental so new
  files only process their own dates.

### 3.3 The makeup list — 37 dates
Timesheet dates with **no** corresponding report, Oct 2025 – Jan 2026:

```
2025-10-29, 10-31, 11-03, 11-04, 11-05, 11-06, 11-11, 11-25, 11-26, 11-27,
2025-12-01, 12-03, 12-04, 12-05, 12-06*, 12-30, 12-31,
2026-01-02, 01-05, 01-06, 01-07, 01-08, 01-09, 01-10, 01-12, 01-13, 01-14,
2026-01-15, 01-16, 01-17*, 01-19, 01-20, 01-21, 01-22, 01-23, 01-24, 01-25
```
`*` = **likely tunnel-only → should produce NO report** (`12.6.25 805 Saturday.pdf`,
`1.17.26 Saturday Rey Villa + Crew Adj.pdf`, both 2 pages). Six other 1–2 page days need
the same check: 1.10.26, 1.2.26, 1.25.26, 1.8.26 Marcos, 11.11.25, 11.27.25.

`2025-12-29` is the only date with **both** a timesheet and a report — verify whether that
existing report actually covers the tunnel-crew work or only Genesee/Marian Bear; if
partial it becomes date 38.

### 3.4 THE SCOPE RULE (most important)
> **All timesheets for a date, MINUS the 805 tunnel crew, = one of Terry's reports.**

Identify a tunnel crew sheet by **either**:
- job name mentions `805` / `tunnel`, **or**
- **foreman is Rey Villa** — he was the tunnel foreman for the entire makeup window
  (he came off it a few weeks before Jul 2026).

Make the foreman name a **setting**, not a constant — that association has ended, so
going forward the job-name check is what carries. Never drop a sheet silently; show the
classification in the review UI.

### 3.5 What the source documents actually look like
Verified by rendering them — do not re-derive:

- **Scanned images, no text layer.** Vision/OCR required. 342 pages total.
- **Page counts vary wildly: 1 to 17 per day.** Terry was emphatic: *every single day is
  different*. Discover crews from the pages; never assume a count or a fixed layout.
- Each foreman's sheet is usually 2 pages:
  - **Page 1** — printed employee roster + handwritten hours, **RT / OT / DT columns**,
    company equipment, short work note. Job no, job name, date, foreman, shift times.
  - **Page 2** — rental equipment, materials, subcontractors, safety, and
    **"SUMMARY OF WORK COMPLETED TODAY"** (handwritten) — the narrative seed.
- **Struck-through rows mean that person did NOT work.** A careless read turns them into
  phantom labor. Must be handled explicitly.
- Handwritten names get added below the printed roster (e.g. "Adhair Valdes", "Sergio Serano").

**Data quality traps found:**
- Filenames `1.2.25 Friday.pdf` and `1.16.25 Friday.pdf` are **year typos** — those dates
  were Thursdays in 2025 and Fridays in **2026**; both live in the Jan-2026 folder.
  **Use the weekday in the filename as a checksum.**
- **Sheets have wrong dates written on them** (a sheet inside `1.13.26` reads `1-13-25`).
  → **The filename date is authoritative, not the handwritten one.**
- Job number written `C-346` and `C-0346`; job name written "Morena ps & conv.",
  "MORGNA", "Morena Conveyance", and typed "Morena Convey: 805 Tunnel".
- Foremen seen: Rey Villa (tunnel), Juan Higuera, Cudberto Ortiz, Phil Gallardo, Marcos.
- Shifts vary per crew per day: 6:30pm–5am, 6:30am–3pm, 7pm–3:30am, 6:00–8:00.

### 3.6 Extraction rules Terry specified
**Always straight from that day's timesheet — never inferred:**
date, labor (with RT/OT/DT), equipment, 3rd-party vendors/subcontractors, rented equipment.

**Inferred, with continuity:** the work description.
> A crew stays on a task (e.g. a blow off) until it's finished. So when a foreman's summary
> box is **blank** — some are — use the **previous day's summary for that same crew/task**
> to infer what they were doing, plus what the existing 61 reports show about how that kind
> of task is normally written up. Exceptions (sick, fired, rain, emergency) just show up as
> the data changing and can't be planned for.

### 3.7 The UX Terry asked for
**Single day** (upload one day of timesheets):
1. AI parses labor, equipment, date, 3rd-party vendors/contractors, rented equipment.
2. AI drafts the work description from: this day's summary boxes, what it knows of previous
   days, what it learns from the existing reports, and what tasks typically go with an activity.
3. **Display what was pulled from the timesheet.**
4. **Show a suggested summary.**
5. **Approve / modify / "try again with this change."**

**Multi-day (makeup):** the same flow, extended to handle many dates at once.

### 3.8 Still open — ask Terry before/while building
1. **Detail level.** Timesheets give crews, hours and one handwritten line. His real reports
   have station ranges, % complete, what's scheduled next — mostly not on the paper.
   Recommendation offered: strictly factual + a per-activity "missing info" list he fills in.
   Not yet answered.
2. **Pilot first.** Recommended running 2–3 days, checking against the scans, tuning, then
   the rest. Not yet confirmed.
3. **Drawing set.** Terry agreed it would help resolve vague location references
   ("blow off" → "Blowoff #5, Sta 395+87"). Plan: full set into the app's PDF/spec library
   (`data/specs/`, existing feature), plus a targeted subset (plan-and-profile sheets with
   stationing, structure/callout schedules) in `reference_reports/drawings/` for building
   and testing. Not uploaded yet.

### 3.9 Target output format
From the 61 reports (see `IMPROVEMENT_PLAN.md` and any file in `Daily Reports/`):
- Title `DAILY FIELD REPORT - MM-DD-YYYY`, project/location/RE/weather/hours block
- `Activities Detail`, then per activity: `Location — Sta X to Sta Y` heading, past-tense
  factual bullets, `Hours:`, `Manpower:` and `Equipment:` lines formatted
  `LL-02- Foreman - QTY 1 - 8 HRS EA - OHL NA`
- Page 2: `Consolidated Resources` 6-col table
  (Resource | Pay Type | Class | Qty | Company | Total Hours)
- Equipment carrying `LR - Labor Regular Time` is **intentional** (equipment has no OT).
  Do not "fix" it.

---

## 4. How to resume on desktop

```bash
git checkout claude/daily-reports-app-review-pipd8j
git pull
```
Then: *"Read HANDOFF.md and IMPROVEMENT_PLAN.md. Sessions 1 and 2 are done. Build the
Backfill wizard (Session 3)."*

Verify the baseline is green first:
```bash
python3 backend/tests/test_parse_report.py   # 12/12
python3 backend/tests/test_weather.py        #   6/6
python3 backend/tests/test_dictation.py      # 24/24
cd frontend && npm run build                 # zero TS errors
```

**Desktop advantages** (the reason for switching): the `GEMINI_API_KEY` works, so the real
handwriting extraction can be iterated on directly; local file access means new timesheets
and the drawing set don't need committing; and the app can actually be run to drive the
Backfill UI.

**First real task there:** render 2–3 timesheet PDFs at 300 DPI, run the extraction prompt
against them, and compare to the scans by eye. Tune before spending budget on all 37.
