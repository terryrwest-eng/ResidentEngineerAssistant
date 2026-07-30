"""Verify the weather archive-gap fallback and safe indexing (Task 1.3).

Open-Meteo is blocked by the sandbox proxy, so we stub httpx responses.
This also lets us force the empty-archive case on demand, which the live API
would only exhibit for a few specific recent dates.
"""
import asyncio
import datetime
import sys

sys.path.insert(0, "backend")

import httpx
from app.routers import weather

ARCHIVE_URL = weather.OPEN_METEO_ARCHIVE_URL
FORECAST_URL = weather.OPEN_METEO_URL


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def install(handler):
    """Patch httpx.AsyncClient.get with a handler(url, params) -> payload."""
    async def fake_get(self, url, params=None, **kw):
        return FakeResponse(handler(url, params or {}))
    httpx.AsyncClient.get = fake_get


def run(date=None):
    return asyncio.run(weather._fetch_weather(32.83, -117.27, "Test", date=date))


results = []

def check(name, cond, detail=""):
    results.append((name, cond, detail))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# ── Case 1: archive has data (older date, normal path) ──────────────────────
def handler_archive_ok(url, params):
    assert ARCHIVE_URL in url, f"expected archive call, got {url}"
    return {"daily": {
        "time": [params["start_date"]],
        "temperature_2m_max": [78.4], "temperature_2m_min": [61.2],
        "weather_code": [3], "wind_speed_10m_max": [9.1],
        "wind_direction_10m_dominant": [290],
    }}

install(handler_archive_ok)
r = run("2026-06-16")
check("archive with data → uses archive", r["source"] == "archive" and r["temperature_high"] == "78", f"high={r['temperature_high']} src={r['source']}")


# ── Case 2: archive gap (empty arrays) → forecast past_days fallback ────────
calls = []

def handler_archive_gap(url, params):
    calls.append(url)
    if ARCHIVE_URL in url:
        # This is exactly what the archive returns inside its lag window,
        # and what used to raise IndexError.
        return {"daily": {"time": [], "temperature_2m_max": [],
                          "temperature_2m_min": [], "weather_code": [],
                          "wind_speed_10m_max": [], "wind_direction_10m_dominant": []}}
    target = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
    days = params.get("past_days", 0)
    times = [(datetime.date.today() - datetime.timedelta(days=n)).isoformat()
             for n in range(days, -1, -1)]
    idx = times.index(target)
    mk = lambda fill, val: [fill] * idx + [val] + [fill] * (len(times) - idx - 1)
    return {"daily": {
        "time": times,
        "temperature_2m_max": mk(0, 71.0), "temperature_2m_min": mk(0, 58.0),
        "weather_code": mk(0, 61), "wind_speed_10m_max": mk(0, 12.0),
        "wind_direction_10m_dominant": mk(0, 180),
    }}

install(handler_archive_gap)
gap_date = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
r = run(gap_date)
check("archive gap → forecast fallback (no crash)", r["source"] == "forecast_past", f"src={r['source']}")
check("archive gap → correct date's values", r["temperature_high"] == "71" and r["temperature_low"] == "58", f"high={r['temperature_high']} low={r['temperature_low']}")
check("archive gap → both APIs called", any(ARCHIVE_URL in c for c in calls) and any(FORECAST_URL in c for c in calls))


# ── Case 3: both empty → clean 404, not IndexError ──────────────────────────
def handler_all_empty(url, params):
    return {"daily": {}}

install(handler_all_empty)
try:
    run((datetime.date.today() - datetime.timedelta(days=3)).isoformat())
    check("no data anywhere → HTTPException", False, "expected raise")
except Exception as e:
    from fastapi import HTTPException
    check("no data anywhere → clean 404 (not IndexError)",
          isinstance(e, HTTPException) and e.status_code == 404,
          f"{type(e).__name__}: {e}")


# ── Case 4: forecast path with missing arrays → no crash ────────────────────
def handler_forecast_sparse(url, params):
    return {"current": {"weather_code": 0, "wind_speed_10m": 5, "wind_direction_10m": 270},
            "daily": {}}  # missing temp arrays entirely

install(handler_forecast_sparse)
try:
    r = run(None)
    check("forecast with missing daily arrays → no crash", r["status"] == "success", f"high='{r['temperature_high']}'")
except Exception as e:
    check("forecast with missing daily arrays → no crash", False, f"{type(e).__name__}: {e}")


print()
failed = [n for n, ok, _ in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
