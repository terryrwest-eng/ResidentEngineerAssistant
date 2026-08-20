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
        phase: str = '',
        print_label: str = '',
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
        # WHEN it is asked: 'start', 'during' or 'end'.
        #
        # The interview runs in the order the shift runs - every starting
        # station, then the work as it progressed, then every ending station
        # and count. The PRINTED report keeps its own section order, because
        # the two are answering different needs: one is the sequence of the
        # day, the other is the layout the owner reads. A question therefore
        # belongs to a printed section AND to a phase, and the two are
        # independent.
        self.phase = phase
        # How the answer reads in the printed report.
        #
        # A short answer is a bare value - "Sta 143+98.80" - and a column of
        # those under a heading tells the reader nothing about which station is
        # which. The label turns it into a sentence. Narrative answers already
        # read as sentences and take no label.
        self.print_label = print_label

    def to_dict(self) -> dict[str, Any]:
        return {
            'id': self.id,
            'prompt': self.prompt,
            'kind': self.kind,
            'help': self.help,
            'required': self.required,
            'gate': self.gate,
            'example': self.example,
            'phase': self.phase,
            'print_label': self.print_label,
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
        repeats: bool = False,
        repeat_prompt: str = '',
        repeat_from: str = '',
        repeat_label: str = '',
    ):
        self.id = id
        self.number = number
        self.title = title
        self.questions = questions
        self.empty_statement = empty_statement
        # A repeating section is asked once per thing it describes. Morena runs
        # several locations a day and each is its own activity with its own
        # crew, stations and quantities — asking about "the day" in one pass is
        # exactly how a location gets left out.
        self.repeats = repeats
        # Asked after each pass: yes runs the section again.
        self.repeat_prompt = repeat_prompt
        # Better than asking "another?" every pass: name them all once, and the
        # count of passes IS the answer. The inspector knows where they worked
        # today; being asked to confirm it eight separate times is friction, and
        # a list read back is far easier to check than a decision repeated.
        self.repeat_from = repeat_from
        # Which field each item pre-fills — the location becomes the first part
        # of that activity's title, so it is never typed twice.
        self.repeat_label = repeat_label

    def to_dict(self) -> dict[str, Any]:
        return {
            'id': self.id,
            'number': self.number,
            'title': self.title,
            'empty_statement': self.empty_statement,
            'repeats': self.repeats,
            'repeat_prompt': self.repeat_prompt,
            'repeat_from': self.repeat_from,
            'repeat_label': self.repeat_label,
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
            # ── START ────────────────────────────────────────────────────────
            Question(
                'starting_stations',
                'Starting stations — where did excavation, pipe and backfill begin?',
                'segments', phase='start', required=True,
                help='All three in one answer. Name only the ones that ran today.',
                example='Excavation Sta 143+98.80, pipe Sta 143+98.31, backfill Sta 144+20',
                extract_hint=(
                    'One row per operation the speaker named, each as '
                    '{"item": "Excavation: Sta 143+98.80"}. Keep every figure exactly as '
                    'spoken. Include ONLY the operations they mentioned — an operation '
                    'that did not run today must never appear with a blank or a guessed '
                    'station.'
                ),
                print_label='Starting stations',
            ),


            Question(
                'shoring_start', 'What shoring is in, and from what station?',
                'narrative', phase='start',
                example='Shoring boxes set from Sta 143+98, guardrails installed',
            ),
            Question(
                'dewatering_start',
                'Was dewatering running at the start — and if so, what is pumping and where is it discharging?',
                'narrative', phase='start',
                print_label='Dewatering',
            ),


            # ── DURING ───────────────────────────────────────────────────────
            Question(
                'joints_installed',
                'Which joints of pipe were laid? Give each joint number with its start and end station.',
                'segments', phase='during',
                help='A joint is one piece of pipe. Say them one after another.',
                example='MK-119: Sta 143+98.31 to Sta 143+59.06',
                extract_hint=(
                    'A JOINT here is one piece of pipe, and the joint number is that '
                    'piece\'s number. One entry per joint: the joint number, its start '
                    'station and its end station. Keep every figure exactly as spoken. '
                    'Never interpolate a joint that was not named, and never infer a '
                    'station from the one before it. Do NOT put welds in this answer - '
                    'welds are numbered separately and asked about next.'
                ),
                print_label='Joints of pipe laid',
            ),
            Question(
                'welds_made',
                'Which welds were made? Give each weld number, its station, and the two joints it ties together.',
                'segments', phase='during',
                help='Welds carry their own numbers — not the joint numbers.',
                example='W-118: Sta 143+59.06, joins MK-119 to MK-120, interior and exterior',
                extract_hint=(
                    'A WELD has its OWN number, which is NOT a joint number. One entry '
                    'per weld: the weld number, the station, and the two pipe joints it '
                    'connects. Note interior or exterior if it was said. Never label a '
                    'weld with a joint number, and never assume two joints were welded '
                    'just because they are adjacent.'
                ),
                print_label='Welds made',
            ),
            Question(
                'welds_grouted',
                'Which welds were grouted?',
                'segments', phase='during',
                help='Grouting is what follows a weld.',
                example='W-118 at Sta 143+59.06',
                extract_hint=(
                    'Grouting is done AFTER a weld, at the joint the weld connected. One '
                    'entry per weld grouted: the weld number and the station. If the '
                    'speaker identified it by the joints rather than a weld number, keep '
                    'exactly what they said rather than converting it.'
                ),
                print_label='Welds grouted',
            ),
            Question(
                'patching_done',
                'Was any patching done — any concrete or mortar repair?',
                'yesno', phase='during',
            ),
            Question(
                'patching_detail',
                'What was patched, where, and what was wrong with it?',
                'segments', gate='patching_done', phase='during',
                help='Weld grout, pipe lining or coating, a structure — anything concrete.',
                example='W-116 at Sta 144+38 — cracked grout, interior, repaired',
                extract_hint=(
                    'Patching is a REPAIR of concrete or mortar that cracked, spalled or '
                    'came up deficient. It covers grout at a weld, the pipe lining or '
                    'exterior coating, and cast structures such as thrust blocks, vaults '
                    'and encasement. It is a repair, not a scheduled step, so never '
                    'record it for a weld simply because that weld was grouted. '
                    'One entry per patch: WHAT was patched (weld number, pipe joint, or '
                    'the structure), WHERE (station or structure), and the defect that '
                    'caused it. Note interior or exterior if it was said. Record the '
                    'defect as observed and do not attribute cause or fault.'
                ),
                print_label='Concrete and mortar patching',
            ),
            Question(
                'bedding_placed',
                'What bedding went in, between which stations, and was it brought to grade?',
                'narrative', phase='during',
                example='SE-30 sand bedding placed to grade from Sta 143+98 to Sta 143+59',
            ),
            Question(
                'fittings_installed',
                'Any valves, fittings, blowoffs or air-vacs installed?',
                'narrative', phase='during',
                example='16-inch blowoff assembly set at Sta 143+20',
                extract_hint='Keep sizes, types and stations exactly as spoken.',
            ),
            Question(
                'testing_done',
                'Any testing or survey today — density, hydrotest, pressure, vacuum, CCTV, line and grade?',
                'yesno', phase='during',
            ),
            Question(
                'testing_detail',
                'What was tested, where, and what was the result?',
                'narrative', gate='testing_done', phase='during',
                example='Density test at Sta 143+70, 95 percent, passed',
                extract_hint=(
                    'Record what was tested, the station, the value and the result as '
                    'stated. Naming the spec the result was measured against is expected. '
                    'Never state a pass or a fail that was not said.'
                ),
            ),

            Question(
                'unforeseen_conditions',
                'Did you hit anything unforeseen — water, utilities, bad soil?',
                'yesno', phase='during',
                help='Perched water, an unmarked utility, unsuitable material.',
            ),
            Question(
                'unforeseen_detail',
                'What was it, and between which stations?',
                'narrative', gate='unforeseen_conditions', phase='during',
                example='Perched water from Sta 143+98.31 to Sta 143+59.06',
                extract_hint=(
                    'State the condition and the station limits it was found between. '
                    'Do not speculate about cause or responsibility.'
                ),
            ),
            Question(
                'deliveries',
                'Any material deliveries?',
                'narrative', phase='during',
                example='12 joints of 36-inch pipe delivered, staged at the north end',
                extract_hint='Keep quantities and material descriptions exactly as spoken.',
            ),
            Question(
                'highline_flushing',
                'Was there any highline flushing or temporary water work?',
                'yesno', phase='during',
            ),
            Question(
                'highline_detail',
                'Where, between what times, why, and when was the temperature last verified?',
                'narrative', gate='highline_flushing', phase='during',
                example=(
                    'Morena Blvd. and Paul Jones Ave., 3:00 PM to 4:00 PM, to mitigate '
                    'elevated afternoon water temperatures; verified normal at 11:00 AM'
                ),
                extract_hint='Keep both clock times and the locations exactly as spoken.',
            ),

            # ── END ──────────────────────────────────────────────────────────
            Question(
                'ending_stations',
                'Ending stations — where did excavation, pipe and backfill end?',
                'segments', phase='end', required=True,
                help='All three in one answer. Name only the ones that ran today.',
                example='Excavation Sta 142+39.77, pipe Sta 142+39.77, backfill Sta 143+98.34',
                extract_hint=(
                    'One row per operation the speaker named, each as '
                    '{"item": "Excavation: Sta 142+39.77"}. Keep every figure exactly as '
                    'spoken. Include ONLY the operations they mentioned.'
                ),
                print_label='Ending stations',
            ),

            Question(
                'joints_count', 'Day totals — how many joints laid, welds made, welds grouted, and patches?',
                'text', phase='end',
                help='One line is fine — "4 joints, 3 welds, 3 grouted, 1 patch".',
                example='4 joints laid, 3 welds, 3 grouted, 1 patch',
                extract_hint=(
                    'The counts the inspector states, in their words. Leave out anything '
                    'they did not say. NEVER derive a count from the lists answered '
                    'earlier - the two disagree the moment something was described '
                    'without being enumerated, and the stated number is the one that '
                    'belongs in the record.'
                ),
                print_label='Day totals',
            ),



            Question(
                'footage_installed', 'How much pipe went in today, in linear feet?',
                'text', phase='end',
                example='160 LF',
                extract_hint='Keep the figure and unit exactly. Never compute it from stations.',
                print_label='Pipe installed today',
            ),
        ],
        empty_statement='No pipe installation or trench excavation was performed this shift.',
    ),

    Section(
        'tm_tracking', 2, 'Time & Material (T&M) Tracking',
        [
            Question('tm_occurred', 'Was any time and material work done today?', 'yesno', phase='during'),
            Question(
                'tm_work', 'What was done on T&M, and what drove it?',
                'narrative', gate='tm_occurred', phase='during',
                example=(
                    'Pumped perched water into a water truck with a submersible pump and '
                    'placed 3/4-inch gravel bedding'
                ),
                extract_hint=(
                    'Report what was done and the condition that caused it. If a delay '
                    'occurred, state the delay as a fact. Do not characterise it as the '
                    "contractor's fault or as entitlement to extra payment - that is a "
                    'claim, not an observation.'
                ),
            ),
            Question(
                'tm_window', 'What time window did it cover, and what was completed in it?',
                'narrative', gate='tm_occurred', phase='end',
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
                'backfill_material',
                'What material is being placed, in what lifts, and how was it compacted?',
                'text', phase='during',
                example='SE-30 sand in 12-inch lifts',
                print_label='Backfill material',
            ),


        ],
        empty_statement='No backfilling or bedding was performed this shift.',
    ),

    Section(
        'field_instructions', 4, 'Field Instructions & Engineering Recommendations',
        [
            Question(
                'instructions_given',
                'Did you give the contractor any instructions or recommendations?',
                'yesno', phase='end',
            ),
            Question(
                'instructions_detail', 'What did you tell them, and why?',
                'narrative', gate='instructions_given', phase='end',
                example=(
                    'Instructed to keep larger dewatering pumps on site; reminded of the '
                    'obligation to notify the RE on encountering unforeseen conditions'
                ),
                extract_hint=(
                    "These are the RE's own directions, so they are stated as given: "
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
                'yesno', phase='during',
            ),
            Question(
                'monitors_detail',
                'Who was here, from which firm, and what were they observing?',
                'narrative', gate='monitors_present', phase='during',
                example='Environmental monitors from Redtail and Stantec present throughout the shift',
                extract_hint='Keep firm names exactly as spoken.',
            ),
            Question(
                'safety_event', 'Any safety incidents, near misses, stop-work or confined space entry?',
                'yesno', phase='during',
            ),
            Question(
                'safety_detail', 'What happened, and what was done about it?',
                'narrative', gate='safety_event', phase='during',
            ),

        ],
        empty_statement='No outside inspectors or monitors were on site this shift.',
    ),

    Section(
        'bmps', 6, 'Best Management Practices (BMPs)',
        [
            Question(
                'traffic_control', 'What traffic control was set, and where?',
                'narrative', phase='start',
                example='Morena Blvd northbound, number 2 lane closed, flaggers at both ends',
                extract_hint='Capture the street, the direction of travel and which lanes were closed.',
            ),
            Question(
                'bmp_measures',
                'What BMP work happened — dust control, sweeping, sandbags?',
                'narrative', phase='during',
                example='Water truck sprinkled the work area for dust control; roadway swept with a skid steer',
                extract_hint='Write BMP as the acronym. Never expand it.',
            ),
            Question(
                'bmp_directives', 'Did you direct any BMP maintenance or repairs?',
                'narrative', phase='end',
                example='Directed replacement of damaged sandbags and covering of exposed highlines on Morena Blvd.',
            ),
        ],
        empty_statement='No BMP work was performed or directed this shift.',
    ),

    Section(
        'labor', 7, 'Labor Force Tracking',
        [
            Question(
                'shift_start', 'What time did the crew start?',
                'time', phase='start', required=True,
                print_label='Crew start time',
            ),
            Question(
                'crew',
                'Who was on site today — how many foremen, operators and laborers?',
                'crew', required=True, phase='start',
                help='Say part-time as you would write it, e.g. "one foreman, half time".',
                example='Foreman: 1 (Half-Time), Operators: 2, Laborers: 5',
                extract_hint=(
                    'One row per trade with a count. Keep any part-time note attached to '
                    'the trade it belongs to. Never round a headcount or invent a trade '
                    'that was not named.'
                ),
            ),
            Question(
                'shift_end', 'What time did the crew stop?',
                'time', phase='end',
                print_label='Crew stop time',
            ),
        ],
        empty_statement='No contractor labor force was on site this shift.',
    ),

    Section(
        'equipment', 8, 'Equipment Log',
        [
            Question(
                'equipment', 'What equipment was on site, and was anything idle or broken down?',
                'equipment', required=True, phase='start',
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

    Section(
        'close_out', 9, 'End of Shift',
        [
            Question(
                'trench_secured',
                'How was the trench left, and is dewatering running overnight?',
                'narrative', phase='end', required=True,
                example='Trench plated from Sta 143+59 to Sta 142+40; K-rail left in place',
                extract_hint='Record how the excavation was left and what secured it.',
            ),


            Question(
                'anything_else',
                'What is planned for tomorrow, and anything else for the record?',
                'narrative', phase='end',
                help="Tomorrow's plan, plus whatever you would mention if asked how the day went.",
                print_label='Looking ahead',
                extract_hint=(
                    'Report the plan as what the contractor stated they intend to do, '
                    'not as a commitment or a schedule finding. Keep anything else said '
                    'as a separate line.'
                ),
            ),
        ],
        empty_statement='Nothing further to report.',
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
        'day', 1, 'The Day',
        [
            Question(
                'locations',
                'What locations had work activity today?',
                'list', required=True,
                help='Name them all in one go — the report walks through them one at a time.',
                example='Main St and 2nd Ave, Sta 10+50, the Genesee tie-in',
                extract_hint=(
                    'One entry per distinct location or work area named. Keep each '
                    'exactly as spoken, including street names and station numbers. '
                    'Do NOT invent a location that was not named, and do not split '
                    'one location into two because it has several parts to its name.'
                ),
            ),
        ],
        empty_statement='No work was performed this shift.',
    ),

    # Asked once per location named above. The count of passes IS the answer to
    # question 1, and each location pre-fills the first part of that activity's
    # title, so it is never typed twice.
    Section(
        'activity', 2, 'Work Performed',
        [
            Question(
                'start_time',
                'What time did the crew start?',
                'time', required=True,
            ),
            Question(
                'stop_time',
                'What time did they stop, or plan to stop?',
                'time', required=True,
            ),
            Question(
                'lunch_deducted',
                'Take a half hour off for lunch?',
                'yesno',
                help='Yes deducts 0.5 from every crew member on this activity.',
            ),
            Question(
                'stations',
                'Is there any stationing to attach?',
                'station_range',
                example='Sta 10+00 to Sta 12+50',
                extract_hint=(
                    'Keep the figures exactly as spoken. If no stationing was given, '
                    'leave this empty rather than deriving one from the location name.'
                ),
            ),
            Question(
                'traffic_control',
                'Was traffic control involved?',
                'yesno',
            ),
            Question(
                'traffic_control_detail',
                'What area was it in, which direction of travel, and which lanes were closed?',
                'narrative', gate='traffic_control',
                example='Morena Blvd northbound, number 2 lane and the bike lane closed',
                extract_hint=(
                    'Capture all three: the area, the direction of travel, and which '
                    'lanes were closed. If one of the three was not stated, say so in '
                    '"missing" rather than filling it in.'
                ),
            ),
            Question(
                'summary',
                'Summary of work at this location.',
                'narrative', required=True,
                extract_hint=(
                    'One bullet per distinct piece of work, in the order it happened. '
                    'Keep every station, quantity, measurement and material exactly as '
                    'spoken.'
                ),
            ),
            Question(
                'crew',
                'How many of each craft were on this activity?',
                'crew', required=True,
                example='1 foreman, 2 operators, 4 laborers',
                extract_hint=(
                    'One row per craft with a count. Names too if they were given. '
                    'Never round a headcount or add a craft that was not named.'
                ),
            ),
            Question(
                'equipment',
                'How many of each equipment type?',
                'equipment', required=True,
                example='2 excavators, 1 loader, 3 dump trucks',
                extract_hint=(
                    'One row per equipment type with a count. Keep makes and model '
                    'numbers exactly as spoken.'
                ),
            ),
            Question(
                'anything_missed',
                'Anything else at this location?',
                'narrative',
                help='Deliveries, testing, a delay, a visitor, something that went sideways.',
                extract_hint=(
                    "Whatever was said, in the inspector's voice. This is the catch-all "
                    'for things the earlier questions did not ask about.'
                ),
            ),
        ],
        empty_statement='No work was performed at this location.',
        repeats=True,
        repeat_from='locations',
        repeat_label='work_area',
    ),

    Section(
        'day_close', 3, 'Anything Else',
        [
            Question(
                'extra_occurred',
                'Was any extra work or T&M done today?',
                'yesno',
            ),
            Question(
                'extra_detail',
                'What was it, and who directed it?',
                'narrative', gate='extra_occurred',
                extract_hint=(
                    'State what was done and who directed it. Report a delay or a '
                    "condition as a fact; never repeat the contractor's claim that it "
                    'is compensable.'
                ),
            ),
            Question(
                'visitors',
                'Any visitors, inspections, deliveries or consultants on site?',
                'narrative',
                extract_hint='Keep names and firms exactly as spoken.',
            ),
            Question(
                'day_missed',
                'Anything about today we have not covered?',
                'narrative',
                help='The thing you would mention if someone asked how the day went.',
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
