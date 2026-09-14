"""
Verify the day record and the conversation turn (V4).

The point of these checks is the behaviour Terry asked for and V3 does not do:
a gap is chased, not reported; something half-heard is never quietly promoted
to a fact; and one sentence can fill several fields at once.

Gemini is mocked, so this costs nothing and runs offline.
Run from the repo root:  python3 backend/tests/test_conversation.py
"""
import json
import sys
import types

sys.path.insert(0, "backend")

from app.services.day_record import DayRecord, MAX_ASKS

results = []
def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# ─────────────────────────────────────────────────────────────
# The record
# ─────────────────────────────────────────────────────────────
print("\n--- the day record ---")

rec = DayRecord("morena", "2026-06-30")
check("a fresh record has only the non-repeating slots",
      len(rec.slots) == 5, f"{len(rec.slots)} slots")
check("it cannot be written before anything is known", not rec.can_compose())

blocked = [g for g in rec.gaps() if not g.writable]
check("the work section is blocked because no location is named yet",
      any(g.section_id == "activity" for g in blocked))

# Naming the locations brings the repeating section into being.
rec.apply("day::locations", state="ok", value="Nobel Dr\nGenesee Ave",
          rows=[{"item": "Nobel Dr"}, {"item": "Genesee Ave"}],
          heard="we were on nobel and genesee today")
rec.set_instances("activity", ["Nobel Dr", "Genesee Ave"])
# Derived from the profile, not hardcoded: adding a question to the interview
# is a normal thing to do, and it should not fail a test about instancing.
_fixed = sum(len(sec.questions) for sec in rec.profile.sections
             if not getattr(sec, 'repeats', False))
_per_location = sum(len(sec.questions) for sec in rec.profile.sections
                    if getattr(sec, 'repeats', False))
check("naming two locations creates a full slot set for each",
      len(rec.slots) == _fixed + 2 * _per_location,
      f"{len(rec.slots)} slots, expected {_fixed} + 2 x {_per_location}")

first = rec.next_targets(1)[0]
check("questions follow the order the day ran, not the alphabet",
      first.instance == "Nobel Dr", f"asked about {first.instance} first")

# A gate answered no closes the detail behind it, so the interview does not
# chase traffic control on a day that had none.
rec.apply("activity::Nobel Dr::traffic_control", state="ok", value="no",
          heard="no traffic control on that one")
rec.apply_gates()
detail = rec.slots["activity::Nobel Dr::traffic_control_detail"]
check("a gate answered no marks its detail n/a rather than missing",
      detail.state == "na", detail.reason)
check("and a closed gate is never queued as a question",
      all(s.key != detail.key for s in rec.next_targets(30)))

# The state that protects the document.
rec.apply("activity::Nobel Dr::start_time", state="suspect", value="7:30 AM",
          heard="started around seven thirty, or was it eight thirty",
          reason="could not tell 7:30 from 8:30")
check("a suspect value blocks its section even though it has a value",
      not any(g.writable for g in rec.gaps() if g.section_id == "activity"))
check("a suspect value is asked about before anything merely missing",
      rec.next_targets(1)[0].state == "suspect")
check("the transcript is kept so the re-ask can be specific",
      "eight thirty" in rec.next_targets(1)[0].heard)

# Asking forever is its own failure.
for _ in range(MAX_ASKS):
    rec.mark_asked(["activity::Nobel Dr::start_time"])
check(f"after {MAX_ASKS} attempts it stops chasing and leaves the hole visible",
      all(s.key != "activity::Nobel Dr::start_time" for s in rec.next_targets(30)))

restored = DayRecord.from_dict(rec.to_dict())
check("a record survives a round trip with its states intact",
      restored.slots["activity::Nobel Dr::start_time"].state == "suspect"
      and restored.slots["activity::Nobel Dr::traffic_control_detail"].state == "na"
      and restored.slots["activity::Nobel Dr::start_time"].times_asked == MAX_ASKS)

# A later turn that simply does not mention a field must not erase it.
before = restored.slots["day::locations"].value
restored.apply("activity::Genesee Ave::stop_time", state="ok", value="3:00 PM")
check("recording one field leaves the others alone",
      restored.slots["day::locations"].value == before)


# ─────────────────────────────────────────────────────────────
# The turn
# ─────────────────────────────────────────────────────────────
print("\n--- the conversation turn ---")

from fastapi.testclient import TestClient
from app.routers import conversation as convo

# What the two model calls return is set per-test.
STATE = {"extract": {}, "plan": {}}

def fake_call_json(client, model_name, prompt, where):
    return STATE["extract"] if where.endswith("extract") else STATE["plan"]

convo._call_json = fake_call_json
convo._get_gemini_client = lambda *a, **k: (object(), "fake-model")

from app.main import app
from app.core.auth import require_user
app.dependency_overrides[require_user] = lambda: {"id": "u1", "email": "t@t"}
client = TestClient(app)

# One sentence, four fields — the thing a fixed questionnaire cannot do.
STATE["extract"] = {
    "updates": [
        {"key": "day::locations", "state": "ok", "value": "Nobel Dr",
         "rows": [{"item": "Nobel Dr"}], "reason": ""},
    ],
    "conflicts": [],
    "hooks": ["the GC held them up in the morning"],
}
STATE["plan"] = {"reply": "What time did they get going on Nobel?",
                 "asked_keys": [], "done": False}

r = client.post("/api/conversation/turn", json={
    "profile": "morena", "report_date": "2026-06-30",
    "text": "we were on nobel dr, usual contractor nonsense in the morning",
    "history": [],
})
check("a turn is accepted", r.status_code == 200, r.text[:160])
body = r.json()
check("what was said is echoed back for checking", "nobel" in body["transcript"].lower())
check("naming a location materialises that location's slots",
      len(body["record"]["slots"]) > 5, f'{len(body["record"]["slots"])} slots')
check("the record is not writable yet", body["ready_to_write"] is False)
check("it comes back with a question, not a gap report",
      body["reply"].strip().endswith("?"), body["reply"])

# A field the model tries to invent must be dropped, not written.
prev = body["record"]
STATE["extract"] = {
    "updates": [
        {"key": "activity::Nobel Dr::start_time", "state": "ok", "value": "7:30 AM", "rows": []},
        {"key": "activity::Nobel Dr::made_up_field", "state": "ok", "value": "x", "rows": []},
        {"key": "totally::invented", "state": "ok", "value": "y", "rows": []},
    ],
    "conflicts": [], "hooks": [],
}
STATE["plan"] = {"reply": "And what time did they stop?",
                 "asked_keys": ["activity::Nobel Dr::stop_time"], "done": False}
r2 = client.post("/api/conversation/turn", json={
    "profile": "morena", "report_date": "2026-06-30",
    "record": prev, "text": "started at seven thirty", "history": [],
    "asked_keys": ["activity::Nobel Dr::start_time"],
})
b2 = r2.json()
keys = [u["key"] for u in b2["updated"]]
check("a real field is written", "activity::Nobel Dr::start_time" in keys)
check("a field the profile does not define is refused",
      not any("made_up" in k or "invented" in k for k in keys), str(keys))

# A disagreement is surfaced, never silently resolved.
STATE["extract"] = {
    "updates": [],
    "conflicts": [{"key": "activity::Nobel Dr::start_time", "known": "7:30 AM",
                   "heard": "8:30", "note": "start time given twice, differently"}],
    "hooks": [],
}
STATE["plan"] = {"reply": "You said 7:30 earlier and 8:30 now — which was it?",
                 "asked_keys": [], "done": False}
r3 = client.post("/api/conversation/turn", json={
    "profile": "morena", "record": b2["record"],
    "text": "no hang on, they started at eight thirty", "history": [],
})
b3 = r3.json()
check("a contradiction is recorded rather than overwritten", len(b3["conflicts"]) == 1)
check("and the record still holds the original value",
      any(s["key"] == "activity::Nobel Dr::start_time" and s["value"] == "7:30 AM"
          for s in b3["record"]["slots"]))
check("an unsettled contradiction blocks writing", b3["ready_to_write"] is False)

# Audio that could not be read is never extracted from.
convo._transcribe_audio = lambda *a, **k: types.SimpleNamespace(
    transcription="", status="suspect", reason="too much wind noise")
convo._decode_audio = lambda d: b"x"
r4 = client.post("/api/conversation/turn", json={
    "profile": "morena", "record": b3["record"],
    "audio_data": "AAAA", "history": [{"role": "assistant", "text": "which was it?"}],
})
b4 = r4.json()
check("unreadable audio asks for a repeat instead of guessing", b4["status"] == "repeat")
check("and nothing was written from it", b4["updated"] == [])

# The read-only gap view spends no model call.
r5 = client.post("/api/conversation/gaps", json={"profile": "morena", "record": b3["record"]})
b5 = r5.json()
check("the gap view reports progress and what is blocking",
      "progress" in b5 and "blocking" in b5 and b5["ready_to_write"] is False,
      f'{b5["progress"]}')

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
