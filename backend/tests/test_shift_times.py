"""
Verify every location's write-up opens in ONE shape, whichever path wrote it.

Terry reads the shift times on every report and scans straight to them, which
only works if they are the same two lines every time:

    Start Time: 6:30 AM
    End Time: 3:00 PM

Three paths write location summaries - the guided interview's compose, the V4
conversation composer, and Dictate All - and a rule agreed for one of them
quietly never reached the others. Dictate All went on without it after the
other two had it. The mechanical rules now live once, in
app/services/summary_format.py, and this checks both the rules themselves and
that every path actually calls them.

Run from the repo root:  python3 backend/tests/test_shift_times.py
"""
import inspect
import os
import sys
import tempfile

sys.path.insert(0, "backend")

os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-times-")
)

from app.services.summary_format import normalise_time_lines, with_opening_times  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


# ── Placing the times on one location ──────────────────────────────────────
# The V4 composer and Dictate All: one location, times known as facts.

out = with_opening_times("6:30 AM", "3:00 PM", "The crew grouted all joints.")
check("the times open the write-up, labelled",
      out == "Start Time: 6:30 AM\nEnd Time: 3:00 PM\nThe crew grouted all joints.", repr(out))

out = with_opening_times("6:30 AM", "", "Work continued into the night.")
check("a missing end time leaves one line, not an empty label",
      out == "Start Time: 6:30 AM\nWork continued into the night.", repr(out))

out = with_opening_times("", "", "Work continued into the night.")
check("no times at all leaves the writing untouched",
      out == "Work continued into the night.", repr(out))

out = with_opening_times("  6:30 AM  ", "3:00 PM", "")
check("no writing still gives the two lines",
      out == "Start Time: 6:30 AM\nEnd Time: 3:00 PM", repr(out))

out = with_opening_times(
    "6:30 AM", "3:00 PM",
    "• Traffic control was set.\nStart Time - 6:30 AM\n• The crew grouted all joints.",
)
check("a time the writing already carried is not printed twice",
      out.count("Start Time") == 1, repr(out))
check("  the time lines sit at the top, everything else in its order",
      out == ("Start Time: 6:30 AM\nEnd Time: 3:00 PM\n"
              "• Traffic control was set.\n• The crew grouted all joints."), repr(out))

out = with_opening_times("", "", "• Striping and layout.\nstart time: 7:00 AM\nFinish Time - 3:30 PM")
check("a time that only arrived in the writing is still used, in the one shape",
      out == "Start Time: 7:00 AM\nEnd Time: 3:30 PM\n• Striping and layout.", repr(out))

out = with_opening_times("6:30 AM", "", "Start Time - 7:15 AM\n• Work began.")
check("the known field wins over a different time in the writing",
      out == "Start Time: 6:30 AM\n• Work began.", repr(out))

out = with_opening_times("", "", "Start Time:\n• The crew grouted all joints.")
check("an empty label comes out even when there is nothing to place",
      out == "• The crew grouted all joints.", repr(out))

out = with_opening_times("", "", "• The start time was agreed with OHLA the night before.")
check("a sentence that merely mentions the words is left alone",
      out == "• The start time was agreed with OHLA the night before.", repr(out))

out = with_opening_times("6:30 AM", "", "• Start time was pushed to 8 because of the rain.")
check(
    "a sentence that STARTS with the words is not lifted out as a label",
    out == "Start Time: 6:30 AM\n• Start time was pushed to 8 because of the rain.",
    repr(out),
)


# ── Normalising in place ───────────────────────────────────────────────────
# The interview composes a whole section at once, which can cover several
# locations, so lines are fixed where they stand rather than gathered up.

check(
    "a dash becomes a colon",
    normalise_time_lines("Start Time - 6:30 AM\nEnd Time - 3:00 PM")
    == "Start Time: 6:30 AM\nEnd Time: 3:00 PM",
)

check(
    "an en dash does too",
    normalise_time_lines("Start Time – 6:30 AM") == "Start Time: 6:30 AM",
)

check(
    "a bullet in front of it is dropped",
    normalise_time_lines("• Start Time: 6:30 AM") == "Start Time: 6:30 AM",
)

check(
    "already right is left alone",
    normalise_time_lines("Start Time: 6:30 AM") == "Start Time: 6:30 AM",
)

check(
    "Stop and Finish both mean End",
    normalise_time_lines("Stop Time - 3:00 PM\nFinish Time: 4:00 PM")
    == "End Time: 3:00 PM\nEnd Time: 4:00 PM",
)

check(
    "case does not matter",
    normalise_time_lines("START TIME - 6:30 am") == "Start Time: 6:30 am",
)

check(
    "no separator but a time straight after is still a label",
    normalise_time_lines("Start Time 6:30 AM") == "Start Time: 6:30 AM",
)

check(
    "a label with nothing after it is dropped, not printed",
    normalise_time_lines("Start Time:\n• The crew grouted all joints.")
    == "• The crew grouted all joints.",
    "an empty label reads as a fact lost between the field and the page",
)

check(
    "a bare label with no separator and nothing after it is dropped too",
    normalise_time_lines("End Time\n• The crew grouted all joints.")
    == "• The crew grouted all joints.",
)

check(
    "two locations in one section keep their own times where they stand",
    normalise_time_lines(
        "Start Time - 6:30 AM\n• Nobel work.\nStart Time - 9:00 PM\n• Genesee work."
    ) == "Start Time: 6:30 AM\n• Nobel work.\nStart Time: 9:00 PM\n• Genesee work.",
)

check(
    "a sentence that merely mentions the words is not mangled",
    normalise_time_lines("• The start time was agreed with OHLA the night before.")
    == "• The start time was agreed with OHLA the night before.",
    "only a line that IS the label gets rewritten",
)

check(
    "a sentence that STARTS with the words is not mangled either",
    normalise_time_lines("Start time was pushed to 8 because of the rain.")
    == "Start time was pushed to 8 because of the rain.",
    "neither a separator nor a time follows 'time', so it is a sentence",
)

check("an empty body stays empty", normalise_time_lines("") == "")


# ── Every path is wired to it, and there is one definition ─────────────────
#
# This guard exists because it once was not wired. The interview's normaliser
# shipped as a function nothing called, and every check above it passed. A
# helper that is never reached is worse than no helper: the tests claim the
# behaviour is there.

from app.routers import ai as ai_module  # noqa: E402
from app.routers import interview as interview_module  # noqa: E402
from app.services import composer as composer_module  # noqa: E402

check(
    "the interview compose normalises what came back",
    "normalise_time_lines(" in inspect.getsource(interview_module.compose_report),
)
check(
    "the V4 composer places the times",
    "with_opening_times(" in inspect.getsource(composer_module),
)
check(
    "Dictate All places the times",
    "with_opening_times(" in inspect.getsource(ai_module.bulk_parse),
)
check(
    "the legacy one-shot dictation goes through that same parse",
    "bulk_parse(" in inspect.getsource(ai_module.bulk_dictate_activities_v2),
)

private_copies = [
    m.__name__ for m in (ai_module, interview_module, composer_module)
    if any(marker in inspect.getsource(m)
           for marker in ("_TIME_LINE", "def _opening_times", "def _normalise_time_lines"))
]
check(
    "there is one definition of the rule, not one per path",
    not private_copies,
    f"private copies in: {private_copies}" if private_copies else "",
)


failed = results.count(False)
print(f"\n{len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
