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

import logging
import re

logger = logging.getLogger(__name__)

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


def shift_times(text: str) -> tuple[str, str]:
    """
    The shift times already written into some text, as (start, end).

    Rewrite hands the notes to the model and takes back a new version. The
    times in the notes are facts the inspector wrote down; the rewrite is only
    wording. So the times are read out of the ORIGINAL here and placed back over
    whatever the rewrite produced - a model can reword a time away, bullet it or
    "correct" it, and this is what stops that reaching the report.
    """
    start = end = ''
    for line in (text or '').splitlines():
        match = _TIME_LINE.match(line)
        if not match:
            continue
        value = _time_value(match)
        if not value:
            continue
        if _time_label(match) == 'Start Time':
            start = start or value
        else:
            end = end or value
    return start, end


# What a location's write-up says, and in what order. Shared by every prompt
# that writes one - the three dictation paths and Rewrite - so the order and the
# traffic control rules cannot drift between them the way the times once did.
_WRITE_UP_ORDER_RULES = (
    '- The write-up for a location reads in this order:\n'
    '   1. The traffic control that was set, and where.\n'
    '   2. The work itself, in the order it happened, naming the crew and the plant '
    'that did it - the trade and the machine, not a count. Counts live in the '
    'manpower and equipment tables.\n'
    '   3. Any other comment the inspector made about that location.\n'
    '   4. LAST: what became of the traffic control - picked up, or left standing '
    'and why.\n'
    '   Leave out any part that was not said and write the rest.\n'
    '- NEVER decide traffic control was picked up because the shift ended. If the '
    'notes do not say what happened to it, say nothing about it.\n'
    '- NEVER write a label with nothing after it. A bullet reading only "Traffic '
    'control", or "Start Time:" with no time, reads as a fact lost between the '
    'field and the page. If there is nothing to put after it, leave the line out.\n'
)

# The shape rules every DICTATION prompt carries - Dictate (one activity), the
# Scan page's voice dictation, and Dictate All. Held once here so a change to
# the shape reaches all three, instead of being agreed for one prompt and
# quietly never reaching the others, which is how they drifted apart before.
#
# The model is told NOT to write the times into the bullets because the code
# places them - see with_opening_times. The rest covers what code cannot place:
# the order of the write-up, and what is said about traffic control.
DICTATION_SHAPE_RULES = (
    'SHIFT TIMES AND THE SHAPE OF EACH ACTIVITY:\n'
    '- start_time and end_time: the shift at THAT location, only if the speaker '
    'said it ("we started at 6:30 and wrapped at 3"). 12-hour AM/PM. If it was not '
    'said, leave the field empty. NEVER copy a crew row time into it and NEVER '
    'work a time out from hours.\n'
    '- Do NOT write the times into summary_html. The system puts them at the top of '
    'the activity as "Start Time:" and "End Time:" lines, and writing them into the '
    'bullets as well prints them twice.\n'
    + _WRITE_UP_ORDER_RULES
)

# The same shape for Rewrite, which returns plain text rather than fields, so the
# times are asked for as the first two lines instead of a field. The code still
# places them afterwards from the ORIGINAL notes (see shift_times), so this only
# has to keep the model from folding them into a bullet or a sentence.
REWRITE_SHAPE_RULES = (
    'SHIFT TIMES AND THE SHAPE OF THE WRITE-UP:\n'
    '- If the notes give the shift start or end time, the rewrite OPENS with them '
    'as their own lines, exactly "Start Time: 6:30 AM" and "End Time: 3:00 PM". '
    'Not bullets, and not folded into a sentence. NEVER invent a time the notes '
    'do not give.\n'
    + _WRITE_UP_ORDER_RULES
)

# ── Resident Engineer / Field Inspector Voice & Prose Cleaner ─────────────────
#
# Shared across every endpoint that creates or edits report narrative (Dictate
# All, Dictate inside an activity, AI Assistant, Report Chat, AI Rewrite, Scan
# Notes, Guided Interview, V4 Composer, Backfill, Meeting-to-Activity, and Email
# Summary). Following the Anti-Priming Rule, the prompt block states only what
# TO write and shows real verbatim field entries from Terry's MCN reports — no
# bad examples or parenthetical patterns that would prime the model to copy them.

INSPECTOR_VOICE_RULES = """RESIDENT ENGINEER / FIELD INSPECTOR VOICE — MANDATORY FOR ALL NARRATIVE:
1. AUTHOR PERSPECTIVE:
   - You are the Resident Engineer and Inspector writing your own daily field report.
   - When the speaker describes their own inspection work, site walks, meetings, calls, or directions given to a contractor, write from the author's own perspective using first-person "I" or a direct active past-tense verb:
     • "I visited Blow Off #8 and #9 to inspect before PUD comes out."
     • "I drove the site to each intersection, inspecting and getting a count on all traffic loops and pedestrian push buttons."
     • "Met with representatives from City Electrical Department, City Traffic Department, HMS, and OHL to walk each intersection."
     • "Reminded the contractor to be clear of the roadway by 5:00 AM."
   - When the recording or note uses "we" or "our" to describe physical construction work by a contractor crew, name the actual company or crew performing the work — such as "OHLA", "Payco", "HMS", "Picket Fences", "RJ Noble", "AR Concrete", or "The crew" — or open directly with the action verb, such as "Set up traffic control...", "Pumped water out of pull boxes.", or "Backfilled and compacted the trench."

2. SENTENCE STRUCTURE, NUMBERS & PUNCTUATION:
   - Write every sentence using plain periods, commas, colons, or dashes. Write zero parentheses anywhere in activity bullets or general notes.
   - Write counts and quantities once as plain digits: "7 traffic loops", "2 laborers", "4 cubic yards", "1 advance loop".
   - Write standard construction acronyms directly without expanding them: BMP, TCP, RFI, CCTV, CLSM, AC, HMA, PVC, DIP, HDPE, CWI, CP, CTS, DLC, SWPPP, T&M, PUD, SDG&E.
   - Work locations, stations, offsets, and counts directly into the sentence with commas: "Installed 4 loops in the No. 1 lane at Sta 479+57, offset 56 ft left." and "Elyse Dillowary, Stantec paleontologist, was on site from 7:00 AM to 3:00 PM."

3. PLAIN FIELD LANGUAGE:
   - Write short, direct, active past-tense sentences the way a 20-year pipeline Resident Engineer writes in the truck at the end of a shift.
   - State every observation directly as seen on site that day. Never mention where a fact came from — write the work directly without phrases about timesheets, foremen's sheets, photographs, or notebooks.
   - Use plain everyday field words: started, used, set up, picked up, pulled, dug, excavated, placed, poured, ran wire, cut, bolted up, wrapped up, went home, off the road, off site, checked, walked, fixed, repaired, cut shorter, before, then, to.
   - For compaction tools, write "wacker" and "vibratory plate" without adding "compactor" after "vibratory plate". On curb ramp prep after demolition and concrete removal, the sequence is rough grade, set forms, finish grade.
   - Keep every conformance finding stated by the speaker verbatim: "per plan", "per spec", "per the approved TCP", "passing at 96%", "tested good", "0 pressure loss".
   - Format stations as "Sta XX+XX" keeping all decimals, and times as 12-hour AM/PM such as "6:30 AM" and "3:00 PM".

REAL EXAMPLES OF THIS EXACT VOICE:
General Notes example:
  Payco started work at the intersection of Nobel Drive and Genesee Avenue to apply striping and thermoplastic markings. The crew then moved to Executive Drive between Town Center Drive and Judicial Drive to complete striping and thermoplastic work. Later in the night, Payco installed Sure-Curb along Town Center Drive from La Jolla Village Drive heading southbound toward Nobel Drive before clearing the roadway.

Activity bullets example 1:
  • Set up traffic control starting at 9:15 PM.
  • OHLA worked inside Vault No. 6, grouting all seams, penetrations, and areas requiring grout.
  • OHLA installed dry pack underneath the pipe supports and grouted them with a 45-degree chamfer.
  • OHLA installed the blow-off odor control valve piping.
  • Work wrapped up at 4:30 AM.
  • Traffic control picked up and everybody off site by 5:00 AM.

Activity bullets example 2:
  • Payco set up traffic control on Nobel Drive at the Nobel Drive and Genesee Avenue intersection.
  • Payco applied a second coat of striping and thermoplastic pavement markings on Nobel Drive at the Nobel Drive and Genesee Avenue intersection.
  • Payco installed Sure-Curb along the west side of Town Center Drive, working southbound from La Jolla Village Drive to approximately 300 feet north of Nobel Drive, between the bike lane and the No. 2 travel lane.
  • Reminded the contractor to be clear of the roadway by 5:00 AM.
  • Traffic control teardown started at 4:30 AM, and the contractor was clear of the roadway by 5:00 AM.
"""

# Deterministic regex rules for clean_inspector_prose:
# 1. Leaked cross-day lookup notices ("No report exists for 2026-11-09.")
_LEAKED_NO_REPORT_RE = re.compile(
    r'(?:^|\s+)(?:No report exists for|Could not read the report for)\s+\d{4}-\d{2}-\d{2}[^.\n]*\.?',
    re.IGNORECASE,
)

# 2. Spelled-out number + digit in parens: "seven (7)" -> "7", "One (1)" -> "1"
_NUMBER_PAREN_RE = re.compile(
    r'\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|'
    r'eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|'
    r'eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|'
    r'eighty|ninety|hundred|\d+)\s*\((\d+(?:\.\d+)?)\)',
    re.IGNORECASE,
)

# 3. Redundant clock explanations: "12:00 AM (midnight)" -> "12:00 AM"
_CLOCK_PAREN_RE = re.compile(
    r'(\b12:00\s*(?:AM|PM))\s*\((?:midnight|noon)\)',
    re.IGNORECASE,
)

# 4. Known acronym expansions where the bare acronym is house style:
#    "Best Management Practices (BMPs)" -> "BMPs"
_REPLACE_WITH_ACRONYM_RE = re.compile(
    r'\b(?:'
    r'Best\s+Management\s+Practices?\s*\((BMPs?)\)|'
    r'Traffic\s+Control\s+Plans?\s*\((TCPs?)\)|'
    r'Requests?\s+for\s+Information\s*\((RFIs?)\)|'
    r'Closed[- ]Circuit\s+Television\s*\((CCTV)\)|'
    r'Control(?:led)?\s+Low[- ]Strength\s+Material\s*\((CLSM)\)|'
    r'Detector\s+Lead[- ]In\s+Cables?\s*\((DLCs?)\)|'
    r'Certified\s+Welding\s+Inspectors?\s*\((CWIs?)\)|'
    r'Job\s+Hazard\s+Analys[ie]s\s*\((JHAs?)\)|'
    r'Storm\s*water\s+Pollution\s+Prevention\s+Plans?\s*\((SWPPPs?)\)|'
    r'Subsurface\s+Utility\s+Engineering\s*\((SUE)\)'
    r')',
    re.IGNORECASE,
)

# 5. Trailing short acronym/alias tag after a full phrase where the phrase stays
#    and the parenthetical tag drops: "cathodic protection (CP)" -> "cathodic protection",
#    "Air Release Vault AV-15 (Air Vac Release Vault 15)" -> "Air Release Vault AV-15"
_TRAILING_ACRONYM_TAG_RE = re.compile(
    r'\s+\((?:CP|CTS|AC|PCC|BO|AR|RE|T&M|HMA|PVC|DIP|HDPE|RCP|VCP|CMP|CIPP|'
    r'ARV[- ]?\d+|Air\s+(?:Vac\s+)?Release\s+Vault\s*#?\s*\d+)\)',
    re.IGNORECASE,
)

# 6. Third-person self-reference to the author ("The inspector visited..." -> "Visited...").
#    Deliberately requires "The [field] inspector" or "The resident engineer" with NO
#    agency/company qualifier (so "The San Diego Electrical Inspector" or "Kleinfelder
#    inspector" is NEVER touched).
_THIRD_PERSON_RE_SELF = re.compile(
    r'(^|(?<=[.!?•\n])\s*)The\s+(?:field\s+)?(?:inspector|resident\s+engineer)\s+'
    r'(visited|walked|inspected|met|checked|observed|noted|contacted|reminded|'
    r'instructed|directed|drove|attended|reviewed|counted|picked\s+up|sent|'
    r'arrived|departed|verified|confirmed|told|asked|suggested|recommended|'
    r'discussed|called|informed|advised|witnessed|monitored)\b',
    re.IGNORECASE,
)

# Standalone AI self-attribution lines ("The inspector was Terry West.", "Witnessed for the City by the Resident Engineer.")
_SELF_ATTRIBUTION_LINE_RE = re.compile(
    r'(?:^|\n)\s*[•\-]?\s*The\s+(?:field\s+)?(?:inspector|resident\s+engineer)\s+was\s+Terry\s+West\.?\s*(?=\n|$)',
    re.IGNORECASE,
)
_WITNESSED_BY_RE = re.compile(
    r'\bWitnessed\s+for\s+the\s+City\s+by\s+the\s+(?:Resident\s+Engineer|inspector)\b',
    re.IGNORECASE,
)

# 7. Passive walkthrough / inspection openings that erase the RE:
#    "A walkthrough was conducted with Eduardo" -> "Walked the site with Eduardo"
_PASSIVE_WALKTHROUGH_RE = re.compile(
    r'(^|(?<=[.•\n])\s*)(?:Next,\s+|Afterwards,?\s+)?A\s+walkthrough\s+was\s+conducted\b',
    re.IGNORECASE,
)

# 8. Invisible LLM tokenizer characters, smart quotes, dingbats, emoji, markdown & symbol rules:
_ZERO_WIDTH_RE = re.compile(r'[\u200b\u200c\u200d\u2060\ufeff]')
_NBSP_RE = re.compile(r'[\u00a0\u202f]')
_SMART_DOUBLE_QUOTE_RE = re.compile(r'[\u201c\u201d\u00ab\u00bb]')
_SMART_SINGLE_QUOTE_RE = re.compile(r'[\u2018\u2019\u2039\u203a]')
_UNICODE_MINUS_RE = re.compile(r'\u2212')
_TRADEMARK_RE = re.compile(r'[\u2122\u00ae\u00a9]')
_CHECK_EMOJI_RE = re.compile(
    r'[\u2713\u2714\u2611\u2717\u2718\u274c\u2705\ufe0f\U0001f300-\U0001faff]'
)
_DINGBAT_BULLET_RE = re.compile(r'^([ \t]*)[★☆✦✧❖◆◇▪▸►]+\s*', re.MULTILINE)
_MIDLINE_DINGBAT_RE = re.compile(r'[★☆✦✧❖◆◇▪▸►]')
_ARROW_RE = re.compile(r'\s*[→⇒⟶➔➜]\s*')
_ELLIPSIS_RE = re.compile(r'\u2026|\.{3,}')
_CODE_FENCE_INLINE_RE = re.compile(r'```[a-zA-Z0-9_-]*\n?|`')
_MD_HEADING_QUOTE_RE = re.compile(r'^[ \t]*(?:#{1,6}|>)\s+', re.MULTILINE)
_MD_STAR_BULLET_RE = re.compile(r'^([ \t]*)\*\s+', re.MULTILINE)
_BOLD_COLON_BULLET_RE = re.compile(
    r'^([ \t]*•\s*)\*\*[^*:\n]{1,45}:\*\*\s*([a-zA-Z])',
    re.MULTILINE,
)
_MD_BOLD_RE = re.compile(r'\*\*(.+?)\*\*|__(.+?)__')
_MD_ITALIC_RE = re.compile(r'(?<!\*)\*([A-Za-z][^*\n]{0,80}?[A-Za-z0-9])\*(?!\*)')
_APPROX_NUM_RE = re.compile(r'(?<!\w)[~≈]\s*(?=\d)')
_BRACKET_PLACEHOLDER_RE = re.compile(
    r'\[(?:Insert\s+[^\]]+|TBD|TODO|N/?A|Placeholder[^\]]*)\]',
    re.IGNORECASE,
)

# 9. AI sentence-opener clichés stripped cleanly at sentence / bullet start:
_AI_SENTENCE_OPENER_RE = re.compile(
    r'(^|(?<=[.!?•\n])[ \t]*)(?:'
    r'Furthermore,\s+|Moreover,\s+|Additionally,\s+|Consequently,\s+|'
    r'Nevertheless,\s+|Nonetheless,\s+|Notably,\s+|Importantly,\s+|Significantly,\s+|'
    r'First\s+and\s+foremost,\s+|Last\s+but\s+not\s+least,\s+|'
    r'With\s+that\s+in\s+mind,\s+|To\s+that\s+end,\s+|'
    r'By\s+doing\s+so,\s+|In\s+doing\s+so,\s+|At\s+its\s+core,\s+|'
    r'In\s+summary,\s+|In\s+conclusion,\s+|To\s+summarize,\s+|Overall,\s+|Ultimately,\s+|'
    r'As\s+previously\s+mentioned,\s+|As\s+stated\s+above,\s+|As\s+noted\s+earlier,\s+|'
    r'It\s+is\s+worth\s+noting\s+that\s+|It\s+should\s+be\s+noted\s+that\s+|'
    r'Please\s+note\s+that\s+|It\s+is\s+important\s+to\s+remember\s+that\s+|'
    r'It\s+is\s+essential\s+to\s+recognize\s+that\s+'
    r')([a-zA-Z])',
    re.IGNORECASE,
)

# Decorative AI filler adverbs/adjectives removed while preserving sentence capitalization
# (excludes construction-valid literals like 'bedrock', 'elevated', 'landscape', 'harness', '100%'):
_DECORATIVE_FILLER_RE = re.compile(
    r'\b(?:'
    r'meticulously|seamlessly|holistically|rigorously|robustly|comprehensively|'
    r'proactively|diligently|steadfastly|exhaustively|unwaveringly|flawlessly|'
    r'synergistically|meticulous|seamless|holistic|overarching|unwavering|'
    r'uncompromising|unyielding|multifaceted|synergistic|bespoke|transformative|'
    r'state-of-the-art|cutting-edge|best-in-class|world-class|top-notch|'
    r'aforementioned'
    r')\s+([a-zA-Z])',
    re.IGNORECASE,
)

# 10. Hyper-proper corporate, bureaucratic, slash-hedge, and doublet replacements:
_STIFF_VOCAB_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r'\butilizing\b', re.IGNORECASE), 'using'),
    (re.compile(r'\butilized\b', re.IGNORECASE), 'used'),
    (re.compile(r'\butilizes\b', re.IGNORECASE), 'uses'),
    (re.compile(r'\butilize\b', re.IGNORECASE), 'use'),
    (re.compile(r'\butilization\b', re.IGNORECASE), 'use'),
    (re.compile(r'\bleveraging\b', re.IGNORECASE), 'using'),
    (re.compile(r'\bleveraged\b', re.IGNORECASE), 'used'),
    (re.compile(r'\bleverages\b', re.IGNORECASE), 'uses'),
    (re.compile(r'\bleverage\b', re.IGNORECASE), 'use'),
    (re.compile(r'\bcommenced\b', re.IGNORECASE), 'started'),
    (re.compile(r'\bcommencing\b', re.IGNORECASE), 'starting'),
    (re.compile(r'\bcommences\b', re.IGNORECASE), 'starts'),
    (re.compile(r'\bcommence\b', re.IGNORECASE), 'start'),
    (re.compile(r'\bembarked\s+on\b', re.IGNORECASE), 'started'),
    (re.compile(r'\bembarking\s+on\b', re.IGNORECASE), 'starting'),
    (re.compile(r'\bspearheaded\b', re.IGNORECASE), 'led'),
    (re.compile(r'\bspearheading\b', re.IGNORECASE), 'leading'),
    (re.compile(r'\bspearhead\b', re.IGNORECASE), 'lead'),
    (re.compile(r'\bbolstered\b', re.IGNORECASE), 'reinforced'),
    (re.compile(r'\bbolstering\b', re.IGNORECASE), 'reinforcing'),
    (re.compile(r'\bbolster\b', re.IGNORECASE), 'reinforce'),
    (re.compile(r'\bdelved\s+into\b', re.IGNORECASE), 'checked'),
    (re.compile(r'\bdelve\s+into\b', re.IGNORECASE), 'check'),
    (re.compile(r'\bunderscored\b', re.IGNORECASE), 'pointed out'),
    (re.compile(r'\bunderscores\b', re.IGNORECASE), 'shows'),
    (re.compile(r'\bunderscore\b', re.IGNORECASE), 'show'),
    (re.compile(r'\bfacilitated\b', re.IGNORECASE), 'helped with'),
    (re.compile(r'\bfacilitating\b', re.IGNORECASE), 'helping with'),
    (re.compile(r'\bfacilitate\b', re.IGNORECASE), 'help with'),
    (re.compile(r'\bendeavored\s+to\b', re.IGNORECASE), 'worked to'),
    (re.compile(r'\bendeavor\s+to\b', re.IGNORECASE), 'work to'),
    (re.compile(r'\bascertained\b', re.IGNORECASE), 'checked'),
    (re.compile(r'\bascertain\b', re.IGNORECASE), 'check'),
    (re.compile(r'\bprocured\b', re.IGNORECASE), 'picked up'),
    (re.compile(r'\bprocure\b', re.IGNORECASE), 'get'),
    (re.compile(r'\bremuneration\b', re.IGNORECASE), 'pay'),
    (re.compile(r'\bdisseminated\b', re.IGNORECASE), 'handed out'),
    (re.compile(r'\bdisseminate\b', re.IGNORECASE), 'hand out'),
    (re.compile(r'\bameliorate\b', re.IGNORECASE), 'fix'),
    (re.compile(r'\bmitigate\b', re.IGNORECASE), 'reduce'),
    (re.compile(r'\brendered\s+assistance\b', re.IGNORECASE), 'helped'),
    (re.compile(r'\brender\s+assistance\b', re.IGNORECASE), 'help'),
    (re.compile(r'\badministered\s+oversight\b', re.IGNORECASE), 'checked the work'),
    (re.compile(r'\badminister\s+oversight\b', re.IGNORECASE), 'check the work'),
    (re.compile(r'\bstreamlined\b', re.IGNORECASE), 'simplified'),
    (re.compile(r'\bstreamline\b', re.IGNORECASE), 'simplify'),
    (re.compile(r'\boptimized\b', re.IGNORECASE), 'adjusted'),
    (re.compile(r'\boptimize\b', re.IGNORECASE), 'adjust'),
    (re.compile(r'\beffectuated\b', re.IGNORECASE), 'completed'),
    (re.compile(r'\beffectuate\b', re.IGNORECASE), 'complete'),
    (re.compile(r'\boperationalized\b', re.IGNORECASE), 'put in place'),
    (re.compile(r'\boperationalize\b', re.IGNORECASE), 'put in place'),
    (re.compile(r'\bif\s+deemed\s+necessary\b', re.IGNORECASE), 'if needed'),
    (re.compile(r'\bprior\s+to\b', re.IGNORECASE), 'before'),
    (re.compile(r'\bsubsequent\s+to\b', re.IGNORECASE), 'after'),
    (re.compile(r'\bsubsequently\b', re.IGNORECASE), 'then'),
    (re.compile(r'\bin\s+order\s+to\b', re.IGNORECASE), 'to'),
    (re.compile(r'\bfor\s+the\s+purpose\s+of\b', re.IGNORECASE), 'for'),
    (re.compile(r'\bin\s+the\s+event\s+that\b', re.IGNORECASE), 'if'),
    (re.compile(r'\bin\s+the\s+event\s+of\b', re.IGNORECASE), 'if there is'),
    (re.compile(r'\bat\s+(?:this\s+point\s+in|the\s+present)\s+time\b', re.IGNORECASE), 'now'),
    (re.compile(r'\bpursuant\s+to\b', re.IGNORECASE), 'per'),
    (re.compile(r'\bin\s+accordance\s+with\b', re.IGNORECASE), 'per'),
    (re.compile(r'\bin\s+compliance\s+with\b', re.IGNORECASE), 'per'),
    (re.compile(r'\band/or\b', re.IGNORECASE), 'or'),
    (re.compile(r'\bhis/her\b', re.IGNORECASE), 'their'),
    (re.compile(r'\bhe/she\b', re.IGNORECASE), 'they'),
    (re.compile(r'\bstaff/personnel\b', re.IGNORECASE), 'crew'),
    (re.compile(r'\breview/update\b', re.IGNORECASE), 'review'),
    (re.compile(r'\bensure/maintain\b', re.IGNORECASE), 'keep'),
    (re.compile(r'\beach\s+and\s+every\b', re.IGNORECASE), 'every'),
    (re.compile(r'\bany\s+and\s+all\b', re.IGNORECASE), 'all'),
    (re.compile(r'\bsafely\s+and\s+effectively\b', re.IGNORECASE), 'safely'),
    (re.compile(r'\bpromptly\s+and\s+accurately\b', re.IGNORECASE), 'on time'),
    (re.compile(r'\btimely\s+and\s+accurate\b', re.IGNORECASE), 'accurate'),
    (re.compile(r'\bclear\s+and\s+concise\b', re.IGNORECASE), 'clear'),
    (re.compile(r'\bcomplete\s+and\s+accurate\b', re.IGNORECASE), 'complete'),
    (re.compile(r'\bconducted\s+and\s+completed\b', re.IGNORECASE), 'completed'),
    (re.compile(r'\bconduct\s+and\s+complete\b', re.IGNORECASE), 'complete'),
    (re.compile(r'\breviewed\s+and\s+evaluated\b', re.IGNORECASE), 'reviewed'),
    (re.compile(r'\breview\s+and\s+evaluate\b', re.IGNORECASE), 'review'),
    (re.compile(r'\bmonitored\s+and\s+oversaw\b', re.IGNORECASE), 'checked'),
    (re.compile(r'\bmonitor\s+and\s+oversee\b', re.IGNORECASE), 'check'),
    (re.compile(r'\bmaintained\s+and\s+upheld\b', re.IGNORECASE), 'kept'),
    (re.compile(r'\bmaintain\s+and\s+uphold\b', re.IGNORECASE), 'keep'),
    (re.compile(r'\broles\s+and\s+responsibilities\b', re.IGNORECASE), 'duties'),
    (re.compile(r'\bupon\s+completion\s+of\s+work\b', re.IGNORECASE), 'when work wrapped up'),
    (re.compile(r'\b(?:all\s+)?personnel\s+(?:cleared|departed|were\s+clear\s+of)\s+the\s+site\b', re.IGNORECASE), 'everybody was off site'),
    (re.compile(r'\bfor\s+proper\s+fitment\b', re.IGNORECASE), 'to fit'),
    (re.compile(r'\bto\s+identify\s+items\s+needing\s+remediation\b', re.IGNORECASE), 'to go over what needs to be fixed'),
    (re.compile(r'\brequiring\s+(?:remediation|corrective\s+work)\b', re.IGNORECASE), 'that need to be fixed'),
    (re.compile(r'\bjumping\s+jack\s+tampers\b', re.IGNORECASE), 'wackers'),
    (re.compile(r'\bjumping\s+jack\s+tamper\b', re.IGNORECASE), 'wacker'),
    (re.compile(r'\bvibratory\s+plate\s+compactors\b', re.IGNORECASE), 'vibratory plates'),
    (re.compile(r'\bvibratory\s+plate\s+compactor\b', re.IGNORECASE), 'vibratory plate'),
]

# Strip timesheet/photo/notebook meta-talk ("The timesheet records that OHLA dug..." -> "OHLA dug...")
_SOURCE_META_TALK_RE = re.compile(
    r'(^|(?<=[.!?•\n])\s*)(?:(?:According\s+to|Per)\s+the\s+(?:contractor\'?s\s+|foreman\'?s\s+)?(?:time\s*sheet|sheet|photographs?|notebook),\s*|'
    r'(?:Terry\s+West\'?s\s+|The\s+(?:contractor\'?s\s+|foreman\'?s\s+)?)(?:time\s*sheet|sheet|overview|notebook|report)\s+(?:records|states|reads|notes|indicates)\s+(?:that\s+)?|'
    r'The\s+photographs?\s+(?:show|indicate)\s+(?:that\s+)?)([a-zA-Z])',
    re.IGNORECASE,
)

# Lines produced by deterministic schedule tables (e.g. "- DO #5 NB#2 — ... = 2,301 SF (172.58 tons)")
# must keep their exact layout untouched.
_SCHEDULE_LINE_RE = re.compile(
    r'^\s*(?:[-•]\s*)?(?:DO\s*#|Digout\s+Schedule|Grind\s*&\s*Overlay|Total\b.*SF\s*\()',
    re.IGNORECASE,
)

# Numeric/time range en-dash or em-dash ("7:00 AM–3:30 PM" -> "7:00 AM to 3:30 PM", "4–6" -> "4-6")
_TIME_DASH_RANGE_RE = re.compile(r'(\b\d{1,2}:\d{2}\s*(?:AM|PM))\s*[–—]\s*(\d{1,2}:\d{2}\s*(?:AM|PM)\b)', re.IGNORECASE)
_NUM_DASH_RANGE_RE = re.compile(r'(?<=\d)\s*[–—]\s*(?=\d)')
_PROSE_EM_DASH_RE = re.compile(r'\s*(?:—|―|--)\s*|\s+–\s+')
_SEMICOLON_CLAUSE_RE = re.compile(r'(?<!&\w)(?<!&#\d);\s*([a-zA-Z])')
_SPACED_AMP_RE = re.compile(r'\s+&\s+')

# Remaining prose parentheticals with whitespace before '(' (preserves "1535(b)"
# where '(' is attached directly to a word/number). Unwrapped into commas so zero
# facts or counts are lost while eliminating '( )' from prose.
_PROSE_PAREN_RE = re.compile(r'\s+\(([^()\n]+)\)')


def _match_case(replacement: str, original: str) -> str:
    """Capitalize replacement if the matched word started with an uppercase letter."""
    if original and original[0].isupper() and replacement:
        return replacement[0].upper() + replacement[1:]
    return replacement


def _clean_prose_line_symbols(line: str) -> str:
    """
    Normalize em-dashes, spaced en-dashes, semicolons, and spaced ampersands
    on a single prose/bullet line while leaving Digout Schedule and Time lines untouched.
    """
    if not line or _SCHEDULE_LINE_RE.match(line) or _TIME_LINE.match(line):
        return line

    updated = _TIME_DASH_RANGE_RE.sub(r'\1 to \2', line)
    updated = _NUM_DASH_RANGE_RE.sub('-', updated)
    if '—' in updated or '―' in updated or '--' in updated or ' – ' in updated:
        updated = _PROSE_EM_DASH_RE.sub(', ', updated)
        updated = re.sub(r'^([ \t]*•\s*),\s*', r'\1', updated)
        updated = re.sub(r',\s*([.,;:])', r'\1', updated)
        updated = re.sub(r',\s*,', ',', updated)
    if ';' in updated:
        updated = _SEMICOLON_CLAUSE_RE.sub(lambda m: f'. {m.group(1).upper()}', updated)
    if ' & ' in updated:
        updated = _SPACED_AMP_RE.sub(' and ', updated)
    return updated


def _unwrap_prose_parens_in_line(line: str) -> str:
    """
    Convert AI parenthetical asides in a single prose line into natural comma clauses,
    preserving every fact while removing '(' and ')'. Skips Digout Schedule lines.
    """
    if '(' not in line or _SCHEDULE_LINE_RE.match(line):
        return line

    def _repl(m: re.Match) -> str:
        inner = m.group(1).strip()
        if not inner:
            return ''
        return f', {inner},'

    updated = _PROSE_PAREN_RE.sub(_repl, line)
    # Clean up punctuation collisions produced when ')' sat before ',', '.', ';', or ':'
    updated = re.sub(r',\s*([.,;:])', r'\1', updated)
    updated = re.sub(r',\s*,', ',', updated)
    updated = re.sub(r':,\s*', ': ', updated)
    # Strip trailing comma at end of line if original line had no period
    updated = re.sub(r',\s*$', '', updated)
    return updated


def clean_inspector_prose(text: str, where: str = '') -> str:
    """
    Deterministic post-processor for AI-generated report summaries and general notes.

    Enforces the 197-item Master Exclusion List: strips invisible LLM characters,
    smart quotes, markdown formatting, emoji, dingbats, arrows, ellipses, em-dashes,
    semicolons, leaked cross-day lookup notices, third-person references to the
    Resident Engineer, AI sentence-opener clichés, stiff corporate buzzwords,
    slash-hedges, doublets, and parenthetical insertions while preserving 100% of
    facts, counts, stations, and Digout Schedule lines. Logs every cleanup trigger.
    """
    if not text or not isinstance(text, str):
        return text or ''

    original = text
    applied: list[str] = []

    # 0. Normalize invisible LLM characters, smart quotes, markdown, dingbats, arrows, emoji
    sym = _ZERO_WIDTH_RE.sub('', text)
    sym = _NBSP_RE.sub(' ', sym)
    sym = _SMART_DOUBLE_QUOTE_RE.sub('"', sym)
    sym = _SMART_SINGLE_QUOTE_RE.sub("'", sym)
    sym = _UNICODE_MINUS_RE.sub('-', sym)
    sym = _TRADEMARK_RE.sub('', sym)
    sym = _CHECK_EMOJI_RE.sub('', sym)
    sym = _CODE_FENCE_INLINE_RE.sub('', sym)
    sym = _DINGBAT_BULLET_RE.sub(r'\1• ', sym)
    sym = _MIDLINE_DINGBAT_RE.sub('', sym)
    sym = _MD_HEADING_QUOTE_RE.sub('', sym)
    sym = _MD_STAR_BULLET_RE.sub(r'\1• ', sym)
    sym = _BOLD_COLON_BULLET_RE.sub(lambda m: f"{m.group(1)}{m.group(2).upper()}", sym)
    sym = _MD_BOLD_RE.sub(lambda m: m.group(1) or m.group(2) or '', sym)
    sym = _MD_ITALIC_RE.sub(r'\1', sym)
    sym = _ARROW_RE.sub(' to ', sym)
    sym = _ELLIPSIS_RE.sub('.', sym)
    sym = re.sub(r'\.{2,}', '.', sym)
    sym = _APPROX_NUM_RE.sub('about ', sym)
    sym = _BRACKET_PLACEHOLDER_RE.sub('', sym)
    if sym != text:
        applied.append('ai_symbols_markdown')
        text = sym

    # 1. Strip leaked "No report exists for YYYY-MM-DD" sentences
    cleaned = _LEAKED_NO_REPORT_RE.sub('', text)
    if cleaned != text:
        applied.append('leaked_no_report')
        text = cleaned

    # 2. Collapse legal-style "seven (7)" -> "7"
    cleaned = _NUMBER_PAREN_RE.sub(r'\1', text)
    if cleaned != text:
        applied.append('number_parens')
        text = cleaned

    # 3. Collapse "12:00 AM (midnight)" -> "12:00 AM"
    cleaned = _CLOCK_PAREN_RE.sub(r'\1', text)
    if cleaned != text:
        applied.append('clock_parens')
        text = cleaned

    # 4. Replace "Best Management Practices (BMPs)" -> "BMPs"
    def _acronym_only(m: re.Match) -> str:
        for g in m.groups():
            if g:
                return g
        return m.group(0)

    cleaned = _REPLACE_WITH_ACRONYM_RE.sub(_acronym_only, text)
    if cleaned != text:
        applied.append('expanded_acronym')
        text = cleaned

    # 5. Drop redundant trailing acronym/alias tags: "cathodic protection (CP)" -> "cathodic protection"
    cleaned = _TRAILING_ACRONYM_TAG_RE.sub('', text)
    if cleaned != text:
        applied.append('trailing_acronym_tag')
        text = cleaned

    # 6. Strip AI sentence-opener transitions ("Furthermore, OHLA..." -> "OHLA...")
    cleaned = _AI_SENTENCE_OPENER_RE.sub(
        lambda m: m.group(1) + m.group(2).upper(),
        text,
    )
    if cleaned != text:
        applied.append('ai_sentence_openers')
        text = cleaned

    # 7. Fix third-person "The inspector visited..." -> "Visited...", meta-source talk, and self-attribution lines
    cleaned = _SELF_ATTRIBUTION_LINE_RE.sub('', text)
    cleaned = _WITNESSED_BY_RE.sub('I witnessed the test for the City', cleaned)
    cleaned = _SOURCE_META_TALK_RE.sub(
        lambda m: m.group(1) + m.group(2).upper(),
        cleaned,
    )
    cleaned = _THIRD_PERSON_RE_SELF.sub(
        lambda m: f"{m.group(1)}{m.group(2)[0].upper() + m.group(2)[1:]}",
        cleaned,
    )
    if cleaned != text:
        applied.append('third_person_inspector')
        text = cleaned

    # 8. Fix passive "A walkthrough was conducted" -> "Walked the site"
    cleaned = _PASSIVE_WALKTHROUGH_RE.sub(r'\1Walked the site', text)
    if cleaned != text:
        applied.append('passive_walkthrough')
        text = cleaned

    # 9. Strip decorative AI filler adjectives/adverbs while preserving sentence capitalization
    def _filler_repl(m: re.Match) -> str:
        nxt = m.group(1)
        if m.group(0)[0].isupper():
            start_idx = m.start()
            prefix = text[max(0, start_idx - 4):start_idx]
            if start_idx == 0 or re.search(r'[.!?•\n]\s*$', prefix):
                return nxt.upper()
        return nxt

    cleaned = _DECORATIVE_FILLER_RE.sub(_filler_repl, text)
    if cleaned != text:
        applied.append('decorative_filler')
        text = cleaned

    # 10. Replace stiff corporate vocabulary, slash-hedges, and doublets with plain field words
    vocab_hit = False
    for pattern, repl in _STIFF_VOCAB_RULES:
        next_text = pattern.sub(lambda m, r=repl: _match_case(r, m.group(0)), text)
        if next_text != text:
            vocab_hit = True
            text = next_text
    if vocab_hit:
        applied.append('stiff_vocab')

    # 11. Normalize line-level prose symbols (em-dashes, semicolons, spaced ampersands) & unwrap parens
    lines = text.split('\n')
    sym_lines = [_clean_prose_line_symbols(ln) for ln in lines]
    sym_joined = '\n'.join(sym_lines)
    if sym_joined != text:
        applied.append('prose_line_symbols')
        text = sym_joined

    unwrapped_lines = [_unwrap_prose_parens_in_line(ln) for ln in text.split('\n')]
    unwrapped = '\n'.join(unwrapped_lines)
    if unwrapped != text:
        applied.append('prose_parens_unwrapped')
        text = unwrapped

    # Tidy spaces before punctuation and double spaces inside lines without disturbing line breaks
    text = '\n'.join(
        re.sub(r' {2,}', ' ', re.sub(r' +([.,!?;:])', r'\1', ln)).rstrip()
        for ln in text.split('\n')
    ).strip()

    if applied and text != original:
        logger.info(
            '[clean_inspector_prose:%s] Applied %s (%d -> %d chars)',
            where or 'ai', ', '.join(applied), len(original), len(text),
        )

    return text

