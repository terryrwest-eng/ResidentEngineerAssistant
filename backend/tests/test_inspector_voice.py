"""
Verify that every narrative-producing endpoint in Daily Reporter V3 enforces the
Resident Engineer / Field Inspector voice and cleans out AI parentheticals,
third-person self-references, stiff corporate words, and leaked cross-day notices.

Run from DAILY-REPORTER-V3 root:
    python backend/tests/test_inspector_voice.py
"""
import base64
import json
import os
import sys
import tempfile
import types

sys.path.insert(0, "backend")

os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-voice-")
)

from app.routers import ai as ai_router  # noqa: E402
from app.routers import backfill as backfill_router  # noqa: E402
from app.routers import interview as interview_router  # noqa: E402
from app.services import summary_format  # noqa: E402

try:
    from app.routers import email_assistant as email_router
except ImportError:
    email_router = None

try:
    from app.routers import tasks as tasks_router
except ImportError:
    tasks_router = None

results: list[bool] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


# ── 1. Anti-Priming Checks on Shared Constants ──────────────────────────────
check(
    "INSPECTOR_VOICE_RULES contains zero parentheses",
    "(" not in summary_format.INSPECTOR_VOICE_RULES
    and ")" not in summary_format.INSPECTOR_VOICE_RULES,
)
check(
    "CONSTRUCTION_VOCAB contains zero parentheses",
    "(" not in ai_router.CONSTRUCTION_VOCAB
    and ")" not in ai_router.CONSTRUCTION_VOCAB,
)
check(
    "STANDARD_EXTRACTION_RULES embeds INSPECTOR_VOICE_RULES",
    "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in ai_router.STANDARD_EXTRACTION_RULES,
)
check(
    "HOUSE_STYLE embeds INSPECTOR_VOICE_RULES",
    "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in interview_router.HOUSE_STYLE,
)
check(
    "TIMESHEET_JSON_PROMPT embeds INSPECTOR_VOICE_RULES",
    "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in backfill_router.TIMESHEET_JSON_PROMPT,
)
if tasks_router is not None:
    check(
        "MEETING_PASS2_STRUCTURED_PROMPT embeds INSPECTOR_VOICE_RULES",
        "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in tasks_router.MEETING_PASS2_STRUCTURED_PROMPT,
    )
if email_router is not None:
    check(
        "EMAIL_SYSTEM_PROMPT embeds INSPECTOR_VOICE_RULES",
        "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in email_router.EMAIL_SYSTEM_PROMPT,
    )

# ── 2. Direct Unit Tests on clean_inspector_prose ───────────────────────────
c1 = summary_format.clean_inspector_prose(
    "The inspector visited Blow Off No. 9, but OHL was not working. "
    "Next, a walkthrough was conducted with Eduardo to identify items needing remediation. "
    "No report exists for 2026-11-09.",
    "unit",
)
check(
    "strips third-person 'The inspector', passive walkthrough, remediation, and leaked date",
    c1 == (
        "Visited Blow Off No. 9, but OHL was not working. "
        "Walked the site with Eduardo to go over what needs to be fixed."
    ),
    repr(c1),
)

c2 = summary_format.clean_inspector_prose(
    "• HMS saw-cut and installed seven (7) traffic loops by 12:00 AM (midnight).\n"
    "• Installed Best Management Practices (BMPs) and checked cathodic protection (CP) wires.\n"
    "• Inspected Air Release Vault AV-15 (Air Vac Release Vault 15) for proper fitment.",
    "unit",
)
check(
    "strips number parens, midnight paren, acronym parens, vault alias parens, and fitment",
    "(" not in c2 and ")" not in c2 and "7 traffic loops" in c2 and "BMPs" in c2 and "to fit" in c2,
    repr(c2),
)

c3 = summary_format.clean_inspector_prose(
    "- DO #5 NB#2 — 1' depth × 177W × 13L = 2,301 SF (172.58 tons)\n"
    "• The San Diego Electrical Inspector was on site, report 1535(b).",
    "unit",
)
check(
    "preserves Digout Schedule tonnage parens, named outside inspector, and sub-report 1535(b)",
    "(172.58 tons)" in c3
    and "The San Diego Electrical Inspector" in c3
    and "1535(b)" in c3,
    repr(c3),
)

c4 = summary_format.clean_inspector_prose(
    "• The timesheet records that AR Concrete compacted subgrade with a jumping jack tamper and a vibratory plate compactor.",
    "unit",
)
check(
    "strips timesheet meta-talk and normalizes wacker + vibratory plate terms",
    c4 == "• AR Concrete compacted subgrade with a wacker and a vibratory plate.",
    repr(c4),
)

c5 = summary_format.clean_inspector_prose(
    "•\u200b **Traffic Control:**\u202fFurthermore, OHLA meticulously leveraged a vac truck — pot-holing SDG&E & AT&T conduits ~300 feet north; the crew promptly and accurately checked each and every utility.",
    "unit",
)
check(
    "strips zero-width/NBSP, bold-colon bullet, opener cliche, filler adverb, em-dash, semicolon, ~300, spaced &, and doublets while keeping SDG&E and AT&T",
    c5 == (
        "• OHLA used a vac truck, pot-holing SDG&E and AT&T conduits about 300 feet north. "
        "The crew on time checked every utility."
    ),
    repr(c5),
)

c6 = summary_format.clean_inspector_prose(
    "★ Terry West’s notebook records that OHLA excavated into bedrock with a safety harness → set pipe elevation & landscape restoration at 100 percent passing ✅.",
    "unit",
)
check(
    "converts dingbat bullet, smart apostrophe, notebook meta-talk, arrow, emoji while keeping construction literals bedrock, safety harness, elevation, landscape, 100 percent",
    c6 == (
        "• OHLA excavated into bedrock with a safety harness to set pipe elevation and landscape restoration at 100 percent passing."
    ),
    repr(c6),
)

# ── 3. End-to-End Endpoint Checks (Mocked Gemini) ───────────────────────────
class FakeFile:
    name = "files/f1"
    uri = "https://fake/f1"


class FakeReason:
    def __init__(self, name: str = "STOP"):
        self.name = name


class FakeCandidate:
    def __init__(self, reason: str = "STOP"):
        self.finish_reason = FakeReason(reason)


class FakeResponse:
    def __init__(self, text: str, reason: str = "STOP"):
        self.text = text
        self.candidates = [FakeCandidate(reason)]


STATE = {"text_reply": "", "json_reply": {}, "last_prompt": ""}


def fake_client():
    c = types.SimpleNamespace()
    c.files = types.SimpleNamespace(upload=lambda **kw: FakeFile())

    def generate_content(**kw):
        cfg = kw.get("config")
        sys_inst = getattr(cfg, "system_instruction", "") or ""
        parts_str = "\n".join(str(p) for p in (kw.get("contents") or []))
        STATE["last_prompt"] = sys_inst + "\n" + parts_str
        if getattr(cfg, "response_mime_type", None) == "application/json":
            return FakeResponse(json.dumps(STATE["json_reply"]))
        return FakeResponse(STATE["text_reply"])

    c.models = types.SimpleNamespace(generate_content=generate_content)
    return c, "fake-model"


ai_router._get_gemini_client = fake_client

from app.main import app  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _auth_helper import authed_client  # noqa: E402

client = authed_client(app)
AUDIO = base64.b64encode(b"x" * 10_000).decode()

# A. /api/ai/rewrite
STATE["text_reply"] = (
    "• The inspector visited Vault #6 and utilized a pump.\n"
    "• Installed four (4) bolts on Air Release Vault AV-15 (Air Vac Release Vault 15)."
)
r = client.post("/api/ai/rewrite", json={"text": "went to vault 6", "field_type": "summary"})
check("/rewrite 200", r.status_code == 200, r.text)
rw_out = r.json().get("text", "")
check(
    "/rewrite cleans output prose and carries INSPECTOR_VOICE_RULES",
    "Visited Vault #6 and used a pump." in rw_out
    and "4 bolts on Air Release Vault AV-15." in rw_out
    and "(" not in rw_out
    and "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in STATE["last_prompt"],
    repr(rw_out),
)

# B. /api/ai/generate-report (AI Assistant inside activity)
STATE["text_reply"] = (
    "• The Resident Engineer met with Eduardo to identify items needing remediation.\n"
    "• Crew commenced installing two (2) Best Management Practices (BMPs)."
)
r = client.post("/api/ai/generate-report", json={
    "original_text": "met eduardo and crew put in 2 bmps",
    "answers": {},
    "work_area": "Blow Off #5",
})
check("/generate-report 200", r.status_code == 200, r.text)
gen_out = r.json().get("report_text", "")
check(
    "/generate-report cleans output prose and carries INSPECTOR_VOICE_RULES",
    "Met with Eduardo to go over what needs to be fixed." in gen_out
    and "Crew started installing 2 BMPs." in gen_out
    and "(" not in gen_out
    and "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in STATE["last_prompt"],
    repr(gen_out),
)

# C. /api/ai/transcribe-smart (Dictate inside each activity)
STATE["text_reply"] = "WORK DESCRIPTION:\n• Cut seven loops on Genesee."
STATE["json_reply"] = {
    "work_area": "Genesee - HMS - Loops",
    "start_time": "9:00 PM",
    "end_time": "3:30 AM",
    "summary_html": "• HMS sawcut seven (7) loops by 12:00 AM (midnight).",
    "manpower": [],
    "equipment": [],
}
r = client.post("/api/ai/transcribe-smart", json={
    "audio_data": AUDIO, "mime_type": "audio/webm", "context": {"duration_seconds": 5},
})
check("/transcribe-smart 200", r.status_code == 200, r.text)
ts_out = r.json().get("summary_html", "")
check(
    "/transcribe-smart cleans output prose and carries INSPECTOR_VOICE_RULES",
    "HMS sawcut 7 loops by 12:00 AM." in ts_out
    and "(" not in ts_out
    and "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in STATE["last_prompt"],
    repr(ts_out),
)

# D. /api/ai/bulk-parse (Dictate All Activities)
STATE["json_reply"] = {
    "activities": [{
        "work_area": "Genesee - OHLA - Conduit",
        "stations": "Sta 406+16",
        "start_time": "7:00 PM",
        "end_time": "2:30 AM",
        "summary_html": "• Located cathodic protection (CP) wires and utilized vac truck.",
        "manpower": [],
        "equipment": [],
    }],
    "locations": "Genesee",
    "general_notes": (
        "The inspector visited Genesee while OHL commenced conduit work. "
        "No report exists for 2026-11-09."
    ),
    "questions": [],
}
r = client.post("/api/ai/bulk-parse", json={"transcription": "OHL worked on Genesee on Friday."})
check("/bulk-parse 200", r.status_code == 200, r.text)
bp = r.json()
check(
    "/bulk-parse cleans both summary_html and general_notes and strips leaked date notice",
    "Located cathodic protection wires and used vac truck." in bp["activities"][0]["summary_html"]
    and bp["general_notes"] == "Visited Genesee while OHL started conduit work."
    and "(" not in bp["activities"][0]["summary_html"]
    and "RESIDENT ENGINEER / FIELD INSPECTOR VOICE" in STATE["last_prompt"],
    repr(bp),
)

# ── 4. Open-Source / Fine-Tuned Narrative Model Routing & Fallback ───────────
import app.core.config as app_config  # noqa: E402
from app.services import narrative_model  # noqa: E402
from unittest.mock import patch  # noqa: E402

check(
    "SECOND_PASS_BULLET_SYSTEM_PROMPT contains zero parentheses",
    "(" not in narrative_model.SECOND_PASS_BULLET_SYSTEM_PROMPT
    and ")" not in narrative_model.SECOND_PASS_BULLET_SYSTEM_PROMPT,
)
check(
    "SECOND_PASS_PROSE_SYSTEM_PROMPT contains zero parentheses",
    "(" not in narrative_model.SECOND_PASS_PROSE_SYSTEM_PROMPT
    and ")" not in narrative_model.SECOND_PASS_PROSE_SYSTEM_PROMPT,
)

# E. Direct narrative endpoint routing on /rewrite (zero Gemini calls when Ollama/LoRA responds)
gemini_calls = {"count": 0}
orig_fake_client = ai_router._get_gemini_client


def counting_gemini_client():
    gemini_calls["count"] += 1
    return orig_fake_client()


ai_router._get_gemini_client = counting_gemini_client
app_config.NARRATIVE_API_BASE = "http://127.0.0.1:11434/v1"
app_config.NARRATIVE_MODEL = "terry-inspector-qwen7b"
app_config.NARRATIVE_SECOND_PASS = True


class MockHttpResponse:
    def __init__(self, content: str):
        self._content = content

    def raise_for_status(self):
        return None

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


with patch("app.services.narrative_model.httpx.Client") as mock_http_cls:
    mock_http_cls.return_value.__enter__.return_value.post.return_value = MockHttpResponse(
        "<think>drafting</think>\n• I met with Eduardo at Vault #6 and checked the 4 anchor bolts."
    )
    gemini_calls["count"] = 0
    r_lora = client.post(
        "/api/ai/rewrite",
        json={"text": "Start Time: 6:30 AM\nEnd Time: 3:00 PM\nmet eduardo vault 6 checked 4 bolts", "field_type": "summary"},
    )
    check(
        "/rewrite routes directly to NARRATIVE_MODEL with 0 Gemini calls and preserves times",
        r_lora.status_code == 200
        and gemini_calls["count"] == 0
        and r_lora.json()["text"] == (
            "Start Time: 6:30 AM\nEnd Time: 3:00 PM\n"
            "• I met with Eduardo at Vault #6 and checked the 4 anchor bolts."
        ),
        repr((gemini_calls["count"], r_lora.json())),
    )

# F. Automatic fallback to Gemini when NARRATIVE_API_BASE is unreachable
with patch("app.services.narrative_model.httpx.Client") as mock_http_cls:
    mock_http_cls.return_value.__enter__.return_value.post.side_effect = RuntimeError("Connection refused")
    STATE["text_reply"] = "• Visited Vault #6 and checked the anchor bolts."
    gemini_calls["count"] = 0
    r_fb = client.post("/api/ai/rewrite", json={"text": "vault 6 bolts", "field_type": "summary"})
    check(
        "/rewrite falls back to Gemini seamlessly when NARRATIVE_API_BASE is unreachable",
        r_fb.status_code == 200
        and gemini_calls["count"] == 1
        and "Visited Vault #6 and checked the anchor bolts." in r_fb.json()["text"],
        repr((gemini_calls["count"], r_fb.json())),
    )

# G. Two-pass voice polish on /bulk-parse (Pass 1 Gemini JSON + Pass 2 free narrative model)
pass2_replies = iter([
    "• OHLA dug down to the cathodic protection wires at Sta 406+16 with the vac truck.",
    "Visited Genesee while OHLA dug down to the cathodic protection wires.",
])
with patch("app.services.narrative_model.httpx.Client") as mock_http_cls:
    mock_http_cls.return_value.__enter__.return_value.post.side_effect = (
        lambda *a, **kw: MockHttpResponse(next(pass2_replies))
    )
    STATE["json_reply"] = {
        "activities": [{
            "work_area": "Genesee - OHLA - Conduit",
            "stations": "Sta 406+16",
            "start_time": "7:00 PM",
            "end_time": "2:30 AM",
            "summary_html": "• Located cathodic protection (CP) wires.",
            "manpower": [{"trade": "Laborer", "name": "Juan", "company": "OHLA", "qty": 2, "hours": 7.5}],
            "equipment": [],
        }],
        "locations": "Genesee",
        "general_notes": "The inspector visited Genesee.",
        "questions": [],
    }
    r_bp2 = client.post("/api/ai/bulk-parse", json={"transcription": "OHLA worked on Genesee."})
    bp2 = r_bp2.json()
    check(
        "/bulk-parse runs Pass 1 Gemini JSON + Pass 2 NARRATIVE_MODEL while keeping crew & times intact",
        r_bp2.status_code == 200
        and bp2["activities"][0]["summary_html"] == (
            "Start Time: 7:00 PM\nEnd Time: 2:30 AM\n"
            "• OHLA dug down to the cathodic protection wires at Sta 406+16 with the vac truck."
        )
        and bp2["general_notes"] == "Visited Genesee while OHLA dug down to the cathodic protection wires."
        and len(bp2["activities"][0]["manpower"]) == 1,
        repr(bp2),
    )

# Reset config globals
app_config.NARRATIVE_API_BASE = ""
app_config.NARRATIVE_MODEL = ""
ai_router._get_gemini_client = orig_fake_client

failed = results.count(False)
print(f"\n{len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
