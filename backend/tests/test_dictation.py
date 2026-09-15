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
STATE = {"transcript": "", "reason": "STOP", "parse": None, "last_parse_prompt": ""}

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
            STATE["last_parse_prompt"] = str((kw.get("contents") or [""])[0])
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

# ── 11. Dictate All opens each location with its shift times ────────────────
STATE.update(transcript=GOOD_TRANSCRIPT, reason="STOP", parse={
    "activities": [
        {   # times given as fields, and the model ALSO wrote one into the bullets
            "work_area": "Genesee and Centurion - OHLA - Blowoff #6", "stations": "",
            "start_time": "6:30 AM", "end_time": "3:00 PM",
            "summary_html": "• Traffic control was set in the southbound #1 lane.\nStart Time - 6:30 AM\n• The crew grouted all joints.\n• Traffic control was picked up at 3:00 PM.",
            "manpower": [], "equipment": [],
        },
        {   # no fields, but the writing carries a time in the wrong shape
            "work_area": "Nobel Drive", "stations": "", "start_time": "", "end_time": "",
            "summary_html": "start time: 7:00 AM\n• Striping and layout.",
            "manpower": [], "equipment": [],
        },
        {   # no time anywhere
            "work_area": "Executive and Judicial", "stations": "", "start_time": "", "end_time": "",
            "summary_html": "• No other work was performed.",
            "manpower": [], "equipment": [],
        },
    ],
    "locations": "", "general_notes": "", "questions": [],
})
r = client.post("/api/ai/bulk-parse", json={"transcription": GOOD_TRANSCRIPT})
check("Dictate All parse 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")
acts = r.json()["activities"]
first = acts[0]["summary_html"]
check("Dictate All: the times open the activity, labelled",
      first.startswith("Start Time: 6:30 AM\nEnd Time: 3:00 PM\n• Traffic control was set"), repr(first[:90]))
check("  a time the model also wrote into the bullets is not printed twice",
      first.count("Start Time") == 1, repr(first))
check("  the rest of the write-up keeps its order, traffic control last",
      first.endswith("• The crew grouted all joints.\n• Traffic control was picked up at 3:00 PM."), repr(first))
check("a time that only arrived in the writing is still used, in the one shape",
      acts[1]["summary_html"] == "Start Time: 7:00 AM\n• Striping and layout.", repr(acts[1]["summary_html"]))
check("no time anywhere means no time line",
      acts[2]["summary_html"] == "• No other work was performed.", repr(acts[2]["summary_html"]))

prompt = STATE["last_parse_prompt"]
check("the Dictate All prompt asks for the shift times as fields",
      "start_time and end_time" in prompt)
check("  and tells the model not to write them into the bullets",
      "Do NOT write the times into summary_html" in prompt)
check("  and closes each location on what became of the traffic control",
      "what became of the traffic control" in prompt)
check("  and never infers the traffic control was picked up from the shift end",
      "NEVER decide traffic control was picked up because the shift ended" in prompt)
check("  and never prints a label with nothing after it",
      "NEVER write a label with nothing after it" in prompt)
STATE.update(parse=None)


# ── 12. Dictate (one activity) opens with the same shift times ──────────────
STATE.update(transcript=GOOD_TRANSCRIPT, reason="STOP", parse={
    "work_area": "Genesee and Centurion - OHLA - Blowoff #6",
    "start_time": "6:30 AM", "end_time": "3:00 PM",
    "summary_html": "• Traffic control was set in the southbound #1 lane.\nStart Time - 6:30 AM\n• The crew grouted all joints.",
    "manpower": [], "equipment": [],
})
r = client.post("/api/ai/transcribe-smart", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "context": {"duration_seconds": 300}})
check("Dictate 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")
smart = r.json()
check("Dictate: the times open the activity, labelled",
      smart["summary_html"].startswith("Start Time: 6:30 AM\nEnd Time: 3:00 PM\n• Traffic control was set"),
      repr(smart["summary_html"][:90]))
check("  a time also written into the bullets is not printed twice",
      smart["summary_html"].count("Start Time") == 1, repr(smart["summary_html"]))
check("  the times come back as fields too",
      smart.get("start_time") == "6:30 AM" and smart.get("end_time") == "3:00 PM",
      f"{smart.get('start_time')!r} {smart.get('end_time')!r}")
prompt = STATE["last_parse_prompt"]
check("the Dictate prompt carries the same shape rules as Dictate All",
      "NEVER decide traffic control was picked up because the shift ended" in prompt
      and "what became of the traffic control" in prompt
      and "Do NOT write the times into summary_html" in prompt
      and "NEVER write a label with nothing after it" in prompt)
check("  and asks for start_time and end_time as fields",
      '"start_time"' in prompt and '"end_time"' in prompt)

# ── 13. The Scan page's voice dictation opens each location the same way ───
STATE.update(transcript=GOOD_TRANSCRIPT, reason="STOP", parse={
    "activities": [{
        "work_area": "Nobel Drive", "start_time": "7:00 AM", "end_time": "3:30 PM",
        "summary_html": "• Striping and layout.", "manpower": [], "equipment": [],
    }],
})
r = client.post("/api/ai/transcribe", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "context": {"duration_seconds": 300}})
check("Scan-page dictation 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")
voice = r.json()["activities"][0]["summary_html"]
check("Scan-page dictation: the times open the activity, labelled",
      voice == "Start Time: 7:00 AM\nEnd Time: 3:30 PM\n• Striping and layout.", repr(voice))
prompt = STATE["last_parse_prompt"]
check("  and its prompt carries the same shape rules",
      "NEVER write a label with nothing after it" in prompt
      and "what became of the traffic control" in prompt)
STATE.update(parse=None)


print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
