/**
 * Daily Reporter V4 — the conversation
 *
 * One exchange at a time: it asks, you answer, it works out what that told it
 * and asks the next thing. The interview shortens itself as you talk, because
 * the next question comes from the difference between what the report needs
 * and what the record already holds — not from a list.
 *
 * THE RECORD LIVES HERE, NOT ON THE SERVER. Every turn sends it and gets it
 * back. That keeps the backend stateless and means a dropped connection costs
 * one question rather than a shift.
 *
 * NOTHING IS SAVED UNTIL IT IS WRITTEN. There is no report until the record is
 * complete and the composer has run, so a half-finished conversation cannot
 * leave a half-finished report in the history.
 *
 * IT IS STILL PARKED ON THE DEVICE. Keeping the record only in React state
 * meant the screen closing threw the whole day away - it happened twice in the
 * field, both times on the last question. After every turn the record is
 * written to local storage and picked up again when the page reopens, so the
 * backend stays stateless and no report appears until it is written, but a
 * killed WebView no longer takes an hour of answers with it. See
 * lib/conversationDraft.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Mic, Square, Send, Loader2, AlertTriangle, CheckCircle2, FileText, RotateCcw,
} from 'lucide-react';

import { conversationApi, type Conflict, type Progress, type SectionGap } from '@/lib/conversationApi';
import { reportApi } from '@/lib/api';
import { useConfirm, useToast } from '@/components/ui/ConfirmProvider';
import {
  clearConversationDraft,
  draftAnswerCount,
  loadConversationDraft,
  saveConversationDraft,
  type ConversationDraftInput,
} from '@/lib/conversationDraft';
import { useMicLevel, MIC_SILENCE_THRESHOLD } from '@/hooks/useMicLevel';
import { MicLevelMeter } from '@/components/ui/MicLevelMeter';
import { localDateString } from '@/lib/formatters';

type Phase = 'opening' | 'listening' | 'recording' | 'thinking' | 'writing' | 'failed';

interface Exchange {
  role: 'assistant' | 'inspector';
  text: string;
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return (
    MIME_CANDIDATES.find((t) => {
      try {
        return MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    }) ?? ''
  );
}

/** The only format this screen talks about, named once. */
const PROFILE = 'morena';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function ConversationPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const mic = useMicLevel('conversation');

  // Read ONCE, before the first render, so a resumed conversation never
  // flashes the opening question first - and so the opening turn below can see
  // that it is not needed rather than racing it.
  const [restored] = useState(() => loadConversationDraft());

  const [phase, setPhase] = useState<Phase>(restored ? 'listening' : 'opening');
  const [history, setHistory] = useState<Exchange[]>(restored?.history ?? []);
  const [record, setRecord] = useState<Record<string, unknown> | null>(restored?.record ?? null);
  const [askedKeys, setAskedKeys] = useState<string[]>(restored?.askedKeys ?? []);
  const [progress, setProgress] = useState<Progress>(
    restored?.progress ?? { total: 0, known: 0, suspect: 0, empty: 0 },
  );
  const [gaps, setGaps] = useState<SectionGap[]>(restored?.gaps ?? []);
  const [conflicts, setConflicts] = useState<Conflict[]>(restored?.conflicts ?? []);
  const [ready, setReady] = useState(restored?.ready ?? false);
  const [typed, setTyped] = useState(restored?.typed ?? '');
  const [error, setError] = useState<string | null>(null);
  /** Shown until the conversation is carried on or started over. */
  const [resumed, setResumed] = useState(!!restored);

  // A resumed conversation belongs to the day it was started, not to today.
  // Taking today's date would file a Friday shift under Saturday.
  //
  // State rather than a ref because the header prints it. Every call that
  // sends it takes it as an argument instead of reading it back out, so
  // starting over cannot send today's turn against yesterday's date.
  const [reportDate, setReportDate] = useState(restored?.reportDate || localDateString());

  // The thread, as a value rather than as state. Parking has to happen with
  // the NEW history in hand, and a state updater is not the place to do it.
  const historyRef = useRef<Exchange[]>(restored?.history ?? []);

  /** Exactly what would be restored if the screen closed right now. */
  const draftRef = useRef<ConversationDraftInput>({
    reportDate: restored?.reportDate || localDateString(),
    profile: PROFILE,
    history: restored?.history ?? [],
    record: restored?.record ?? null,
    askedKeys: restored?.askedKeys ?? [],
    progress: restored?.progress ?? { total: 0, known: 0, suspect: 0, empty: 0 },
    gaps: restored?.gaps ?? [],
    conflicts: restored?.conflicts ?? [],
    ready: restored?.ready ?? false,
    typed: restored?.typed ?? '',
  });

  /**
   * Set once the conversation has become a report.
   *
   * Leaving this screen unmounts it, and unmounting parks the draft - which
   * would write the whole conversation straight back after it had been
   * released, and greet the next report with a resume banner for one already
   * written.
   */
  const released = useRef(false);

  const park = useCallback(() => {
    if (released.current) return;
    saveConversationDraft(draftRef.current);
  }, []);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef('audio/webm');
  const startedAtRef = useRef(0);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest exchange in view — the question is the whole interface.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, phase]);

  const applyTurn = useCallback(
    (
      result: Awaited<ReturnType<typeof conversationApi.turn>>,
      forDate: string,
      said?: string,
    ) => {
      setRecord(result.record);
      setAskedKeys(result.asked_keys || []);
      setProgress(result.progress);
      setGaps(result.gaps || []);
      setConflicts(result.conflicts || []);
      setReady(result.ready_to_write);

      // What it actually heard, not what was said into the room. If those
      // differ the inspector needs to see it before it becomes a fact.
      const heard = (result.transcript || said || '').trim();
      const next = [...historyRef.current];
      if (heard) next.push({ role: 'inspector', text: heard });
      if (result.reply) next.push({ role: 'assistant', text: result.reply });
      historyRef.current = next;
      setHistory(next);

      // Parked NOW, with the answer that was just understood. Everything above
      // this line is React state, which the screen closing takes with it.
      draftRef.current = {
        reportDate: forDate,
        profile: PROFILE,
        history: next,
        record: result.record,
        askedKeys: result.asked_keys || [],
        progress: result.progress,
        gaps: result.gaps || [],
        conflicts: result.conflicts || [],
        ready: result.ready_to_write,
        typed: '',
      };
      park();

      setPhase('listening');
    },
    [park],
  );

  const send = useCallback(
    async (payload: { text?: string; audio_data?: string; mime_type?: string; duration_seconds?: number }) => {
      setPhase('thinking');
      setError(null);
      setResumed(false);
      try {
        const result = await conversationApi.turn({
          profile: PROFILE,
          report_date: reportDate,
          record,
          history: historyRef.current,
          asked_keys: askedKeys,
          ...payload,
        });
        applyTurn(result, reportDate, payload.text);
        if (result.status === 'repeat') {
          toast(result.reason || "Didn't catch that — say it again", 'err');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'The turn failed';
        console.error('[Conversation] turn failed:', err);
        setError(message);
        setPhase('failed');
      }
    },
    [record, askedKeys, reportDate, applyTurn, toast],
  );

  // The opening question. Sending nothing is what asks for it.
  // Takes the day rather than reading it back: starting over changes the date
  // and asks the opening question in the same breath, and state read here
  // would still be yesterday.
  const askOpening = useCallback(async (forDate: string) => {
    try {
      const result = await conversationApi.turn({
        profile: PROFILE,
        report_date: forDate,
        record: null,
        history: [],
      });
      applyTurn(result, forDate);
    } catch (err) {
      console.error('[Conversation] could not start:', err);
      setError(err instanceof Error ? err.message : 'Could not start the conversation');
      setPhase('failed');
    }
  }, [applyTurn]);

  useEffect(() => {
    // A conversation was parked on this device - carry on with it. Asking the
    // opening question here would talk over an answer already given.
    if (restored) return;
    // The opening question has to be fetched, and the answer to it is state.
    // That is the one thing this screen cannot do any other way.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void askOpening(reportDate);
    // Deliberately once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The last line of defence. Every turn is parked already, so this covers the
  // sentence typed but not yet sent - and the Android case this whole fix is
  // about, where the WebView is killed without ever unmounting the page.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') park();
    };
    window.addEventListener('pagehide', park);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', park);
      document.removeEventListener('visibilitychange', onHide);
      park();
    };
  }, [park]);

  /**
   * Throw the parked conversation away and open a fresh one.
   *
   * Confirmed, because it is the one control on this screen that destroys
   * answers - which is the thing the parking exists to prevent.
   */
  const startOver = useCallback(async () => {
    const ok = await confirm({
      title: 'Start a new conversation?',
      message: 'The answers saved on this device will be thrown away.',
      confirmLabel: 'Start over',
      danger: true,
    });
    if (!ok) return;

    clearConversationDraft();
    historyRef.current = [];
    setHistory([]);
    setRecord(null);
    setAskedKeys([]);
    setProgress({ total: 0, known: 0, suspect: 0, empty: 0 });
    setGaps([]);
    setConflicts([]);
    setReady(false);
    setTyped('');
    setError(null);
    setResumed(false);
    setPhase('opening');

    const today = localDateString();
    setReportDate(today);
    draftRef.current = {
      reportDate: today,
      profile: PROFILE,
      history: [],
      record: null,
      askedKeys: [],
      progress: { total: 0, known: 0, suspect: 0, empty: 0 },
      gaps: [],
      conflicts: [],
      ready: false,
      typed: '',
    };
    await askOpening(today);
  }, [askOpening, confirm]);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      mimeRef.current = (mimeType || 'audio/webm').split(';')[0];
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      startedAtRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const quiet = mic.getPeak() < MIC_SILENCE_THRESHOLD;
        mic.stop();
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        const seconds = Math.round((Date.now() - startedAtRef.current) / 1000);

        if (quiet) {
          // Sending silence spends a model call to be told nothing was said.
          toast('The mic picked up nothing — check it and try again', 'err');
          setPhase('listening');
          return;
        }
        await send({
          audio_data: await blobToBase64(blob),
          mime_type: mimeRef.current,
          duration_seconds: seconds,
        });
      };

      recorderRef.current = recorder;
      recorder.start();
      mic.start(stream);
      setPhase('recording');
    } catch (err) {
      console.error('[Conversation] mic failed:', err);
      toast('Could not open the microphone', 'err');
      setPhase('listening');
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  async function sendTyped() {
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    await send({ text });
  }

  async function writeReport() {
    setPhase('writing');
    setError(null);
    try {
      const { report } = await conversationApi.compose({
        profile: PROFILE,
        report_date: reportDate,
        record,
      });
      const created = await reportApi.create(report as unknown as Record<string, unknown>);
      // It is a report now, so the parked copy has nothing left to protect -
      // and must not come back when leaving this screen unmounts it.
      released.current = true;
      clearConversationDraft();
      toast('Report written');
      navigate(`/report/${created.id}`, { replace: true });
    } catch (err) {
      // 409 means the record still has a hole in it. The conversation can fix
      // that, so drop back into it rather than showing a dead end.
      const http = err as { response?: { status?: number; data?: { detail?: { blocking?: unknown[] } } } };
      if (http?.response?.status === 409) {
        const blocking = http.response?.data?.detail?.blocking ?? [];
        toast(`Still ${blocking.length} thing${blocking.length === 1 ? '' : 's'} to settle`, 'err');
        setPhase('listening');
        return;
      }
      console.error('[Conversation] compose failed:', err);
      setError(err instanceof Error ? err.message : 'Could not write the report');
      setPhase('failed');
    }
  }

  const restoredCount = restored ? draftAnswerCount(restored) : 0;
  const pct = progress.total ? Math.round((progress.known / progress.total) * 100) : 0;
  const busy = phase === 'thinking' || phase === 'writing' || phase === 'opening';
  const stillOpen = gaps.flatMap((g) => [...g.missing, ...g.suspect]);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', height: '100%' }}>
      <header>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>Talk through the day</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
          {reportDate} · answer in your own words, it will ask for whatever is missing
        </p>
      </header>

      {/* Picked up from the device. Shown until it is carried on or dropped,
          because silently resuming yesterday's conversation would be its own
          kind of lost work. */}
      {resumed && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          border: '1px solid var(--color-success, #16a34a)',
          background: 'var(--color-success-light, #F0FDF4)',
          borderRadius: 8, padding: '8px 12px', fontSize: '0.85rem',
        }}>
          <RotateCcw size={15} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 160 }}>
            Picked up where you left off - {restoredCount}{' '}
            {restoredCount === 1 ? 'answer' : 'answers'} saved on this device
            {reportDate !== localDateString() ? ` for ${reportDate}` : ''}.
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => void startOver()}>
            Start over
          </button>
        </div>
      )}

      {/* Progress: how much of the report is actually known. */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
          <span>{progress.known} of {progress.total} known</span>
          {progress.suspect > 0 && <span style={{ color: 'var(--color-warn, #b45309)' }}>{progress.suspect} unclear</span>}
        </div>
        <div style={{ height: 6, background: 'var(--color-border)', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-accent, #2563eb)', transition: 'width 240ms' }} />
        </div>
      </div>

      {/* A contradiction is never resolved automatically — it is put here to
          be settled, because silently picking one is how a wrong time reaches
          a signed document. */}
      {conflicts.length > 0 && (
        <div style={{ border: '1px solid var(--color-warn, #b45309)', borderRadius: 8, padding: 'var(--space-sm)' }}>
          <strong style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={14} /> Needs settling
          </strong>
          {conflicts.map((c, i) => (
            <p key={i} style={{ margin: '6px 0 0', fontSize: '0.85rem' }}>
              {c.note || c.key}: the record says <b>{c.known}</b>, you said <b>{c.heard}</b>. Say which is right.
            </p>
          ))}
        </div>
      )}

      {/* The thread. */}
      <div ref={threadRef} style={{ flex: 1, minHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        {history.map((turn, i) => (
          <div
            key={i}
            style={{
              alignSelf: turn.role === 'assistant' ? 'flex-start' : 'flex-end',
              maxWidth: '85%',
              padding: '8px 12px',
              borderRadius: 12,
              background: turn.role === 'assistant' ? 'var(--color-surface, #f1f5f9)' : 'var(--color-accent, #2563eb)',
              color: turn.role === 'assistant' ? 'inherit' : '#fff',
              fontSize: '0.95rem',
              whiteSpace: 'pre-wrap',
            }}
          >
            {turn.text}
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: 'flex-start', color: 'var(--color-text-muted)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} />
            {phase === 'writing' ? 'Writing the report…' : 'Thinking…'}
          </div>
        )}
      </div>

      {error && (
        <div style={{ color: 'var(--color-err, #b91c1c)', fontSize: '0.85rem' }}>
          {error}{' '}
          <button className="btn btn-ghost" onClick={() => setPhase('listening')} style={{ padding: '2px 8px' }}>
            Carry on
          </button>
        </div>
      )}

      {phase === 'recording' && <MicLevelMeter micLevel={mic.micLevel} peakLevel={mic.peakLevel} compact />}

      {/* Answer: speak, or type when speaking is not an option. */}
      <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
        {phase === 'recording' ? (
          <button className="btn btn-primary" onClick={stopRecording} style={{ flexShrink: 0 }}>
            <Square size={16} /> Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={startRecording} disabled={busy} style={{ flexShrink: 0 }}>
            <Mic size={16} /> Answer
          </button>
        )}

        <input
          className="input"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            // Not written on every keystroke - just kept ready, so the
            // pagehide handler above parks the sentence in progress too.
            draftRef.current = { ...draftRef.current, typed: e.target.value };
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendTyped();
            }
          }}
          placeholder="…or type it"
          disabled={busy || phase === 'recording'}
          style={{ flex: 1 }}
        />
        <button className="btn btn-ghost btn-icon" onClick={() => void sendTyped()} disabled={busy || !typed.trim()} aria-label="Send">
          <Send size={16} />
        </button>
      </div>

      {/* Writing is only offered once the record can actually support it. */}
      {ready ? (
        <button className="btn btn-primary" onClick={() => void writeReport()} disabled={busy}>
          <CheckCircle2 size={16} /> Write the report
        </button>
      ) : (
        stillOpen.length > 0 && (
          <details style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
            <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <FileText size={13} /> {stillOpen.length} still open
            </summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {stillOpen.slice(0, 12).map((b, i) => (
                <li key={i}>
                  {b.instance ? `${b.instance} — ` : ''}
                  {b.label}
                  {b.reason ? ` (${b.reason})` : ''}
                </li>
              ))}
            </ul>
          </details>
        )
      )}
    </div>
  );
}
