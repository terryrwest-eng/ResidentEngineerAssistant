"""
Daily Reporter V3 — Weather Router
Fetches current or historical weather using Open-Meteo (free, no API key needed).
Two modes:
  GET /api/weather?lat=...&lon=...&date=YYYY-MM-DD  → by GPS coordinates
  GET /api/weather/by-zip?zip=92101&date=YYYY-MM-DD → by US ZIP code (geocoded first)

Ported from legacy app — Open-Meteo API, WMO weather codes, Fahrenheit, mph.
Historical weather uses the Open-Meteo Archive API for past dates.
"""

from datetime import date as date_type, datetime
from typing import Optional

from fastapi import Depends, APIRouter, HTTPException, Query
import httpx
import logging

from app.core.auth import require_user

# Every route below requires a signed-in user, declared once here rather than on
# each endpoint: a per-endpoint decorator is something you can forget to add,
# and forgetting it on a data route would expose one user's records to another.
# require_user also pins the request to that user's storage, which is what makes
# every path in this file resolve inside their own directory.
router = APIRouter(prefix="/api", tags=["weather"], dependencies=[Depends(require_user)])
logger = logging.getLogger(__name__)

# Open-Meteo APIs (free, no key required)
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Geocoding API for ZIP code lookup
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"


def _interpret_weather_code(code: int) -> dict[str, str]:
    """Convert WMO weather codes to readable conditions and emoji."""
    weather_map = {
        0: {"condition": "Clear", "emoji": "☀️", "id": "clear"},
        1: {"condition": "Mainly Clear", "emoji": "🌤️", "id": "clear"},
        2: {"condition": "Partly Cloudy", "emoji": "⛅", "id": "partly-cloudy"},
        3: {"condition": "Overcast", "emoji": "☁️", "id": "overcast"},
        45: {"condition": "Fog", "emoji": "🌫️", "id": "fog"},
        48: {"condition": "Depositing Rime Fog", "emoji": "🌫️", "id": "fog"},
        51: {"condition": "Light Drizzle", "emoji": "🌦️", "id": "drizzle"},
        53: {"condition": "Moderate Drizzle", "emoji": "🌦️", "id": "drizzle"},
        55: {"condition": "Dense Drizzle", "emoji": "🌦️", "id": "drizzle"},
        61: {"condition": "Slight Rain", "emoji": "🌧️", "id": "rain"},
        63: {"condition": "Moderate Rain", "emoji": "🌧️", "id": "rain"},
        65: {"condition": "Heavy Rain", "emoji": "🌧️", "id": "rain"},
        71: {"condition": "Slight Snow", "emoji": "🌨️", "id": "cold"},
        73: {"condition": "Moderate Snow", "emoji": "🌨️", "id": "cold"},
        75: {"condition": "Heavy Snow", "emoji": "❄️", "id": "cold"},
        80: {"condition": "Slight Rain Showers", "emoji": "🌦️", "id": "rain"},
        81: {"condition": "Moderate Rain Showers", "emoji": "🌦️", "id": "rain"},
        82: {"condition": "Violent Rain Showers", "emoji": "⛈️", "id": "rain"},
        95: {"condition": "Thunderstorm", "emoji": "⛈️", "id": "rain"},
        96: {"condition": "Thunderstorm with Hail", "emoji": "⛈️", "id": "rain"},
        99: {"condition": "Thunderstorm with Heavy Hail", "emoji": "⛈️", "id": "rain"},
    }
    return weather_map.get(code, {"condition": "Unknown", "emoji": "❓", "id": "overcast"})


def _degrees_to_compass(deg: float) -> str:
    """Convert wind direction degrees to compass direction string."""
    directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    idx = round(deg / 22.5) % 16
    return directions[idx]


def _first(seq, default=None):
    """Safely read element 0 of a possibly-missing/empty list."""
    if isinstance(seq, list) and seq:
        return seq[0]
    return default


def _at(seq, idx, default=None):
    """Safely read element `idx` of a possibly-missing/short list."""
    if isinstance(seq, list) and -len(seq) <= idx < len(seq):
        return seq[idx]
    return default


async def _fetch_past_via_forecast(
    client: httpx.AsyncClient,
    lat: float, lon: float, date: str,
    location_label: str = "",
) -> Optional[dict]:
    """
    Fallback for recent past dates.

    The Open-Meteo Archive API lags several days behind real time, so for a
    date in that gap it returns empty daily arrays. The forecast API can serve
    those days via `past_days`, so we re-query it and pick the matching date.

    Returns None if the date is outside the forecast API's past window or the
    response has no usable row.
    """
    try:
        requested = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        return None

    days_back = (date_type.today() - requested).days
    if days_back < 0 or days_back > 92:  # forecast API caps past_days at 92
        return None

    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": (
            "temperature_2m_max,temperature_2m_min,"
            "weather_code,wind_speed_10m_max,"
            "wind_direction_10m_dominant"
        ),
        "temperature_unit": "fahrenheit",
        "wind_speed_unit": "mph",
        "timezone": "auto",
        "past_days": min(days_back + 1, 92),
        "forecast_days": 1,
    }
    response = await client.get(OPEN_METEO_URL, params=params)
    response.raise_for_status()
    daily = response.json().get("daily", {})

    times = daily.get("time")
    if not isinstance(times, list) or date not in times:
        return None
    idx = times.index(date)

    weather_code = _at(daily.get("weather_code"), idx, 0) or 0
    weather_info = _interpret_weather_code(weather_code)
    temp_max = _at(daily.get("temperature_2m_max"), idx)
    temp_min = _at(daily.get("temperature_2m_min"), idx)
    wind_speed = round(_at(daily.get("wind_speed_10m_max"), idx, 0) or 0)
    wind_dir = _degrees_to_compass(
        _at(daily.get("wind_direction_10m_dominant"), idx, 0) or 0
    )

    logger.info(f"[weather] Archive gap for {date} — served from forecast past_days")
    return {
        "status": "success",
        "temperature_high": str(round(temp_max)) if temp_max is not None else "",
        "temperature_low": str(round(temp_min)) if temp_min is not None else "",
        "humidity": None,
        "wind_speed": wind_speed,
        "wind_direction": wind_dir,
        "wind_info": f"{wind_speed} mph {wind_dir}" if wind_speed else "",
        "condition": weather_info["condition"],
        "emoji": weather_info["emoji"],
        "sky_condition_id": weather_info["id"],
        "weather_code": weather_code,
        "location": location_label or f"{lat:.4f}, {lon:.4f}",
        "date": date,
        "source": "forecast_past",
    }


async def _fetch_weather(
    lat: float, lon: float,
    location_label: str = "",
    date: Optional[str] = None,
) -> dict:
    """
    Core weather fetch — shared by both /weather and /weather/by-zip.
    Returns a consistent response shape.

    If `date` is provided (YYYY-MM-DD) and is in the past, uses the
    Open-Meteo Archive API. Otherwise uses the forecast API.
    """
    # Determine if we need historical data
    use_archive = False
    if date:
        try:
            requested_date = datetime.strptime(date, "%Y-%m-%d").date()
            today = date_type.today()
            use_archive = requested_date < today
            logger.debug(
                f"[weather] date={date}, today={today}, "
                f"use_archive={use_archive}"
            )
        except ValueError:
            logger.warning(f"[weather] Invalid date format: {date}, expected YYYY-MM-DD")
            raise HTTPException(
                status_code=400,
                detail=f"Invalid date format '{date}'. Expected YYYY-MM-DD.",
            )

    async with httpx.AsyncClient(timeout=10.0) as client:
        if use_archive:
            # ── Historical path: Archive API ──
            logger.debug(f"[weather] Using ARCHIVE API for {date} at ({lat}, {lon})")
            params = {
                "latitude": lat,
                "longitude": lon,
                "start_date": date,
                "end_date": date,
                "daily": (
                    "temperature_2m_max,temperature_2m_min,"
                    "weather_code,wind_speed_10m_max,"
                    "wind_direction_10m_dominant"
                ),
                "temperature_unit": "fahrenheit",
                "wind_speed_unit": "mph",
                "timezone": "auto",
            }
            response = await client.get(OPEN_METEO_ARCHIVE_URL, params=params)
            response.raise_for_status()

            data = response.json()
            daily = data.get("daily", {})

            temp_max = _first(daily.get("temperature_2m_max"))
            temp_min = _first(daily.get("temperature_2m_min"))

            # The archive lags several days behind real time. When the requested
            # date falls in that gap the arrays come back empty — serve it from
            # the forecast API's past_days window instead of returning zeros.
            if temp_max is None and temp_min is None:
                logger.warning(
                    f"[weather] Archive returned no data for {date} — trying forecast fallback"
                )
                fallback = await _fetch_past_via_forecast(
                    client, lat, lon, date, location_label
                )
                if fallback:
                    return fallback
                raise HTTPException(
                    status_code=404,
                    detail=f"No weather data available for {date}.",
                )

            weather_code = _first(daily.get("weather_code"), 0) or 0
            weather_info = _interpret_weather_code(weather_code)

            wind_speed = round(_first(daily.get("wind_speed_10m_max"), 0) or 0)
            wind_dir = _degrees_to_compass(
                _first(daily.get("wind_direction_10m_dominant"), 0) or 0
            )

            return {
                "status": "success",
                "temperature_high": str(round(temp_max)) if temp_max is not None else "",
                "temperature_low": str(round(temp_min)) if temp_min is not None else "",
                "humidity": None,  # Archive API has no humidity in daily
                "wind_speed": wind_speed,
                "wind_direction": wind_dir,
                "wind_info": f"{wind_speed} mph {wind_dir}" if wind_speed else "",
                "condition": weather_info["condition"],
                "emoji": weather_info["emoji"],
                "sky_condition_id": weather_info["id"],
                "weather_code": weather_code,
                "location": location_label or f"{lat:.4f}, {lon:.4f}",
                "date": date,
                "source": "archive",
            }
        else:
            # ── Forecast path: current day (existing behavior) ──
            logger.debug(f"[weather] Using FORECAST API at ({lat}, {lon})")
            params = {
                "latitude": lat,
                "longitude": lon,
                "current": "relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
                "daily": "temperature_2m_max,temperature_2m_min,weather_code",
                "temperature_unit": "fahrenheit",
                "wind_speed_unit": "mph",
                "timezone": "auto",
                "forecast_days": 1,
            }
            response = await client.get(OPEN_METEO_URL, params=params)
            response.raise_for_status()

            data = response.json()
            current = data.get("current", {})
            daily = data.get("daily", {})

            weather_code = current.get(
                "weather_code", _first(daily.get("weather_code"), 0)) or 0
            weather_info = _interpret_weather_code(weather_code)

            temp_max = _first(daily.get("temperature_2m_max"))
            temp_min = _first(daily.get("temperature_2m_min"))
            wind_speed = round(current.get("wind_speed_10m", 0) or 0)
            wind_dir = _degrees_to_compass(current.get("wind_direction_10m", 0) or 0)

            return {
                "status": "success",
                "temperature_high": str(round(temp_max)) if temp_max is not None else "",
                "temperature_low": str(round(temp_min)) if temp_min is not None else "",
                "humidity": current.get("relative_humidity_2m", 0),
                "wind_speed": wind_speed,
                "wind_direction": wind_dir,
                "wind_info": f"{wind_speed} mph {wind_dir}" if wind_speed else "",
                "condition": weather_info["condition"],
                "emoji": weather_info["emoji"],
                "sky_condition_id": weather_info["id"],
                "weather_code": weather_code,
                "location": location_label or f"{lat:.4f}, {lon:.4f}",
                "source": "forecast",
            }


@router.get("/weather")
async def get_weather(
    lat: float,
    lon: float,
    date: Optional[str] = Query(None, description="Optional date in YYYY-MM-DD format for historical weather"),
):
    """
    Get weather by GPS coordinates.
    Uses Open-Meteo free API (no key needed).
    Pass ?date=YYYY-MM-DD for historical weather (past dates use Archive API).
    """
    try:
        return await _fetch_weather(lat, lon, date=date)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        logger.error(f"[weather] API error: {e}")
        return {"status": "error", "message": "Weather service unavailable"}
    except Exception as e:
        logger.error(f"[weather] Fetch error: {e}")
        return {"status": "error", "message": str(e)}


@router.get("/weather/by-zip")
async def get_weather_by_zip(
    zip: str,
    date: Optional[str] = Query(None, description="Optional date in YYYY-MM-DD format for historical weather"),
):
    """
    Get current weather by US ZIP code.
    First geocodes the ZIP via Open-Meteo, then fetches weather.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Step 1: Geocode ZIP → lat/lon
            geo_params = {
                "name": zip,
                "count": 1,
                "language": "en",
                "format": "json",
            }
            geo_response = await client.get(GEOCODING_URL, params=geo_params)
            geo_response.raise_for_status()
            geo_data = geo_response.json()

            results = geo_data.get("results", [])
            if not results:
                raise HTTPException(
                    status_code=404, detail=f"ZIP code {zip} not found")

            location = results[0]
            lat = location.get("latitude")
            lon = location.get("longitude")
            location_name = location.get("name", zip)

        # Step 2: Fetch weather
        result = await _fetch_weather(lat, lon, location_name, date=date)
        result["zip"] = zip
        return result

    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        logger.error(f"[weather/by-zip] API error: {e}")
        return {"status": "error", "message": "Weather service unavailable"}
    except Exception as e:
        logger.error(f"[weather/by-zip] Fetch error: {e}")
        return {"status": "error", "message": str(e)}
