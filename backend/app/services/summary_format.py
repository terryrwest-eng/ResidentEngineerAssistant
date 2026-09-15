"""
Daily Reporter — the fixed shape of a location's write-up.

WHY THIS EXISTS: there are three ways a location's summary gets written - the
guided interview's compose, the V4 conversation composer, and Dictate All - and
each had its own prompt. A formatting rule agreed for one quietly never reached
the others, which is how Dictate All went on without the labelled time lines
after the other two had them. The rules that are mechanical live here, once,
and every path calls them.

THE SHAPE: a location opens with its shift times, labelled, on lines of their
own and nothing else on them:

    Start Time: 6:30 AM
    End Time: 3:00 PM

A colon, one space, the time. The reader scans straight to these two lines on
every report, which only works if they are the same two lines every time.

A label with nothing after it is never printed. "Start Time:" on its own reads
as a fact that went missing between the field and the page, which is worse than
not mentioning the time at all.

KEPT IN STEP WITH the TIME_LINE pattern in frontend/src/lib/formatters.ts. The
frontend's summary cleaner runs on every report load, and if the two disagree
about what a time line is, the cleaner puts a bullet back in front of lines this
module placed without one.
"""

import re

# A shift-time LABEL: Start / End / Stop / Finish, then "time", then either a
# separator or a time. "Stop" and "Finish" both mean End - the questions and the
# inspector use all three words. A bullet, quote marker or dash in front of the
# label is tolerated and dropped.
#
# The separator-or-digit requirement is what keeps an ordinary sentence out:
# "Start time was pushed to 8 because of the rain" has neither straight after
# "time", so it stays a sentence instead of becoming "Start Time: was pushed...".
# A bare "Start Time" with nothing at all after it still matches, so that it can
# be dropped.
_TIME_LINE = re.compile(
    r'^[\s>*•–—-]*(start|end|stop|finish)\s*time\s*'
    r'(?:[:–—-]\s*(.*?)|(\d.*?))?\s*$',
    re.IGNORECASE,
)


def _time_value(match: re.Match) -> str:
    """The time after the label, whichever way the line was written."""
    return (match.group(2) or match.group(3) or '').strip()


def _time_label(match: re.Match) -> str:
    return 'Start Time' if match.group(1).lower() == 'start' else 'End Time'


def normalise_time_lines(body: str) -> str:
    """
    Rewrite every time line IN PLACE to the one shape.

    For a body that may cover more than one location (the interview composes a
    whole report section at once), so lines are fixed where they stand rather
    than gathered to the top. Only a line that IS the label is touched.
    """
    if not body:
        return body

    out: list[str] = []
    for line in body.splitlines():
        match = _TIME_LINE.match(line)
        if not match:
            out.append(line)
            continue

        value = _time_value(match)
        if not value:
            continue  # a label with nothing after it is not a fact

        out.append(f'{_time_label(match)}: {value}')

    return '\n'.join(out)


def with_opening_times(start: str, end: str, body: str) -> str:
    """
    Open ONE location's write-up with its shift times, placed by code.

    `start` and `end` are the known facts - a structured field the model filled,
    or a slot the inspector answered. They win. If they are empty, a time line
    the writing already contains is used instead, so a time that was spoken is
    never lost because it arrived in the prose rather than the field.

    Any time lines already in the body are REMOVED from where they stood, so the
    pair appears once, at the top, and never twice. Everything else in the body
    is left exactly as it was.

    A time that is known nowhere produces no line.
    """
    text = body or ''
    found = {'Start Time': '', 'End Time': ''}
    rest: list[str] = []
    removed = False

    for line in text.splitlines():
        match = _TIME_LINE.match(line)
        if not match:
            rest.append(line)
            continue
        removed = True
        label, value = _time_label(match), _time_value(match)
        if value and not found[label]:
            found[label] = value

    start_at = (start or '').strip() or found['Start Time']
    end_at = (end or '').strip() or found['End Time']

    head: list[str] = []
    if start_at:
        head.append(f'Start Time: {start_at}')
    if end_at:
        head.append(f'End Time: {end_at}')

    if not head:
        # Nothing to place. Leave the writing untouched unless an empty label
        # had to come out of it.
        return '\n'.join(rest).strip() if removed else text

    remainder = '\n'.join(rest).strip()
    return '\n'.join(head) + ('\n' + remainder if remainder else '')
