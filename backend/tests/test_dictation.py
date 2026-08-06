"""Verify the two-step dictation flow and its anti-fabrication guards (Task 2.1)."""
import base64
import json
import sys
import types

sys.path.insert(0, "backend")

from fastapi.testclient import TestClient
from app.routers import ai as ai_router

results = []
def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


class FakeFile:
    name = "files/f1"
    uri = "https://fake/f1"


class FakeReason:
    def __init__(self, name): self.name = name


class FakeCandidate:
    def __init__(self, reason="STOP"): self.finish_reason = FakeReason(reason)


class FakeResponse:
    def __init__(self, text, reason="STOP"):
        self.text = text
        self.candidates = [FakeCandidate(reason)]


# What pass 1 "hears" and what pass 2 returns are set per-test.
STATE = {"transcript": "", "reason": "STOP", "parse": None}

GOOD_TRANSCRIPT = (
    "WORK DESCRIPTION:\n"
    "At the UTC location the south pave crew placed 580 tons of 3/4 inch HMA "
    "along Genesee Avenue between station 100+00 and station 105+50. The grind "
    "crew followed behind and ground out four digouts at one foot depth. "
    "Traffic control was set up at 8:30 PM by Hudson with one flagger.\n"
    "MANPOWER:\n"
    "- Foreman - Lopez, Salvador - 1 - 10 hrs - OHL - 8:30 PM - 6:30 AM\n"
    "- Operator - Martinez, Gustavo - 1 - 10 hrs - OHL - 8:30 PM - 6:30 AM\n"
    "EQUIPMENT:\n"
    "- Paver - 1 - 10 hrs - OHL\n"
) * 3  # long enough to clear the sanity gate

PARSE_JSON = {
    "activities": [{
        "work_area": "UTC - OHL - Paving",
        "stations": "Sta 100+00 to 105+50",
        "summary_html": "• Placed 580 tons of 3/4\" HMA\n• Ground out four digouts at 1' depth",
        "manpower": [{"trade": "LL-02- Foreman", "name": "Lopez, Salvador", "company": "OHL",
                      "qty": 1, "hours": 10, "start_time": "8:30 PM", "stop_time": "6:30 AM",
                      "is_extra_work": False, "is_3rd_party": False, "is_consultant": False}],
        "equipment": [{"name": "LE-07- Paver", "description": "", "company": "OHL",
                       "qty": 1, "hours": 10, "start_time": "8:30 PM", "stop_time": "6:30 AM",
                       "is_extra_work": False, "is_3rd_party": False, "is_rental": False}],
    }],
    "locations": "UTC",
    "general_notes": "Night paving on Genesee with grind crew following.",
}


def fake_client():
    c = types.SimpleNamespace()
    c.files = types.SimpleNamespace(upload=lambda **kw: FakeFile())

    def generate_content(**kw):
        cfg = kw.get("config")
        # Any JSON-mode call is a parse pass; text-mode calls are transcription.
        if getattr(cfg, "response_mime_type", None) == "application/json":
            return FakeResponse(json.dumps(STATE["parse"] or PARSE_JSON))
        return FakeResponse(STATE["transcript"], STATE["reason"])

    c.models = types.SimpleNamespace(generate_content=generate_content)
    return c, "fake-model"


ai_router._get_gemini_client = fake_client

from app.main import app  # noqa: E402
# Signs in as the first (auto-approved admin) account. Every data route now
# requires a user, and storage resolves inside that user's directory — the
# client carries the token so these checks exercise the real path.
import os as _os
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _auth_helper import authed_client  # noqa: E402
client = authed_client(app)

AUDIO = base64.b64encode(b"x" * 50_000).decode()


# ── 1. Happy path: transcribe returns text, does NOT build activities ───────
STATE.update(transcript=GOOD_TRANSCRIPT, reason="STOP", parse=None)
r = client.post("/api/ai/bulk-transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 300})
check("transcribe 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")
body = r.json()
check("transcribe status ok", body["status"] == "ok", f"{body['status']} {body.get('reason','')}")
check("transcript returned", "580 tons" in body["transcription"])
check("transcribe returns NO activities key (step 1 only)", "activities" not in body, str(sorted(body.keys())))


# ── 2. Parse the confirmed transcript ───────────────────────────────────────
r = client.post("/api/ai/bulk-parse", json={"transcription": GOOD_TRANSCRIPT})
check("parse 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")
p = r.json()
check("parse built 1 activity", len(p["activities"]) == 1, str(len(p["activities"])))
check("parse kept manpower", len(p["activities"][0]["manpower"]) == 1)
check("parse returned general_notes", bool(p["general_notes"]))


# ── 3. THE BUG: 5 min of audio, near-empty transcript → suspect, not built ──
STATE.update(transcript="Uh. Okay.", reason="STOP")
r = client.post("/api/ai/bulk-transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 300})
b = r.json()
check("5min audio + tiny transcript → suspect", b["status"] == "suspect", f"{b['status']}")
check("suspect reason mentions the mismatch", "characters were transcribed" in b["reason"], b["reason"][:90])


# ── 4. Legacy one-shot endpoint must NOT fabricate on a suspect transcript ──
r = client.post("/api/ai/bulk-dictate-activities", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 300})
b = r.json()
check("legacy endpoint returns ZERO activities on suspect audio",
      b["activities"] == [], f"{len(b['activities'])} activities")
check("legacy endpoint explains why", "characters were transcribed" in (b.get("general_notes") or ""),
      (b.get("general_notes") or "")[:90])


# ── 5. Model heard nothing → failed, no activities ──────────────────────────
STATE.update(transcript="| Please try again, I couldn't hear you.")
r = client.post("/api/ai/bulk-transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 120})
b = r.json()
check("unintelligible audio → failed", b["status"] == "failed", b["status"])

r = client.post("/api/ai/bulk-dictate-activities", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 120})
check("legacy endpoint builds nothing when nothing was heard",
      r.json()["activities"] == [])


# ── 6. Truncated response (MAX_TOKENS) is surfaced, not silently used ───────
STATE.update(transcript=GOOD_TRANSCRIPT, reason="MAX_TOKENS")
r = client.post("/api/ai/bulk-transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 300})
b = r.json()
check("truncated response flagged as suspect", b["status"] == "suspect", b["status"])
check("truncation reason surfaced", "token limit" in b["reason"], b["reason"][:80])


# ── 7. Tiny/empty recording rejected before any AI call ─────────────────────
STATE.update(transcript=GOOD_TRANSCRIPT, reason="STOP")
r = client.post("/api/ai/bulk-transcribe", json={
    "audio_data": base64.b64encode(b"tiny").decode(), "mime_type": "audio/webm",
    "duration_seconds": 300})
b = r.json()
check("empty recording → failed", b["status"] == "failed", b["status"])

# ── 8. Short recordings are not falsely flagged ─────────────────────────────
STATE.update(transcript="Short but complete note about the crew.")
r = client.post("/api/ai/bulk-transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 10})
check("brief recording is not false-flagged", r.json()["status"] == "ok", r.json()["status"])

# ── 9. Parse refuses empty input ────────────────────────────────────────────
r = client.post("/api/ai/bulk-parse", json={"transcription": "   "})
check("parse rejects empty transcript", r.status_code == 400, f"HTTP {r.status_code}")


# ── 10. Other audio endpoints must refuse to build from bad audio too ───────
STATE.update(transcript="Uh.", reason="STOP", parse=None)

r = client.post("/api/ai/transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm",
    "context": {"duration_seconds": 300}})
check("/transcribe builds nothing from suspect audio",
      r.status_code == 200 and r.json()["activities"] == [],
      f"HTTP {r.status_code} acts={len(r.json().get('activities', []))}")

r = client.post("/api/ai/transcribe-smart", json={
    "audio_data": AUDIO, "mime_type": "audio/webm",
    "context": {"duration_seconds": 300}})
b = r.json()
check("/transcribe-smart builds nothing from suspect audio",
      r.status_code == 200 and not b["summary_html"] and b["manpower"] == [],
      f"summary={len(b.get('summary_html',''))} mp={len(b.get('manpower',[]))}")

r = client.post("/api/ai/report-chat", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "duration_seconds": 300,
    "report": {"general": {"project_name": "Morena"}, "activities": []}})
b = r.json()
check("/report-chat does not modify the report on suspect audio",
      r.status_code == 200 and not b.get("modified_general") and not b.get("modified_activities"),
      f"reply={b.get('reply','')[:60]}")
check("/report-chat explains rather than guessing",
      "haven't changed anything" in (b.get("reply") or ""), (b.get("reply") or "")[:80])

# Good audio still flows through these endpoints
STATE.update(transcript=GOOD_TRANSCRIPT)
r = client.post("/api/ai/transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm",
    "context": {"duration_seconds": 300}})
check("/transcribe still works on good audio", r.status_code == 200, f"HTTP {r.status_code}")

print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
