"""
Daily Reporter V3 — Report profiles (per-project format + interview)

WHY THIS EXISTS: a second job arrived with a completely different daily report.
Morena Conveyance North is per-activity tables. Tecolote Channel is eight
numbered narrative sections plus rolled-up crew and equipment counts. The old
app had exactly one hardcoded layout, so the format was a property of the code
rather than of the project.

A profile is the single description of one project's report:
  - the sections it prints, in order
  - every question needed to fill them
  - what to print when the answer is "nothing today"

Both the interview and the export read from the same profile, so a question can
never drift out of sync with the section it feeds — adding a field to the
printed report means adding the question that supplies it, in one place.

THE INTERVIEW IS THE POINT. Working free-form means remembering what the format
wants. Being asked means it is impossible to leave a section blank without
saying so on purpose. Every answer is speakable: the question is the prompt, the
recording is the answer, and the model has one narrow job — pull this one
field out of this one recording — which is far more reliable than asking it to
parse a whole day at once.
"""

from typing import Any, Literal

# What kind of answer a question wants. The UI picks its input from this, and
# the extractor uses it to know what shape to pull out of the speech.
QuestionKind = Literal[
    'time',           # a clock time -> "7:30 AM"
    'text',           # one short line
    'narrative',      # spoken paragraph -> cleaned bullets in the RE's voice
    'station_range',  # "from Sta 143+98.80 to Sta 142+39.77"
    'segments',       # repeating: mark number + station from/to
    'crew',           # manpower rows -> rolled up for section 7
    'equipment',      # equipment rows -> grouped for section 8
    'yesno',          # gate: did this happen at all today
]


class Question:
    """
    One thing the app asks. `prompt` is read aloud to the inspector, so it is
    written the way a person would ask it, not the way a form labels a field.
    """

    def __init__(
        self,
        id: str,
        prompt: str,
        kind: QuestionKind = 'narrative',
        *,
        help: str = '',
        required: bool = False,
        gate: str = '',
        example: str = '',
        extract_hint: str = '',
    ):
        self.id = id
        self.prompt = prompt
        self.kind = kind
        self.help = help
        self.required = required
        # Only asked when this other question was answered yes. Keeps the
        # interview short on a day where a whole topic did not happen.
        self.gate = gate
        self.example = example
        # Handed to the model along with the transcript. Narrow, per-field
        # instructions beat one giant parsing prompt.
        self.extract_hint = extract_hint

    def to_dict(self) -> dict[str, Any]:
        return {
            'id': self.id,
            'prompt': self.prompt,
            'kind': self.kind,
            'help': self.help,
            'required': self.required,
            'gate': self.gate,
            'example': self.example,
        }


class Section:
    """
    One numbered section of the printed report.

    `empty_statement` is printed when the inspector answers "nothing today".
    The section still appears: a heading with a clear sentence under it records
    that the topic was considered and had nothing, which is a different fact
    from a section that was never filled in.
    """

    def __init__(
        self,
        id: str,
        number: int,
        title: str,
        questions: list[Question],
        *,
        empty_statement: str = 'Nothing to report for this section.',
    ):
        self.id = id
        self.number = number
        self.title = title
        self.questions = questions
        self.empty_statement = empty_statement

    def to_dict(self) -> dict[str, Any]:
        return {
            'id': self.id,
            'number': self.number,
            'title': self.title,
            'empty_statement': self.empty_statement,
            'questions': [q.to_dict() for q in self.questions],
        }


# ============================================
# Tecolote Channel — Construction Daily Progress Report
# Mapped field by field from the format supplied by the RE.
# ============================================

TECOLOTE_SECTIONS = [
    Section(
        'work_summary', 1, 'Work Summary & Pipe Installation',
        [
            Question(
                'excavation_range',
                'Where did trench excavation run today — from what station to what station?',
                'station_range', required=True,
                example='Sta 143+98.80 to Sta 142+39.77',
                extract_hint=(
                    'Two stations, a start and an end. Keep the exact figures spoken, '
                    'including decimals. Format each as "Sta XX+XX.XX".'
                ),
            ),
            Question(
                'unforeseen_conditions',
                'Did you hit anything unforeseen — water, utilities, bad soil?',
                'yesno',
                help='Perched water, an unmarked utility, unsuitable material.',
            ),
            Question(
                'unforeseen_detail',
                'What was it, and between which stations?',
                'narrative', gate='unforeseen_conditions',
                example='Perched water from Sta 143+98.31 to Sta 143+59.06',
                extract_hint=(
                    'State the condition and the station limits it was found between. '
                    'Do not speculate about cause or responsibility.'
                ),
            ),
            Question(
                'shoring',
                'What went in for shoring, and were the guardrails installed?',
                'narrative',
                example='Shoring boxes installed progressively as excavation advanced; guardrails installed',
            ),
            Question(
                'bedding_material',
                'What bedding went in, and was it brought to grade?',
                'text',
                example='SE-30 sand bedding placed to grade',
            ),
            Question(
                'pipe_segments',
                'Which pipe segments were installed? Give the mark number and the stations for each.',
                'segments',
                help='Say them one after another — "MK-119, 143+98.31 to 143+59.06, next one..."',
                example='MK-119: Sta 143+98.31 to Sta 143+59.06',
                extract_hint=(
                    'One entry per segment: mark number, start station, end station. '
                    'Keep every figure exactly as spoken. Never merge or interpolate '
                    'segments the speaker did not name.'
                ),
            ),
            Question(
                'pipe_size',
                'What size and type of pipe?',
                'text', example='36-inch water main',
            ),
            Question(
                'highline_flushing',
                'Was there any highline flushing today?',
                'yesno',
            ),
            Question(
                'highline_detail',
                'Where, between what times, and why — and when was the temperature last verified?',
                'narrative', gate='highline_flushing',
                example=(
                    'Morena Blvd. and Paul Jones Ave., 3:00 PM to 4:00 PM, to mitigate '
                    'elevated afternoon water temperatures; verified normal at 11:00 AM'
                ),
                extract_hint='Keep both clock times and the locations exactly as spoken.',
            ),
        ],
        empty_statement='No pipe installation or trench excavation was performed this shift.',
    ),

    Section(
        'tm_tracking', 2, 'Time & Material (T&M) Tracking',
        [
            Question(
                'tm_occurred',
                'Was any time and material work done today?',
                'yesno',
            ),
            Question(
                'tm_work',
                'What was done on T&M, and what drove it?',
                'narrative', gate='tm_occurred',
                example=(
                    'Pumped perched water into a water truck with a submersible pump and '
                    'placed 3/4-inch gravel bedding'
                ),
                extract_hint=(
                    'Report what was done and the condition that caused it. If a delay '
                    'occurred, state the delay as a fact. Do not characterise it as '
                    'the contractor\'s fault or as entitlement to extra payment — that '
                    'is a claim, not an observation.'
                ),
            ),
            Question(
                'tm_window',
                'What time window did it cover, and what was completed in it?',
                'narrative', gate='tm_occurred',
                example='7:30 AM to 1:30 PM — excavation, gravel sub-bedding, MK-119 installed',
                extract_hint=(
                    'Keep the clock times exactly. If the window mixes contract work with '
                    'T&M work, say so plainly.'
                ),
            ),
        ],
        empty_statement='No time and material work was performed this shift.',
    ),

    Section(
        'backfill', 3, 'Backfilling & Bedding',
        [
            Question(
                'backfill_occurred',
                'Did a second crew run backfill or bedding today?',
                'yesno',
            ),
            Question(
                'backfill_detail',
                'What material, up to what station, and was it inspected?',
                'narrative', gate='backfill_occurred',
                example='SE-30 sand bedding placed and graded up to Sta 143+98.34 under inspection',
            ),
        ],
        empty_statement='No separate backfilling or bedding crew worked this shift.',
    ),

    Section(
        'field_instructions', 4, 'Field Instructions & Engineering Recommendations',
        [
            Question(
                'instructions_given',
                'Did you give the contractor any instructions or recommendations?',
                'yesno',
            ),
            Question(
                'instructions_detail',
                'What did you tell them, and why?',
                'narrative', gate='instructions_given',
                example=(
                    'Instructed to keep larger dewatering pumps on site; reminded of the '
                    'obligation to notify the RE on encountering unforeseen conditions'
                ),
                extract_hint=(
                    'These are the RE\'s own directions, so they are stated as given: '
                    '"the contractor was instructed to...", "the contractor was reminded '
                    'that...". Naming the contract obligation behind an instruction is '
                    'correct and expected here.'
                ),
            ),
        ],
        empty_statement='No field instructions or engineering recommendations were issued this shift.',
    ),

    Section(
        'inspection', 5, 'Site Inspection & Monitoring',
        [
            Question(
                'monitors_present',
                'Were any monitors, inspectors or agency reps on site?',
                'yesno',
            ),
            Question(
                'monitors_detail',
                'Who was here, from which firm, and what were they observing?',
                'narrative', gate='monitors_present',
                example='Environmental monitors from Redtail and Stantec present throughout the shift',
                extract_hint='Keep firm names exactly as spoken.',
            ),
        ],
        empty_statement='No outside inspectors or monitors were on site this shift.',
    ),

    Section(
        'bmps', 6, 'Best Management Practices (BMPs)',
        [
            Question(
                'bmp_measures',
                'What BMP work happened — dust control, sweeping, sandbags?',
                'narrative',
                example='Water truck sprinkled the work area for dust control; roadway swept with a skid steer',
                extract_hint='Write BMP as the acronym. Never expand it.',
            ),
            Question(
                'bmp_directives',
                'Did you direct any BMP maintenance or repairs?',
                'narrative',
                example='Directed replacement of damaged sandbags and covering of exposed highlines on Morena Blvd.',
            ),
        ],
        empty_statement='No BMP work was performed or directed this shift.',
    ),

    Section(
        'labor', 7, 'Labor Force Tracking',
        [
            Question(
                'crew',
                'Who was on site today — how many foremen, operators and laborers?',
                'crew', required=True,
                help='Say part-time as you would write it, e.g. "one foreman, half time".',
                example='Foreman: 1 (Half-Time), Operators: 2, Laborers: 5',
                extract_hint=(
                    'One row per trade with a count. Keep any part-time note attached to '
                    'the trade it belongs to. Never round a headcount or invent a trade '
                    'that was not named.'
                ),
            ),
        ],
        empty_statement='No contractor labor force was on site this shift.',
    ),

    Section(
        'equipment', 8, 'Equipment Log',
        [
            Question(
                'equipment',
                'What equipment was on site?',
                'equipment', required=True,
                help='Machines, trucks and support units — makes and models if you have them.',
                example='2 CAT 335 Excavators, 1 CAT 950 Wheel Loader, 4 Dump Trucks, 1 Water Truck',
                extract_hint=(
                    'One row per machine type with a count. Keep makes and model numbers '
                    'exactly as spoken (CAT 335, 3500 series). Note anything described as '
                    'active or idle.'
                ),
            ),
        ],
        empty_statement='No contractor equipment was on site this shift.',
    ),
]


# Equipment groupings used by the Tecolote export. A machine falls in the first
# group whose keywords it matches; anything unmatched prints under Support Units
# rather than being dropped.
TECOLOTE_EQUIPMENT_GROUPS = [
    ('Heavy Machinery', [
        'excavator', 'loader', 'skid steer', 'skidsteer', 'dozer', 'bulldozer',
        'grader', 'backhoe', 'crane', 'roller', 'compactor',
    ]),
    ('Hauling & Logistics', [
        'dump truck', 'haul', '10-wheeler', 'ten wheeler', 'transfer', 'lowboy',
        'flatbed', 'trailer',
    ]),
    ('Support Units', []),  # catch-all — must stay last
]


# ============================================
# Morena Conveyance North — the original format, now also asked as questions
# ============================================

MORENA_SECTIONS = [
    Section(
        'arrival', 1, 'Shift',
        [
            Question(
                'start_time', 'What time did you get on site?', 'time', required=True,
            ),
            Question(
                'stop_time', 'What time did work stop?', 'time',
            ),
        ],
        empty_statement='Shift times were not recorded.',
    ),
    Section(
        'activities', 2, 'Work Performed',
        [
            Question(
                'activity_walkthrough',
                'Walk me through the day — each location, what was worked on there, and the stations.',
                'narrative', required=True,
                help='One location at a time. Say "next activity" when you move on.',
                extract_hint=(
                    'Split by location into separate activities. Keep every station, '
                    'quantity and measurement exactly as spoken.'
                ),
            ),
        ],
        empty_statement='No work was performed this shift.',
    ),
    Section(
        'resources', 3, 'Manpower & Equipment',
        [
            Question('crew', 'Who was on site, and for which activity?', 'crew'),
            Question('equipment', 'What equipment was used, and where?', 'equipment'),
        ],
        empty_statement='No crew or equipment was on site this shift.',
    ),
    Section(
        'extra_work', 4, 'Extra Work',
        [
            Question('extra_occurred', 'Was any extra work or T&M done today?', 'yesno'),
            Question(
                'extra_detail', 'What was it, and who authorised it?',
                'narrative', gate='extra_occurred',
                extract_hint=(
                    'State what was done and who directed it. Report a delay or a '
                    'condition as a fact; never repeat the contractor\'s claim that it '
                    'is compensable.'
                ),
            ),
        ],
        empty_statement='No extra work was performed this shift.',
    ),
    Section(
        'notes', 5, 'Notes',
        [
            Question(
                'visitors', 'Any visitors, inspections or deliveries?', 'narrative',
            ),
            Question(
                'issues', 'Anything that held the work up?', 'narrative',
            ),
        ],
        empty_statement='Nothing further to report.',
    ),
]


class ReportProfile:
    """One project's report format and the interview that fills it."""

    def __init__(
        self,
        key: str,
        project_name: str,
        title: str,
        sections: list[Section],
        *,
        contractor: str = '',
        renderer: str = 'classic',
    ):
        self.key = key
        self.project_name = project_name
        self.title = title
        self.sections = sections
        self.contractor = contractor
        # Which export layout to print. 'classic' is the original per-activity
        # tables; 'tecolote' is the numbered narrative format.
        self.renderer = renderer

    def question_count(self) -> int:
        return sum(len(s.questions) for s in self.sections)

    def to_dict(self) -> dict[str, Any]:
        return {
            'key': self.key,
            'project_name': self.project_name,
            'title': self.title,
            'contractor': self.contractor,
            'renderer': self.renderer,
            'question_count': self.question_count(),
            'sections': [s.to_dict() for s in self.sections],
        }


PROFILES: dict[str, ReportProfile] = {
    'morena': ReportProfile(
        'morena',
        'Morena Conveyance North',
        'Daily Inspection Report',
        MORENA_SECTIONS,
        contractor='OHL',
        renderer='classic',
    ),
    'tecolote': ReportProfile(
        'tecolote',
        'Tecolote Channel',
        'Construction Daily Progress Report',
        TECOLOTE_SECTIONS,
        contractor='OHLA',
        renderer='tecolote',
    ),
}

# Projects are chosen by name in the UI and stored by name on the report, so a
# report written before profiles existed still resolves to the right format.
_BY_PROJECT_NAME = {p.project_name.lower(): p for p in PROFILES.values()}


def get_profile(key_or_project: str) -> ReportProfile:
    """
    Resolve a profile from either its key or the project name on a report.

    Falls back to the original format rather than raising: an unrecognised
    project must still produce a report, and the classic layout is the one that
    every existing report already uses.
    """
    if not key_or_project:
        return PROFILES['morena']
    needle = key_or_project.strip().lower()
    if needle in PROFILES:
        return PROFILES[needle]
    if needle in _BY_PROJECT_NAME:
        return _BY_PROJECT_NAME[needle]
    for name, profile in _BY_PROJECT_NAME.items():
        if needle in name or name in needle:
            return profile
    return PROFILES['morena']


def list_profiles() -> list[dict[str, Any]]:
    """Every profile, for the project picker that opens a new report."""
    return [
        {
            'key': p.key,
            'project_name': p.project_name,
            'title': p.title,
            'contractor': p.contractor,
            'question_count': p.question_count(),
        }
        for p in PROFILES.values()
    ]
