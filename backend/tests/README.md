# Backend verification scripts

Plain Python scripts (no pytest needed). Run them from the **repo root**:

```bash
python3 backend/tests/test_parse_report.py
python3 backend/tests/test_weather.py
python3 backend/tests/test_dictation.py
python3 backend/tests/test_backfill.py
python3 backend/tests/test_word_export.py
python3 backend/tests/test_extension_context.py
python3 backend/tests/test_duplicate_date_guard.py
python3 backend/tests/test_multiuser.py
python3 backend/tests/test_conversation_draft.py
python3 backend/tests/test_shift_times.py
python3 backend/tests/test_migration.py
```

`test_multiuser.py` is the one that matters for privacy: it registers two
accounts and checks that neither can list, read or delete the other's reports,
that settings and trackers stay separate, that an unauthenticated caller gets
nothing, and that revoking somebody takes effect on their next request rather
than whenever their token expires.

`test_migration.py` covers the one-shot adoption of pre-multi-user data. It
stages a realistic old-layout directory — including a real SQLite database —
registers the first user, and checks every file arrives, is readable through the
API afterwards, and that a second user inherits none of it.

Both create their own scratch storage, so they need no environment setup.

Each prints PASS/FAIL per check and exits non-zero if anything fails.

Gemini and Open-Meteo are **mocked** — these run offline, cost nothing, and
deliberately exercise failure modes the live services won't produce on demand
(an empty weather archive, a truncated model response, a dead-mic recording).

Use a scratch data directory so they never touch real reports:

```bash
DAILY_REPORTER_DATA_DIR=/tmp/rea-test python3 backend/tests/test_dictation.py
```

| File | Covers |
|---|---|
| `test_parse_report.py` | `/api/ai/parse-report` creates a real report with IDs, `summary_html`→`summary`, and exports to Word |
| `test_weather.py` | Archive-gap fallback to the forecast API, safe indexing, clean 404 when no source has the date |
| `test_dictation.py` | Two-step dictation, the short-transcript sanity gate, and that **no** audio endpoint builds data from audio it couldn't read |
| `test_backfill.py` | The makeup pipeline: filename-weekday date checksum (catches the year typos), the 805 tunnel scope rule, that a struck-through worker never becomes labor, that `[illegible]` is never guessed away, and that a tunnel-only day produces **no** report |
| `test_word_export.py` | The Word export against the messy data real reports contain — null/blank/string hours and qty. One row with an empty hours box used to 500 the entire export |
| `test_extension_context.py` | That the Chrome extension's active-report pointer survives multiple uvicorn workers (it lived in per-process memory, so the extension pulled a stale report about half the time), plus the picker endpoint and the split-shift case |
