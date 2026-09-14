"""
Daily Reporter V4 — the day record

WHY THIS EXISTS: V3 parses every answer in isolation, on purpose — "a narrow
question is a reliable question", and that is right. But it means nothing ever
holds the whole day at once, so the writer only ever sees one activity's rough
notes. A model that never sees the whole day cannot write about the whole day.
It can only rephrase fragments, which is exactly what the output reads like.

The day record is the missing middle. The conversation fills it, one fact at a
time, with the same narrow extraction V3 already does well. The composer reads
it — all of it — and writes. Nothing else is allowed to write report prose.

THE FOUR STATES ARE THE POINT. V3's AnswerResponse already carries
`ok | empty | suspect | failed` for a single answer. This carries the same
judgement for every slot in the day, because the property that matters is not
"did we get an answer" but "do we know this well enough to print it".

    ok       said plainly and understood
    empty    never came up — so ASK
    suspect  heard something, not confident — ask again, specifically
    na       genuinely did not happen, and we know why

`empty` and `suspect` are not answers. They are work to do. V3 treated a gap as
something to report back at the end, and that is the wrong instinct: the person
who can close the gap is standing right there, talking. The record's job is to
know precisely what is still unknown so the conversation can go and get it, and
`next_targets()` is what it hands the interviewer to ask about next.

A gap only becomes something to report when asking has genuinely failed — the
inspector does not know, or three attempts have not settled it (MAX_ASKS). Then
it is visible, which is the point: an empty field on the page is honest, and a
confidently filled one is not.

`suspect` is the state that protects the document. A station number half-heard
over an excavator is worse than no station number, because an empty field shows
and a wrong one does not. Nothing in here ever turns suspect into ok on its own,
and a re-ask should use `heard` to be specific — "7:30 or 8:30?" rather than
asking the whole question again.

This module holds no model calls and no I/O. It is the state and the rules
about the state, so it can be tested without a network.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.services.report_profiles import get_profile

SlotState = Literal['empty', 'ok', 'suspect', 'na']

# Asking the same thing forever is its own failure. After this many tries a slot
# is handed back to the inspector as an open question rather than chased again.
MAX_ASKS = 3


@dataclass
class Slot:
    """
    One thing the report needs, and how well we know it.

    `heard` keeps the words that produced the value. When a value is questioned
    later — by the inspector or by a conflict check — the transcript is the only
    way to tell a mishearing from a mistake, and it is the reason a suspect slot
    can be re-asked with "did you say 143 plus 98, or 143 plus 89?" instead of
    starting the question over.
    """

    key: str
    question_id: str
    section_id: str
    kind: str
    prompt: str
    required: bool = False
    gate: str = ''
    phase: str = ''
    instance: str = ''          # which location/activity, for repeating sections

    state: SlotState = 'empty'
    value: str = ''
    rows: list[dict[str, Any]] = field(default_factory=list)
    heard: str = ''             # the transcript this came from
    reason: str = ''            # why it is suspect, or why it is n/a
    times_asked: int = 0

    @property
    def known(self) -> bool:
        """Good enough to print. `na` counts — a considered nothing is a fact."""
        return self.state in ('ok', 'na')

    @property
    def exhausted(self) -> bool:
        return self.times_asked >= MAX_ASKS

    def to_dict(self) -> dict[str, Any]:
        return {
            'key': self.key, 'question_id': self.question_id,
            'section_id': self.section_id, 'kind': self.kind,
            'prompt': self.prompt, 'required': self.required,
            'gate': self.gate, 'phase': self.phase, 'instance': self.instance,
            'state': self.state, 'value': self.value, 'rows': self.rows,
            'heard': self.heard, 'reason': self.reason,
            'times_asked': self.times_asked,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Slot:
        return cls(**{k: d.get(k, getattr(cls, k, None)) for k in (
            'key', 'question_id', 'section_id', 'kind', 'prompt', 'required',
            'gate', 'phase', 'instance', 'state', 'value', 'rows', 'heard',
            'reason', 'times_asked') if k in d})


@dataclass
class SectionGap:
    section_id: str
    number: int
    title: str
    writable: bool
    missing: list[dict[str, str]] = field(default_factory=list)
    suspect: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            'section_id': self.section_id, 'number': self.number,
            'title': self.title, 'writable': self.writable,
            'missing': self.missing, 'suspect': self.suspect,
        }


class DayRecord:
    """
    Every slot the profile needs for one day, and what we know about each.

    A repeating section (Morena runs several locations a day) is materialised
    once per instance as soon as the naming question is answered, so "the crew
    at Nobel Dr" and "the crew at Genesee" are different slots that cannot
    overwrite each other. Until the locations are known the section has no
    slots at all — which is itself the first thing the conversation has to fix.
    """

    def __init__(self, profile_key: str, report_date: str = ''):
        self.profile_key = profile_key
        self.report_date = report_date
        self.profile = get_profile(profile_key)
        self.slots: dict[str, Slot] = {}
        self.instances: dict[str, list[str]] = {}   # section_id -> labels
        # Raised by the turn endpoint when a new fact disagrees with a known
        # one. Never resolved automatically — a contradiction is for the
        # inspector to settle, and silently picking one is how a wrong time
        # reaches a signed document.
        self.conflicts: list[dict[str, str]] = []
        self._build_fixed()

    # ── construction ──────────────────────────────────────────────

    def _slot_key(self, section_id: str, question_id: str, instance: str = '') -> str:
        return f'{section_id}::{instance}::{question_id}' if instance else f'{section_id}::{question_id}'

    def _make(self, section, question, instance: str = '') -> Slot:
        return Slot(
            key=self._slot_key(section.id, question.id, instance),
            question_id=question.id, section_id=section.id,
            kind=question.kind, prompt=question.prompt,
            required=bool(question.required), gate=question.gate or '',
            phase=question.phase or '', instance=instance,
        )

    def _build_fixed(self) -> None:
        """Every slot in a non-repeating section. Repeating ones wait for names."""
        for section in self.profile.sections:
            if getattr(section, 'repeats', False):
                continue
            for question in section.questions:
                s = self._make(section, question)
                self.slots[s.key] = s

    def set_instances(self, section_id: str, labels: list[str]) -> None:
        """
        Name the passes of a repeating section — usually the locations.

        Re-naming keeps what is already known about a label that survives, so
        correcting one location out of four does not wipe the other three.
        """
        section = next((s for s in self.profile.sections if s.id == section_id), None)
        if section is None:
            return
        clean = [str(l).strip() for l in labels if str(l).strip()]
        self.instances[section_id] = clean
        keep = {k: v for k, v in self.slots.items()
                if v.section_id != section_id or v.instance in clean}
        self.slots = keep
        for label in clean:
            for question in section.questions:
                key = self._slot_key(section_id, question.id, label)
                if key not in self.slots:
                    self.slots[key] = self._make(section, question, label)

    # ── writing ───────────────────────────────────────────────────

    def apply(
        self, key: str, *, state: SlotState, value: str = '',
        rows: list[dict[str, Any]] | None = None, heard: str = '', reason: str = '',
    ) -> Slot | None:
        """
        Record what we now know about one slot.

        A slot is never downgraded from ok back to empty by a later turn that
        simply did not mention it. Only an explicit correction moves it, which
        is why callers pass a state rather than letting this infer one.
        """
        slot = self.slots.get(key)
        if slot is None:
            return None
        slot.state = state
        if value:
            slot.value = value
        if rows:
            slot.rows = rows
        if heard:
            slot.heard = heard
        slot.reason = reason
        return slot

    def mark_asked(self, keys: list[str]) -> None:
        for k in keys:
            if k in self.slots:
                self.slots[k].times_asked += 1

    def _gate_value(self, slot: Slot) -> str:
        """The answer to the yes/no this slot hangs off, within the same instance."""
        if not slot.gate:
            return ''
        g = self.slots.get(self._slot_key(slot.section_id, slot.gate, slot.instance))
        return (g.value or '').strip().lower() if g else ''

    def apply_gates(self) -> None:
        """
        Close every slot whose gate was answered no.

        Without this the gap report chases detail for things that did not
        happen — "what area was the traffic control in" on a day with no
        traffic control — and the interview never finishes.
        """
        for slot in self.slots.values():
            if not slot.gate or slot.state != 'empty':
                continue
            answer = self._gate_value(slot)
            if answer in ('no', 'none', 'false'):
                slot.state = 'na'
                slot.reason = f'Not applicable — {slot.gate} was answered no.'

    def is_needed(self, slot: Slot) -> bool:
        """A gated slot whose gate is unanswered or no is not being asked for yet."""
        if not slot.gate:
            return True
        return self._gate_value(slot) in ('yes', 'true')

    # ── reading ───────────────────────────────────────────────────

    def gaps(self) -> list[SectionGap]:
        """
        Section by section: can this be written, and if not, what is missing.

        Required-and-unknown blocks a section. So does suspect, at any level of
        required — a value we are not sure of is the thing we must not print.
        Optional gaps are reported but do not block; the profile has an
        empty_statement for exactly that case.
        """
        self.apply_gates()
        out: list[SectionGap] = []
        for section in self.profile.sections:
            mine = [s for s in self.slots.values() if s.section_id == section.id]
            gap = SectionGap(section.id, section.number, section.title, writable=True)

            if getattr(section, 'repeats', False) and not self.instances.get(section.id):
                gap.writable = False
                gap.missing.append({
                    'key': '', 'question_id': getattr(section, 'repeat_from', ''),
                    'label': f'no {section.title.lower()} named yet',
                    'instance': '',
                })
                out.append(gap)
                continue

            for slot in mine:
                if slot.state == 'suspect':
                    gap.suspect.append({
                        'key': slot.key, 'question_id': slot.question_id,
                        'label': slot.prompt, 'instance': slot.instance,
                        'reason': slot.reason or 'heard, but not clearly',
                        'heard': slot.heard,
                    })
                    gap.writable = False
                elif slot.state == 'empty' and self.is_needed(slot):
                    gap.missing.append({
                        'key': slot.key, 'question_id': slot.question_id,
                        'label': slot.prompt, 'instance': slot.instance,
                        'required': 'yes' if slot.required else 'no',
                    })
                    if slot.required:
                        gap.writable = False
            out.append(gap)
        return out

    def can_compose(self) -> bool:
        """No section may be written from a record with a hole or a doubt in it."""
        return all(g.writable for g in self.gaps()) and not self.conflicts

    def blocking(self) -> list[dict[str, str]]:
        """Only the things actually stopping the report, for the next question."""
        out = []
        for gap in self.gaps():
            if gap.writable:
                continue
            out.extend(gap.suspect)
            out.extend(m for m in gap.missing if m.get('required') == 'yes' or not m.get('key'))
        return out

    def next_targets(self, limit: int = 6) -> list[Slot]:
        """
        What is worth asking about next, best first.

        Suspect before empty, because an unresolved doubt costs a whole section
        and re-asking it is one sentence. Required before optional. Then the
        order the shift actually ran — start, during, end — because a person
        recalls a day forwards, not in the order a form prints.
        """
        self.apply_gates()
        phase_rank = {'start': 0, 'during': 1, 'end': 2, '': 3}
        section_rank = {s.id: s.number for s in self.profile.sections}
        # The order the locations were NAMED, not alphabetical. The inspector
        # lists them in the order the day ran, and asking about the second stop
        # before the first is the fastest way to lose someone's thread.
        instance_rank = {
            (sid, label): i
            for sid, labels in self.instances.items()
            for i, label in enumerate(labels)
        }

        def rank(s: Slot):
            return (
                0 if s.state == 'suspect' else 1,
                0 if s.required else 1,
                section_rank.get(s.section_id, 99),
                instance_rank.get((s.section_id, s.instance), 0),
                phase_rank.get(s.phase, 3),
            )

        pending = [
            s for s in self.slots.values()
            if s.state in ('empty', 'suspect') and self.is_needed(s) and not s.exhausted
        ]
        return sorted(pending, key=rank)[:limit]

    def known_facts(self) -> list[dict[str, Any]]:
        """Everything settled, for the composer and for conflict checking."""
        return [
            {
                'key': s.key, 'section': s.section_id, 'instance': s.instance,
                'question': s.question_id, 'prompt': s.prompt,
                'kind': s.kind, 'value': s.value, 'rows': s.rows,
                'state': s.state, 'reason': s.reason,
            }
            for s in self.slots.values() if s.known
        ]

    def progress(self) -> dict[str, int]:
        needed = [s for s in self.slots.values() if self.is_needed(s)]
        return {
            'total': len(needed),
            'known': sum(1 for s in needed if s.known),
            'suspect': sum(1 for s in needed if s.state == 'suspect'),
            'empty': sum(1 for s in needed if s.state == 'empty'),
        }

    # ── persistence ───────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            'profile_key': self.profile_key,
            'report_date': self.report_date,
            'instances': self.instances,
            'conflicts': self.conflicts,
            'slots': [s.to_dict() for s in self.slots.values()],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DayRecord:
        rec = cls(data.get('profile_key', ''), data.get('report_date', ''))
        for section_id, labels in (data.get('instances') or {}).items():
            rec.set_instances(section_id, labels)
        for raw in (data.get('slots') or []):
            slot = Slot.from_dict(raw)
            # Only restore slots this profile still defines. A profile that
            # gained or lost a question must not resurrect a dead field.
            if slot.key in rec.slots:
                rec.slots[slot.key] = slot
        rec.conflicts = list(data.get('conflicts') or [])
        return rec
