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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Square, Send, Loader2, AlertTriangle, CheckCircle2, FileText } from 'lucide-react';

import { conversationApi, type Conflict, type Progress, type SectionGap } from '@/lib/conversationApi';
import { reportApi } from '@/lib/api';
import { useToast } from '@/components/ui/ConfirmProvider';
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
  const mic = useMicLevel('conversation');

  const [phase, setPhase] = useState<Phase>('opening');
  const [history, setHistory] = useState<Exchange[]>([]);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [askedKeys, setAskedKeys] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress>({ total: 0, known: 0, suspect: 0, empty: 0 });
  const [gaps, setGaps] = useState<SectionGap[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [ready, setReady] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reportDate = useRef(localDateString());
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
    (result: Awaited<ReturnType<typeof conversationApi.turn>>, said?: string) => {
      setRecord(result.record);
      setAskedKeys(result.asked_keys || []);
      setProgress(result.progress);
      setGaps(result.gaps || []);
      setConflicts(result.conflicts || []);
      setReady(result.ready_to_write);

      setHistory((prev) => {
        const next = [...prev];
        // What it actually heard, not what was said into the room. If those
        // differ the inspector needs to see it before it becomes a fact.
        const heard = (result.transcript || said || '').trim();
        if (heard) next.push({ role: 'inspector', text: heard });
        if (result.reply) next.push({ role: 'assistant', text: result.reply });
        return next;
      });

      setPhase('listening');
    },
    [],
  );

  const send = useCallback(
    async (payload: { text?: string; audio_data?: string; mime_type?: string; duration_seconds?: number }) => {
      setPhase('thinking');
      setError(null);
      try {
        const result = await conversationApi.turn({
          profile: 'morena',
          report_date: reportDate.current,
          record,
          history,
          asked_keys: askedKeys,
          ...payload,
        });
        applyTurn(result, payload.text);
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
    [record, history, askedKeys, applyTurn, toast],
  );

  // The opening question. Sending nothing is what asks for it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await conversationApi.turn({
          profile: 'morena',
          report_date: reportDate.current,
          record: null,
          history: [],
        });
        if (!cancelled) applyTurn(result);
      } catch (err) {
        if (cancelled) return;
        console.error('[Conversation] could not start:', err);
        setError(err instanceof Error ? err.message : 'Could not start the conversation');
        setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        profile: 'morena',
        report_date: reportDate.current,
        record,
      });
      const created = await reportApi.create(report as unknown as Record<string, unknown>);
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

  const pct = progress.total ? Math.round((progress.known / progress.total) * 100) : 0;
  const busy = phase === 'thinking' || phase === 'writing' || phase === 'opening';
  const stillOpen = gaps.flatMap((g) => [...g.missing, ...g.suspect]);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', height: '100%' }}>
      <header>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>Talk through the day</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
          {reportDate.current} · answer in your own words, it will ask for whatever is missing
        </p>
      </header>

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
          onChange={(e) => setTyped(e.target.value)}
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
