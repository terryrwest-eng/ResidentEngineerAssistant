"""
Daily Reporter V3 — Configuration

Loads environment variables for API keys and secrets.
Reads from environment first (Railway sets these), falls back to .env file for local dev.
"""

import os
import logging

logger = logging.getLogger(__name__)

# --- Load .env file if present (local dev only) ---
_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
if os.path.isfile(_env_path):
    logger.info(f"Loading .env from: {_env_path}")
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

# --- Export config values ---
GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY", "")

# Model used by every AI endpoint. Override with GEMINI_MODEL to try another one
# without touching code. Gemini 3 models think by default; how hard they think is
# set per call site with ThinkingConfig(thinking_level=...) — note that Gemini 3
# rejects the older thinking_budget parameter, so don't reintroduce it here.
GEMINI_MODEL_NAME: str = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
SECRET_KEY: str = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
DEBUG: bool = os.environ.get("DEBUG", "false").lower() == "true"

if GEMINI_API_KEY:
    logger.info("GEMINI_API_KEY loaded (%s...%s)", GEMINI_API_KEY[:4], GEMINI_API_KEY[-4:])
else:
    logger.warning("GEMINI_API_KEY not set — AI features will be unavailable")
