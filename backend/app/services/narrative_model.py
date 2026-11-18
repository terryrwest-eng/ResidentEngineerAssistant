"""
Dedicated Resident Engineer Narrative Model Client (OpenAI-compatible REST).

WHY THIS EXISTS:
- Pass 1 multimodal tasks (audio transcription, handwritten timesheet OCR, PDF vision)
  stay on Gemini (`gemini-3.6-flash`).
- Pass 2 / text-only Resident Engineer narrative drafting can route to a dedicated
  fine-tuned open-source model (e.g., Qwen 2.5 7B/14B/32B LoRA via local Ollama for $0,
  Groq free tier, or Fireworks serverless LoRA) configured via:
    NARRATIVE_API_BASE
    NARRATIVE_MODEL
    NARRATIVE_API_KEY (optional for local Ollama)
- Whenever NARRATIVE_MODEL is unset or the endpoint is unreachable, every caller
  logs a clear diagnostic message and falls back automatically to Gemini so the
  report workflow never stalls.
"""

from __future__ import annotations

import logging
import re
import time

import httpx

import app.core.config as app_config
from app.services.summary_format import (
    INSPECTOR_VOICE_RULES,
    clean_inspector_prose,
    shift_times,
    with_opening_times,
)

logger = logging.getLogger(__name__)

DEFAULT_NARRATIVE_TIMEOUT_SECONDS: float = 90.0
DEFAULT_MAX_OUTPUT_TOKENS: int = 8192

_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_CODE_FENCE_RE = re.compile(r"```[a-z]*\n?", re.IGNORECASE)


# Anti-priming rule: zero parentheses inside prompt instructions.
SECOND_PASS_BULLET_SYSTEM_PROMPT: str = (
    "You are a 20+ year Pipeline Construction Resident Engineer rewriting draft "
    "daily report bullets into your own direct, plain field-inspector voice.\n\n"
    "HARD RULES:\n"
    "1. Keep EVERY station number, measurement, quantity, pipe size, company name, "
    "person name, reference number, time, and conformance finding verbatim. Never drop, "
    "round, invent, or reorder facts.\n"
    "2. Keep one • bullet per line ending with a period. Output ONLY the • bullets "
    "with zero preamble or commentary.\n"
    "3. Write zero parentheses anywhere in the output. Write counts once as plain digits "
    "and work clauses into the sentence with commas.\n"
    "4. When a bullet describes your own Resident Engineer site visit, walk, meeting, "
    "inspection, or reminder to a contractor, keep 'I' or start with a direct active "
    "past-tense verb such as 'Visited...', 'Met with...', 'Walked the site...'.\n\n"
    + INSPECTOR_VOICE_RULES
)

SECOND_PASS_PROSE_SYSTEM_PROMPT: str = (
    "You are a 20+ year Pipeline Construction Resident Engineer rewriting draft "
    "daily report prose into your own direct, plain field-inspector voice.\n\n"
    "HARD RULES:\n"
    "1. Keep EVERY location, street, station number, measurement, quantity, company name, "
    "person name, time, and conformance finding verbatim. Never drop or invent facts.\n"
    "2. Output ONLY the rewritten prose with zero preamble, headers, or commentary.\n"
    "3. Write zero parentheses anywhere in the output. Write counts once as plain digits "
    "and work clauses into the sentence with commas.\n"
    "4. When a sentence describes your own Resident Engineer site visit, walk, meeting, "
    "inspection, or reminder to a contractor, keep 'I' or start with a direct active "
    "past-tense verb.\n\n"
    + INSPECTOR_VOICE_RULES
)


def is_narrative_endpoint_configured() -> bool:
    """True when both NARRATIVE_API_BASE and NARRATIVE_MODEL are non-empty."""
    return bool(
        (app_config.NARRATIVE_API_BASE or "").strip()
        and (app_config.NARRATIVE_MODEL or "").strip()
    )


def call_narrative_endpoint(
    system_prompt: str,
    user_prompt: str,
    where: str,
    chat_history: list[dict[str, str]] | None = None,
    temperature: float = 0.1,
    max_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
) -> str | None:
    """
    Call the configured OpenAI-compatible `/chat/completions` narrative model.

    Returns the cleaned model text on success, or `None` when not configured
    or when the endpoint errors/returns empty (after logging the failure reason
    so callers can fall back to Gemini transparently).
    """
    if not is_narrative_endpoint_configured():
        return None

    base_url = app_config.NARRATIVE_API_BASE.strip().rstrip("/")
    model_name = app_config.NARRATIVE_MODEL.strip()
    api_key = app_config.NARRATIVE_API_KEY.strip() or "ollama"
    url = f"{base_url}/chat/completions"

    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    if chat_history:
        for msg in chat_history:
            raw_role = str(msg.get("role") or "user").strip().lower()
            role = "assistant" if raw_role in ("assistant", "model") else "user"
            content = str(msg.get("content") or "").strip()
            if content:
                messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": model_name,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    started = time.perf_counter()
    try:
        with httpx.Client(timeout=DEFAULT_NARRATIVE_TIMEOUT_SECONDS) as http_client:
            resp = http_client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            body = resp.json()
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        logger.warning(
            "[narrative-model:%s] Endpoint %s (model=%s) failed after %dms: %s — falling back to Gemini",
            where,
            url,
            model_name,
            elapsed_ms,
            exc,
        )
        return None

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    choices = body.get("choices") if isinstance(body, dict) else None
    if not isinstance(choices, list) or not choices:
        logger.warning(
            "[narrative-model:%s] Endpoint %s (model=%s) returned no choices after %dms — falling back to Gemini",
            where,
            url,
            model_name,
            elapsed_ms,
        )
        return None

    first_msg = choices[0].get("message") if isinstance(choices[0], dict) else None
    raw_content = str((first_msg or {}).get("content") or "").strip()
    cleaned = _THINK_BLOCK_RE.sub("", raw_content).strip()
    cleaned = _CODE_FENCE_RE.sub("", cleaned).strip()

    if not cleaned:
        logger.warning(
            "[narrative-model:%s] Endpoint %s (model=%s) returned empty content after %dms — falling back to Gemini",
            where,
            url,
            model_name,
            elapsed_ms,
        )
        return None

    logger.info(
        "[narrative-model:%s] OK model=%s chars=%d elapsed=%dms",
        where,
        model_name,
        len(cleaned),
        elapsed_ms,
    )
    return cleaned


def polish_inspector_prose_if_enabled(
    text: str,
    where: str,
    mode: str = "bullets",
) -> str:
    """
    Optional Pass 2 voice rewrite for structured JSON endpoints (`bulk_parse`,
    `transcribe_smart`, `transcribe`, `composer`, `interview`).

    - Always runs `clean_inspector_prose` first and last.
    - When `NARRATIVE_MODEL` and `NARRATIVE_SECOND_PASS` are enabled, sends the
      narrative text through the dedicated open-source / fine-tuned model while
      preserving `Start Time:` / `End Time:` lines untouched.
    - If the narrative endpoint is unset or fails, returns the cleaned Pass 1 text.
    """
    base_clean = clean_inspector_prose(text, where)
    if not base_clean.strip():
        return base_clean

    if not is_narrative_endpoint_configured() or not app_config.NARRATIVE_SECOND_PASS:
        return base_clean

    orig_start, orig_end = shift_times(base_clean)
    # Strip Start Time / End Time header lines before sending body to narrative model
    body_lines = [
        ln for ln in base_clean.splitlines()
        if not ln.strip().startswith("Start Time:") and not ln.strip().startswith("End Time:")
    ]
    body_only = "\n".join(body_lines).strip()
    if not body_only:
        return base_clean

    sys_prompt = (
        SECOND_PASS_BULLET_SYSTEM_PROMPT
        if mode == "bullets"
        else SECOND_PASS_PROSE_SYSTEM_PROMPT
    )
    rewritten = call_narrative_endpoint(
        system_prompt=sys_prompt,
        user_prompt=f"DRAFT FIELD TEXT TO REWRITE IN RESIDENT ENGINEER VOICE:\n{body_only}",
        where=f"{where}.pass2",
        temperature=0.1,
    )
    if not rewritten:
        return base_clean

    polished = clean_inspector_prose(rewritten, f"{where}.polished")
    if not polished.strip():
        logger.warning(
            "[narrative-model:%s] Polished output emptied after cleaning — keeping Pass 1 text",
            where,
        )
        return base_clean

    if orig_start or orig_end:
        return with_opening_times(orig_start, orig_end, polished)
    return polished
