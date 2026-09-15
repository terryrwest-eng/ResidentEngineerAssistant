"""
Verify Rewrite keeps a location's write-up in the same shape as everything else
that writes one:

    Start Time: 6:30 AM
    End Time: 3:00 PM
    - traffic control set, the work in order, other comments, and last what
      became of the traffic control

WHY THIS EXISTS: Rewrite asked the model for "ONLY bullet points" and then ran
the bullet cleaner over the answer, which puts a bullet in front of every line.
A summary whose times sat on labelled lines came back from Rewrite as
"- Start Time: 6:30 AM", or with the times folded into a sentence, or dropped.

The times in the original notes are facts and the rewrite is wording, so the
times are read out of what was SENT and placed back over whatever came back.
This checks that guarantee with the model misbehaving in each of those ways.

Only the per-activity ('classic') rewrite is covered. A project whose report is
numbered narrative sections is rewritten into that different layout, which
this change does not touch.

Gemini is mocked, so this costs nothing and runs offline.
Run from the repo root:  python3 backend/tests/test_rewrite_shape.py
"""
import os
import sys
import tempfile
import types

sys.path.insert(0, "backend")

os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-rewrite-")
)

from app.routers import ai as ai_router  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


class FakeReason:
    def __init__(self, name):
        self.name = name


class FakeCandidate:
    def __init__(self, reason="STOP"):
        self.finish_reason = FakeReason(reason)


class FakeResponse:
    def __init__(self, text, reason="STOP"):
        self.text = text
        self.candidates = [FakeCandidate(reason)]


# What the "model" sends back, and the prompt it was given - set per check.
STATE = {"reply": "", "prompt": ""}


def fake_client():
    c = types.SimpleNamespace()

    def generate_content(**kw):
        STATE["prompt"] = "\n".join(str(part) for part in (kw.get("contents") or []))
        return FakeResponse(STATE["reply"])

    c.models = types.SimpleNamespace(generate_content=generate_content)
    return c, "fake-model"


ai_router._get_gemini_client = fake_client

from app.main import app  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _auth_helper import authed_client  # noqa: E402

client = authed_client(app)

B = "• "

NOTES = (
    "Start Time: 6:30 AM\n"
    "End Time: 3:00 PM\n"
    "tc set in the southbound #1 lane\n"
    "crew grouted all the joints in the vault\n"
    "tc picked up at 3"
)


def rewrite(reply, text=NOTES, project="morena"):
    STATE["reply"] = reply
    return client.post("/api/ai/rewrite", json={
        "text": text, "field_type": "summary", "project": project,
    })


# ── The model bullets the time lines ────────────────────────────────────────
r = rewrite(
    f"{B}Start Time: 6:30 AM\n{B}End Time: 3:00 PM\n"
    f"{B}Traffic control was set in the southbound #1 lane.\n"
    f"{B}The crew grouted all joints in the vault.\n"
    f"{B}Traffic control was picked up at 3:00 PM."
)
check("rewrite 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")
out = r.json().get("text", "")
check(
    "times the model bulleted come back as labelled lines at the top",
    out == (
        "Start Time: 6:30 AM\nEnd Time: 3:00 PM\n"
        f"{B}Traffic control was set in the southbound #1 lane.\n"
        f"{B}The crew grouted all joints in the vault.\n"
        f"{B}Traffic control was picked up at 3:00 PM."
    ),
    repr(out),
)

# ── The model drops the times ───────────────────────────────────────────────
out = rewrite(
    f"{B}Traffic control was set in the southbound #1 lane.\n"
    f"{B}The crew grouted all joints in the vault."
).json()["text"]
check(
    "times the model dropped are put back from the notes",
    out.startswith(f"Start Time: 6:30 AM\nEnd Time: 3:00 PM\n{B}Traffic control was set"),
    repr(out),
)

# ── The model changes a time ────────────────────────────────────────────────
out = rewrite(f"Start Time: 7:00 AM\nEnd Time: 3:00 PM\n{B}Traffic control was set.").json()["text"]
check(
    "a time the model changed is put back the way the notes had it",
    out.startswith("Start Time: 6:30 AM\n") and "7:00 AM" not in out,
    repr(out),
)

# ── The model buries a time line mid-way ────────────────────────────────────
out = rewrite(
    f"{B}Traffic control was set.\n{B}Start Time - 6:30 AM\n{B}The crew grouted all joints."
).json()["text"]
check(
    "a time line buried mid-way is lifted to the top, once",
    out == f"Start Time: 6:30 AM\nEnd Time: 3:00 PM\n{B}Traffic control was set.\n{B}The crew grouted all joints.",
    repr(out),
)

# ── No times anywhere ───────────────────────────────────────────────────────
out = rewrite(
    f"{B}Traffic control was set.\n{B}The crew grouted all joints.",
    text="tc set\ncrew grouted joints",
).json()["text"]
check(
    "with no times in the notes, no time lines appear",
    out == f"{B}Traffic control was set.\n{B}The crew grouted all joints.",
    repr(out),
)

# ── A time the notes gave in words ──────────────────────────────────────────
out = rewrite(
    f"Start Time: 6:30 AM\n{B}Traffic control was set.",
    text="we started at 6:30 and set tc",
).json()["text"]
check(
    "a time the notes gave in words, written back as a label, is kept in the one shape",
    out == f"Start Time: 6:30 AM\n{B}Traffic control was set.",
    repr(out),
)

# ── The prompt ──────────────────────────────────────────────────────────────
rewrite(f"{B}Traffic control was set.")
prompt = STATE["prompt"]
check(
    "the Rewrite prompt carries the shared write-up order",
    "what became of the traffic control" in prompt
    and "NEVER decide traffic control was picked up because the shift ended" in prompt
    and "NEVER write a label with nothing after it" in prompt,
)
check(
    "  and says the time lines come first and are not bullets",
    '"Start Time: 6:30 AM"' in prompt and "Not bullets" in prompt,
)
check(
    "  and no longer demands ONLY bullet points",
    "Output ONLY bullet points" not in prompt,
)


failed = results.count(False)
print(f"\n{len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
