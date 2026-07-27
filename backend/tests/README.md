# Backend verification scripts

Plain Python scripts (no pytest needed). Run them from the **repo root**:

```bash
python3 backend/tests/test_parse_report.py
python3 backend/tests/test_weather.py
python3 backend/tests/test_dictation.py
python3 backend/tests/test_backfill.py
```

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
