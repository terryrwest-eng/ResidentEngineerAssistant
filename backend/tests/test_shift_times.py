"""
Verify the shift times open a location's write-up in ONE shape.

Terry reads these two lines on every report and scans straight to them, which
only works if they are the same two lines every time. They were coming back as
"Start Time - 6:30 AM" on one report and folded into a sentence on another,
because the prompt asked for a shape and asking is not getting.

Two paths, two mechanisms, one result:

  composer._opening_times      the V4 path PLACES them, like every other number
                               in that module - the model never sees the job.
  interview._normalise_time_lines
                               the V3 path rewrites whatever came back, since
                               the model writes the whole section body there.

Run from the repo root:  python3 backend/tests/test_shift_times.py
"""
import os
import sys
import tempfile

sys.path.insert(0, "backend")

os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-times-")
)

from app.routers.interview import _normalise_time_lines  # noqa: E402
from app.services.composer import _opening_times  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# ── The V4 path places them ─────────────────────────────────────────────────

out = _opening_times("6:30 AM", "3:00 PM", "The crew grouted all joints.")
check(
    "the times open the write-up, labelled",
    out.startswith("Start Time: 6:30 AM\nEnd Time: 3:00 PM\n"),
    repr(out[:60]),
)
check("  and the prose follows", out.endswith("The crew grouted all joints."))

out = _opening_times("6:30 AM", "", "Work continued into the night.")
check("a missing end time leaves one line, not an empty label",
      out == "Start Time: 6:30 AM\nWork continued into the night.", repr(out))

out = _opening_times("", "", "Work continued into the night.")
check("no times at all leaves the prose untouched",
      out == "Work continued into the night.", repr(out))

out = _opening_times("  6:30 AM  ", "3:00 PM", "")
check("no prose still gives the two lines",
      out == "Start Time: 6:30 AM\nEnd Time: 3:00 PM", repr(out))


# ── The V3 path rewrites what came back ────────────────────────────────────

check(
    "a dash becomes a colon",
    _normalise_time_lines("Start Time - 6:30 AM\nEnd Time - 3:00 PM")
    == "Start Time: 6:30 AM\nEnd Time: 3:00 PM",
)

check(
    "an en dash does too",
    _normalise_time_lines("Start Time – 6:30 AM") == "Start Time: 6:30 AM",
)

check(
    "a bullet in front of it is dropped",
    _normalise_time_lines("• Start Time: 6:30 AM") == "Start Time: 6:30 AM",
)

check(
    "already right is left alone",
    _normalise_time_lines("Start Time: 6:30 AM") == "Start Time: 6:30 AM",
)

check(
    "Stop and Finish both mean End",
    _normalise_time_lines("Stop Time - 3:00 PM\nFinish Time: 4:00 PM")
    == "End Time: 3:00 PM\nEnd Time: 4:00 PM",
)

check(
    "case does not matter",
    _normalise_time_lines("START TIME - 6:30 am") == "Start Time: 6:30 am",
)

check(
    "a label with nothing after it is dropped, not printed",
    _normalise_time_lines("Start Time:\n• The crew grouted all joints.")
    == "• The crew grouted all joints.",
    "an empty label reads as a fact lost between the field and the page",
)

check(
    "the rest of the body is untouched",
    _normalise_time_lines(
        "Start Time - 6:30 AM\n"
        "• Traffic control was set in the southbound #1 lane.\n"
        "• The crew pressure-washed the vault interior."
    ) == (
        "Start Time: 6:30 AM\n"
        "• Traffic control was set in the southbound #1 lane.\n"
        "• The crew pressure-washed the vault interior."
    ),
)

check(
    "a sentence that merely mentions the words is not mangled",
    _normalise_time_lines("• The start time was agreed with OHLA the night before.")
    == "• The start time was agreed with OHLA the night before.",
    "only a line that IS the label gets rewritten",
)

check("an empty body stays empty", _normalise_time_lines("") == "")


failed = results.count(False)
print(f"\n{len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
