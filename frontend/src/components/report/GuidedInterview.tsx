/**
 * Daily Reporter V3 — Guided interview
 *
 * The format asks the questions instead of the inspector remembering what it
 * wants. One question on screen at a time, answered by talking.
 *
 * WHY IT OPENS BY DEFAULT: working free-form means holding the whole report
 * format in your head at the end of a shift. Being asked makes it impossible to
 * leave a section blank without saying so on purpose. "Skip to editor" is
 * always there, because a quick fix on an existing report should not mean
 * walking twenty-two questions again.
 *
 * WHY THE TRANSCRIPT IS ALWAYS SHOWN: a misheard recording that silently
 * becomes report text is the worst outcome available here. Showing what was
 * heard next to what was written makes a bad take visible immediately, while
 * the inspector still remembers what they actually said.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, Square, Check, X, ChevronRight, ChevronLeft, Loader2,
  AlertCircle, SkipForward,
} from 'lucide-react';
import { useMicLevel } from '@/hooks/useMicLevel';
import { MicLevelMeter } from '@/components/ui/MicLevelMeter';
import {
  interviewApi,
  type InterviewProfile,
  type InterviewQuestion,
  type InterviewSection,
} from '@/lib/interviewApi';

interface GuidedInterviewProps {
  profileKey: string;
  reportDate: string;
  /** Answers so far, keyed by question id. Owned by the caller so a reload
   *  or a jump to the editor never loses what was already said. */
  answers: Record<string, string>;
  rows: Record<string, Record<string, unknown>[]>;
  onAnswer: (questionId: string, value: string, rows: Record<string, unknown>[]) => void;
  onExit: () => void;
  onComplete: () => void;
}

interface AskedItem {
  section: InterviewSection;
  question: InterviewQuestion;
  /** Storage key for this question. Suffixed with the pass number inside a
   *  repeating section, so location 2's stations do not overwrite location 1's. */
  key: string;
  pass?: number;
  /** Which location this pass is about, shown in the header so it is always
   *  obvious which one is being answered. */
  label?: string;
}

/**
 * Guard against a runaway loop.
 *
 * A day genuinely has a handful of locations; 30 means something answered yes
 * forever, and an interview that cannot end is worse than one that stops early.
 */
const MAX_PASSES = 30;

const instanceKey = (questionId: string, pass: number) =>
  pass <= 1 ? questionId : `${questionId}#${pass}`;

const repeatKey = (sectionId: string, pass: number) => `__more__:${sectionId}:${pass}`;

/** Strip the pass suffix — the server knows the question, not the instance. */
const baseId = (key: string) => key.split('#')[0];

/**
 * The items a list answer produced.
 *
 * Prefers the structured rows the extractor returned; falls back to splitting
 * the text so a typed answer works exactly like a spoken one, and so a list
 * still drives its section when the model returned prose instead of rows.
 */
function listItems(
  rowsForQuestion: Record<string, unknown>[] | undefined,
  value: string | undefined,
): string[] {
  const fromRows = (rowsForQuestion || [])
    .map((r) => String(r.item ?? r.name ?? r.value ?? '').trim())
    .filter(Boolean);
  if (fromRows.length) return fromRows;

  // Newline or semicolon only - NOT comma. Location names contain commas
  // ("Morena Blvd, northbound"), and splitting on them turns one location into
  // two, which then asks a whole extra round of questions about a place that
  // does not exist.
  return (value || '')
    .split(/\r?\n|;/)
    .map((part) => part.replace(/^[-•\d.)\s]+/, '').trim())
    .filter(Boolean);
}

/** A question is asked only when its gate was answered yes. */
function isAsked(q: InterviewQuestion, answers: Record<string, string>): boolean {
  if (!q.gate) return true;
  return (answers[q.gate] || '').toLowerCase() === 'yes';
}

export function GuidedInterview({
  profileKey,
  reportDate,
  answers,
  rows,
  onAnswer,
  onExit,
  onComplete,
}: GuidedInterviewProps) {
  const [profile, setProfile] = useState<InterviewProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  const [isRecording, setIsRecording] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [draft, setDraft] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const mic = useMicLevel('interview');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    interviewApi.profile(profileKey)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch((err) => {
        console.error('[Interview] Could not load the format:', err);
        if (!cancelled) setLoadError('Could not load this project\'s report format.');
      });
    return () => { cancelled = true; };
  }, [profileKey]);

  /**
   * Every question that applies today, flattened with its section.
   *
   * A repeating section is expanded once per pass. Each pass ends with its own
   * "another one?" question, and answering yes adds the next pass — so the list
   * grows as the inspector works rather than asking up front how many
   * locations there will be, which is a number nobody has at the start.
   */
  const asked = useMemo(() => {
    if (!profile) return [] as AskedItem[];
    const out: AskedItem[] = [];

    for (const section of profile.sections) {
      if (!section.repeats) {
        for (const question of section.questions) {
          if (isAsked(question, answers)) out.push({ section, question, key: question.id });
        }
        continue;
      }

      // Driven by a list answer: the things named earlier ARE the passes, so
      // the inspector is never asked "another one?" after each location. They
      // already said where they worked.
      const labels = section.repeat_from ? listItems(rows[section.repeat_from], answers[section.repeat_from]) : [];
      const passCount = section.repeat_from
        ? Math.min(labels.length, MAX_PASSES)
        : MAX_PASSES;

      for (let pass = 1; pass <= passCount; pass++) {
        const label = labels[pass - 1] || '';
        for (const question of section.questions) {
          const key = instanceKey(question.id, pass);
          // A gate inside a repeating section refers to its own pass.
          if (question.gate && (answers[instanceKey(question.gate, pass)] || '').toLowerCase() !== 'yes') {
            continue;
          }
          out.push({ section, question, key, pass, label });
        }

        // Only sections that ask their way forward get a "another one?" step.
        if (section.repeat_from) continue;

        const moreKey = repeatKey(section.id, pass);
        out.push({
          section,
          question: {
            id: moreKey,
            prompt: section.repeat_prompt || 'Another one?',
            kind: 'yesno',
            help: '',
            required: false,
            gate: '',
            example: '',
          },
          key: moreKey,
          pass,
        });

        if ((answers[moreKey] || '').toLowerCase() !== 'yes') break;
      }
    }
    return out;
  }, [profile, answers, rows]);

  const current = asked[index];

  // The question list GROWS and SHRINKS as answers change - naming three
  // locations adds passes, correcting it to one removes them. If the index is
  // left pointing past the end there is no current question, and the screen
  // sits on a spinner with no way forward. Clamp instead of stranding.
  useEffect(() => {
    if (asked.length > 0 && index >= asked.length) setIndex(asked.length - 1);
  }, [asked.length, index]);


  // Moving to a new question clears the working state — the previous answer is
  // already committed upward, and leaving a stale transcript on screen next to
  // a new question is how the wrong text gets accepted.
  useEffect(() => {
    setTranscript('');
    setDraft(current ? (answers[current.key] || '') : '');
    setMissing([]);
    setError(null);
  }, [index, current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (!current) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access denied.');
      return;
    }

    try {
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        mic.stop();
        const seconds = (Date.now() - startedAtRef.current) / 1000;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });

        if (blob.size < 1200) {
          setError('That was too short to hear. Try again.');
          return;
        }
        if (mic.getPeak() < 0.02) {
          setError('Almost no sound was picked up — check your mic before relying on this.');
        }

        setIsThinking(true);
        try {
          const base64 = await blobToBase64(blob);
          const result = await interviewApi.answer({
            profile: profileKey,
            section_id: current.section.id,
            question_id: baseId(current.key),
            audio_data: base64,
            mime_type: (recorder.mimeType || 'audio/webm').split(';')[0],
            duration_seconds: seconds,
            report_date: reportDate,
          });

          setTranscript(result.transcript);
          setMissing(result.missing);

          if (result.status === 'failed' || result.status === 'suspect') {
            setError(result.reason || 'That recording could not be read. Nothing was filled in.');
            return;
          }
          if (result.status === 'empty') {
            setError(result.reason || 'Nothing in that recording answered this question.');
            return;
          }
          setDraft(result.value);
          onAnswer(current.key, result.value, result.rows);
        } catch (err) {
          console.error('[Interview] Answer failed:', err);
          const httpErr = err as { response?: { data?: { detail?: string } } };
          setError(httpErr?.response?.data?.detail
            || (err instanceof Error ? err.message : 'Could not process that answer.'));
        } finally {
          setIsThinking(false);
        }
      };

      recorderRef.current = recorder;
      recorder.start(250);
      mic.start(stream);
      setIsRecording(true);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      mic.stop();
      setError(`Could not start recording (${e instanceof Error ? e.message : String(e)}).`);
    }
  }, [current, profileKey, reportDate, mic, onAnswer]);

  const commit = useCallback((value: string) => {
    if (!current) return;
    onAnswer(current.key, value, rows[current.key] || []);
  }, [current, onAnswer, rows]);

  const goNext = useCallback(() => {
    if (draft !== (answers[current?.key ?? ''] || '')) commit(draft);
    if (index + 1 >= asked.length) { onComplete(); return; }
    setIndex(index + 1);
  }, [draft, answers, current, commit, index, asked.length, onComplete]);

  if (loadError) {
    return (
      <div style={box}>
        <AlertCircle size={18} style={{ color: 'var(--color-danger)' }} />
        <p style={{ margin: '8px 0' }}>{loadError}</p>
        <button className="btn btn-secondary btn-sm" onClick={onExit}>Go to the editor</button>
      </div>
    );
  }
  if (!profile) {
    return <div style={box}><Loader2 size={18} className="spin" /> Loading the format…</div>;
  }
  if (!current) {
    // Loaded, but nothing left to ask. Never leave the inspector on a spinner
    // with no way out of the interview.
    return (
      <div style={box}>
        <Check size={20} style={{ color: 'var(--color-success)' }} />
        <p style={{ margin: '8px 0' }}>All questions answered.</p>
        <button className="btn btn-primary" onClick={onComplete}>Go to the report</button>
      </div>
    );
  }

  const answered = asked.filter(a => (answers[a.key] || '').trim()).length;
  const pct = Math.round((answered / Math.max(asked.length, 1)) * 100);
  const isYesNo = current.question.kind === 'yesno';

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--space-md)' }}>
      {/* Progress — how much of the format is covered, not how many taps remain */}
      <div style={{ marginBottom: 'var(--space-md)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>
            {current.section.number}. {current.section.title}
            {current.label ? ` — ${current.label}` : ''}
          </span>
          <span style={{ color: 'var(--color-text-tertiary)' }}>
            {answered} of {asked.length} answered
          </span>
        </div>
        <div style={{ height: 4, background: 'var(--color-surface-active)', borderRadius: 999 }}>
          <div style={{
            height: '100%', width: `${pct}%`, background: 'var(--color-success)',
            borderRadius: 999, transition: 'width 200ms ease',
          }} />
        </div>
      </div>

      {/* The question */}
      <h2 style={{ fontSize: '1.25rem', lineHeight: 1.35, margin: '0 0 6px' }}>
        {current.question.prompt}
      </h2>
      {current.question.help && (
        <p style={{ margin: '0 0 4px', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
          {current.question.help}
        </p>
      )}
      {current.question.example && !isYesNo && (
        <p style={{ margin: '0 0 12px', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
          e.g. {current.question.example}
        </p>
      )}

      {isYesNo ? (
        <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
          {['yes', 'no'].map((choice) => (
            <button
              key={choice}
              className={`btn ${draft === choice ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, textTransform: 'capitalize' }}
              onClick={() => { setDraft(choice); commit(choice); }}
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
            <button
              className={`btn ${isRecording ? 'btn-danger' : 'btn-primary'}`}
              onClick={isRecording ? stopRecording : startRecording}
              disabled={isThinking}
              style={{ minWidth: 132 }}
            >
              {isThinking ? <Loader2 size={16} className="spin" />
                : isRecording ? <Square size={16} /> : <Mic size={16} />}
              {isThinking ? 'Reading…' : isRecording ? 'Stop' : 'Answer by voice'}
            </button>
            {isRecording && <MicLevelMeter {...mic} compact style={{ flex: 1 }} />}
          </div>

          <textarea
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            placeholder="Speak, or type it here"
            rows={current.question.kind === 'narrative' || current.question.kind === 'segments' ? 5 : 2}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </>
      )}

      {/* What was heard, always visible next to what was written */}
      {transcript && (
        <details style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          <summary style={{ cursor: 'pointer' }}>What I heard</summary>
          <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{transcript}</p>
        </details>
      )}

      {missing.length > 0 && (
        <div style={{ ...noteBox, background: 'var(--color-warning-light, #FFFBEB)' }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>Not captured:</strong> {missing.join('; ')}
          </div>
        </div>
      )}

      {error && (
        <div style={{ ...noteBox, background: 'var(--color-danger-bg, #FEF2F2)', color: 'var(--color-danger)' }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-ghost btn-icon" onClick={() => setError(null)} aria-label="Dismiss"
            style={{ width: 18, height: 18, padding: 0 }}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Navigation */}
      <div style={{ display: 'flex', gap: 8, marginTop: 'var(--space-lg)', alignItems: 'center' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setIndex(Math.max(0, index - 1))}
          disabled={index === 0}>
          <ChevronLeft size={14} /> Back
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={goNext} title="Leave this one blank for now">
          <SkipForward size={14} /> Skip
        </button>
        <button className="btn btn-primary" onClick={goNext}>
          {index + 1 >= asked.length ? <><Check size={15} /> Finish</> : <>Next <ChevronRight size={15} /></>}
        </button>
      </div>

      <button className="btn btn-ghost btn-sm" onClick={onExit}
        style={{ marginTop: 12, fontSize: '0.75rem' }}>
        Skip to the editor — unanswered questions stay listed as gaps
      </button>
    </div>
  );
}

const box: React.CSSProperties = {
  maxWidth: 640, margin: '0 auto', padding: 'var(--space-lg)', textAlign: 'center',
};

const noteBox: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 6,
  padding: '8px 10px', marginTop: 8,
  borderRadius: 'var(--radius-sm)', fontSize: '0.75rem',
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
