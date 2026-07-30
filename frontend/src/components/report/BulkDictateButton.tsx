/**
 * Daily Reporter V3 — Bulk Dictate Button
 *
 * Records one long audio covering the ENTIRE day's work across multiple locations.
 * AI splits it into separate activities by location change.
 *
 * UX Flow:
 * 1. User taps "Dictate All" → starts recording
 * 2. User speaks about all locations/work for the day
 * 3. Stops recording → recording SAVED in memory (never lost)
 * 4. Review state: audio player + "Process" / "Download" / "Discard"
 * 5. Process → AI transcribes + parses → preview cards
 * 6. If API fails → recording still exists → "Retry" button
 * 7. User reviews → clicks "Add All to Report" → activities are created
 */

import { useState, useRef, useCallback } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { scanApi } from '@/lib/api';
import { getResourceMatcher } from '@/lib/resourceMatcher';
import type { Activity, ManpowerRow, EquipmentRow } from '@/types';
import {
  Mic,
  MicOff,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Download,
  Play,
  RotateCcw,
} from 'lucide-react';

function generateId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface BulkDictateResult {
  activities: Activity[];
  rawTranscription: string;
  locations: string;
  generalNotes: string;
}

type DictatePhase = 'idle' | 'recording' | 'review' | 'transcribing' | 'transcript' | 'processing' | 'results';

/**
 * Preferred recording formats, best first.
 * WHY: hardcoding 'audio/webm' threw on iOS Safari (which only does mp4/aac),
 * and the bare catch reported it as "Microphone access denied" — sending the
 * user to fix a permission that was never the problem.
 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_CANDIDATES.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  }) ?? '';
}

export function BulkDictateButton() {
  const { report, addActivity, updateGeneral } = useReportStore();

  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<DictatePhase>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkDictateResult | null>(null);
  const [added, setAdded] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // Transcript confirmation step (between recording and building activities)
  const [transcript, setTranscript] = useState('');
  const [transcriptWarning, setTranscriptWarning] = useState<string | null>(null);
  /** Live mic level 0..1 — proves the mic is actually picking up sound. */
  const [micLevel, setMicLevel] = useState(0);
  /** Peak level seen during the take; near-zero means a dead mic. */
  const [peakLevel, setPeakLevel] = useState(0);

  // The recorded audio blob — persists until explicitly discarded
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mimeTypeRef = useRef<string>('audio/webm');
  const durationRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakRef = useRef(0);

  /** Tear down the level meter's audio graph. */
  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setMicLevel(0);
  }, []);

  /** Drive the live level meter from the recording stream. */
  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const Ctx = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        // RMS around the 128 midpoint → rough loudness
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        setMicLevel(level);
        if (level > peakRef.current) {
          peakRef.current = level;
          setPeakLevel(level);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn('[BulkDictate] Level meter unavailable:', e);
    }
  }, []);

  // --- Recording ---
  const startRecording = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access denied. Please allow microphone access.');
      return;
    }

    try {
      chunksRef.current = [];
      peakRef.current = 0;
      setPeakLevel(0);

      const mimeType = pickMimeType();
      mimeTypeRef.current = mimeType || 'audio/webm';
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      console.debug('[BulkDictate] Recording with:', recorder.mimeType || '(browser default)');

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      // WHY: without this a mid-recording failure just produced a short blob
      // that later transcribed to garbage, with no clue anything went wrong.
      recorder.onerror = (e: Event) => {
        console.error('[BulkDictate] MediaRecorder error:', e);
        setError('Recording failed mid-take. The audio up to this point was kept — you can process or re-record.');
      };

      recorder.onstop = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        stream.getTracks().forEach((t) => t.stop());
        stopMeter();

        const type = recorder.mimeType || mimeTypeRef.current;
        mimeTypeRef.current = type.split(';')[0];
        const blob = new Blob(chunksRef.current, { type });

        if (blob.size < 1000) {
          setError('Recording too short. Please speak for at least a few seconds.');
          setPhase('idle');
          return;
        }

        // Save the blob — this is the critical persistence point
        setAudioBlob(blob);
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setPhase('review');

        const secs = durationRef.current;
        const bytesPerSec = secs > 0 ? blob.size / secs : 0;
        console.debug('[BulkDictate] Recording saved:', {
          size: `${(blob.size / 1024 / 1024).toFixed(2)} MB`,
          duration: `${secs}s`,
          bytesPerSec: Math.round(bytesPerSec),
          peakLevel: peakRef.current.toFixed(3),
          mimeType: type,
        });

        // Warn about a silent take up front rather than after a wasted AI call.
        if (peakRef.current < 0.02) {
          setError(
            'Almost no sound was detected during that recording — the mic may be muted or blocked. ' +
            'You can still process it, but check the transcript carefully.',
          );
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // timeslice: accumulate chunks so a crash loses little
      setPhase('recording');
      setRecordingDuration(0);
      durationRef.current = 0;
      setError(null);
      setResult(null);
      setTranscript('');
      setTranscriptWarning(null);
      setAdded(false);
      startMeter(stream);

      timerRef.current = setInterval(() => {
        durationRef.current += 1;
        setRecordingDuration(durationRef.current);
      }, 1000);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      stopMeter();
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not start recording on this device (${msg}).`);
      console.error('[BulkDictate] start failed:', e);
    }
  }, [startMeter, stopMeter]);

  const stopRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
  }, []);

  /**
   * STEP 1 — transcribe only, then STOP and show the user what was heard.
   *
   * WHY THIS IS SPLIT: previously one call transcribed and built activities.
   * When the audio was bad the parse step filled the JSON schema with
   * plausible-sounding work that was never said, and the first sign of trouble
   * was a finished report full of invented content. Now the transcript is the
   * checkpoint — wrong audio looks obviously wrong before anything is built.
   */
  const processRecording = useCallback(async () => {
    if (!audioBlob) {
      setError('No recording found. Please record again.');
      return;
    }

    setPhase('transcribing');
    setError(null);
    setTranscriptWarning(null);

    try {
      const base64 = await blobToBase64(audioBlob);
      const data = await scanApi.bulkTranscribe(
        base64,
        mimeTypeRef.current || 'audio/webm',
        durationRef.current,
      );

      console.debug('[BulkDictate] Transcription:', data.status, `${data.transcription?.length || 0} chars`);

      if (data.status === 'failed') {
        setError(data.reason || "Couldn't transcribe that recording. Please try again.");
        setPhase('review'); // recording is still in memory for a retry
        return;
      }

      setTranscript(data.transcription || '');
      setTranscriptWarning(data.status === 'suspect' ? (data.reason || null) : null);
      setPhase('transcript');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transcription failed';
      setError(msg);
      setPhase('review');
      console.error('[BulkDictate] Transcribe error:', err);
    }
  }, [audioBlob]);

  /** STEP 2 — build activities from the transcript the user confirmed/edited. */
  const buildActivities = useCallback(async () => {
    const text = transcript.trim();
    if (!text) {
      setError('The transcript is empty — nothing to build from.');
      return;
    }

    setPhase('processing');
    setError(null);

    try {
      const data = await scanApi.bulkParse(text);
      const activities = mapActivities(data.activities || []);

      activities.forEach((act, i) => {
        console.debug(`[BulkDictate] Mapped Activity ${i}:`, {
          work_area: act.work_area,
          summary_length: act.summary?.length || 0,
          manpower_count: act.manpower?.length || 0,
          equipment_count: act.equipment?.length || 0,
        });
      });

      if (activities.length === 0) {
        setError('No activities could be built from that transcript. Edit the text above and try again.');
        setPhase('transcript');
        return;
      }

      setResult({
        activities,
        rawTranscription: text,
        locations: data.locations || '',
        generalNotes: data.general_notes || '',
      });
      setPhase('results');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Processing failed';
      setError(msg);
      setPhase('transcript'); // keep the transcript so nothing is lost
      console.error('[BulkDictate] Parse error:', err);
    }
  }, [transcript]);

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // --- Download recording as .webm file ---
  function downloadRecording() {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `dictation-${timestamp}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    console.debug('[BulkDictate] Recording downloaded');
  }

  // --- Map raw API activities to typed Activity[] ---
  function mapActivities(rawList: Record<string, unknown>[]): Activity[] {
    return rawList.map((raw, idx) => {
      console.debug(`[BulkDictate] Raw activity ${idx} keys:`, Object.keys(raw));

      const rawManpower = Array.isArray(raw.manpower) ? raw.manpower as Record<string, unknown>[] : [];
      const rawEquipment = Array.isArray(raw.equipment) ? raw.equipment as Record<string, unknown>[] : [];

      if (rawManpower.length === 0) {
        console.warn(`[BulkDictate] Activity ${idx}: manpower is EMPTY or not an array. raw.manpower =`, raw.manpower);
      }
      if (rawEquipment.length === 0) {
        console.warn(`[BulkDictate] Activity ${idx}: equipment is EMPTY or not an array. raw.equipment =`, raw.equipment);
      }

      const summary = String(raw.summary_html || raw.summary || raw.description || '');
      if (!summary) {
        console.warn(`[BulkDictate] Activity ${idx}: summary is BLANK.`);
      }

      return {
        id: generateId(),
        work_area: String(raw.work_area || raw.location || ''),
        stations: String(raw.stations || ''),
        summary,
        manpower: mapManpower(rawManpower),
        equipment: mapEquipment(rawEquipment),
        extra_work_manpower: [],
        extra_work_equipment: [],
        consultant_manpower: [],
      };
    });
  }

  function mapManpower(list: Record<string, unknown>[]): ManpowerRow[] {
    if (!Array.isArray(list)) return [];
    const mapped = list.map((r) => ({
      id: generateId(),
      trade: String(r.trade || r.name || ''),
      name: String(r.name || ''),
      qty: Number(r.qty) || 1,
      hours: Number(r.hours) || 8,
      start_time: String(r.start_time || ''),
      stop_time: String(r.stop_time || ''),
      company: String(r.company || ''),
      classification: String(r.classification || ''),
      is_3rd_party: Boolean(r.is_3rd_party),
      is_extra_work: Boolean(r.is_extra_work),
      is_consultant: Boolean(r.is_consultant),
      locked: false,
    }));

    const matcher = getResourceMatcher();
    const { rows } = matcher.processManpower(mapped);
    return rows as unknown as ManpowerRow[];
  }

  function mapEquipment(list: Record<string, unknown>[]): EquipmentRow[] {
    if (!Array.isArray(list)) return [];
    const mapped = list.map((r) => ({
      id: generateId(),
      name: String(r.name || r.description || ''),
      description: String(r.description || ''),
      qty: Number(r.qty) || 1,
      hours: Number(r.hours) || 8,
      start_time: String(r.start_time || ''),
      stop_time: String(r.stop_time || ''),
      company: String(r.company || ''),
      is_3rd_party: Boolean(r.is_3rd_party),
      is_extra_work: Boolean(r.is_extra_work),
      is_consultant: Boolean(r.is_consultant),
      is_rental: Boolean(r.is_rental),
      locked: false,
    }));

    const matcher = getResourceMatcher();
    const { rows } = matcher.processEquipment(mapped);
    return rows as unknown as EquipmentRow[];
  }

  // --- Add All to Report ---
  function handleAddAll() {
    if (!result || !report) return;

    result.activities.forEach((act) => addActivity(act));

    if (result.locations || result.generalNotes) {
      const updates: Record<string, string> = {};
      if (result.locations && !report.general.project_location) {
        updates.project_location = result.locations;
      }
      if (result.generalNotes) {
        const existingNotes = report.general.notes || '';
        updates.notes = existingNotes
          ? `${existingNotes}\n${result.generalNotes}`
          : result.generalNotes;
      }
      if (Object.keys(updates).length > 0) {
        updateGeneral(updates as Partial<typeof report.general>);
      }
    }

    setAdded(true);
  }

  // --- Close/Reset ---
  function handleClose() {
    if (phase === 'recording') {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
    }
    // Clean up object URL
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setIsOpen(false);
    setPhase('idle');
    setResult(null);
    setError(null);
    setAdded(false);
    setRecordingDuration(0);
    setAudioBlob(null);
    setAudioUrl(null);
  }

  // --- Record More (after adding results) ---
  function handleRecordMore() {
    // Keep the panel open, reset to idle for another recording
    // Don't clear audioBlob — user might want to download the previous one
    setResult(null);
    setAdded(false);
    setError(null);
    setRecordingDuration(0);
    setPhase('idle');
  }

  const formatDuration = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  if (!isOpen) {
    return (
      <button className="btn btn-outline" onClick={() => setIsOpen(true)}>
        <Mic size={16} />
        Dictate All
      </button>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Mic size={18} style={{ color: 'var(--color-accent)' }} />
          <span className="font-semibold">Dictate All Activities</span>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={handleClose}>
          <X size={16} />
        </button>
      </div>

      <div className="card-body">
        {/* ── IDLE / RECORDING PHASE ── */}
        {(phase === 'idle' || phase === 'recording') && (
          <div style={{ textAlign: 'center', padding: 'var(--space-lg) 0' }}>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--space-lg)', fontSize: '0.875rem' }}>
              Record one long description of <strong>all work</strong> at <strong>all locations</strong> today.
              The AI will split it into separate activities by location.
            </p>

            <button
              onClick={phase === 'recording' ? stopRecording : startRecording}
              style={{
                width: '88px',
                height: '88px',
                borderRadius: '50%',
                border: `4px solid ${phase === 'recording' ? 'var(--color-danger)' : 'var(--color-accent)'}`,
                background: phase === 'recording' ? 'var(--color-danger-light)' : 'var(--color-accent-light)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                transition: 'all 0.2s ease',
                margin: '0 auto',
                boxShadow: phase === 'recording' ? '0 0 0 8px rgba(220,38,38,0.12)' : 'none',
              }}
            >
              {phase === 'recording' ? (
                <MicOff size={28} style={{ color: 'var(--color-danger)' }} />
              ) : (
                <Mic size={28} style={{ color: 'var(--color-accent)' }} />
              )}
              {phase === 'recording' && (
                <span style={{ fontSize: '0.6875rem', color: 'var(--color-danger)', fontWeight: 600 }}>
                  {formatDuration(recordingDuration)}
                </span>
              )}
            </button>

            {/* Live mic level — a flat bar means the mic isn't picking you up,
                which is visible NOW instead of after a wasted 5-minute take. */}
            {phase === 'recording' && (
              <div style={{ marginTop: 'var(--space-md)', maxWidth: '260px', marginInline: 'auto' }}>
                <div style={{
                  height: '8px',
                  background: 'var(--color-surface-active)',
                  borderRadius: 'var(--radius-full)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.round(micLevel * 100)}%`,
                    background: micLevel > 0.02 ? 'var(--color-success)' : 'var(--color-danger)',
                    borderRadius: 'var(--radius-full)',
                    transition: 'width 80ms linear',
                  }} />
                </div>
                <p style={{
                  marginTop: '6px',
                  fontSize: '0.6875rem',
                  color: peakLevel < 0.02 ? 'var(--color-danger)' : 'var(--color-text-tertiary)',
                  fontWeight: peakLevel < 0.02 ? 600 : 400,
                }}>
                  {peakLevel < 0.02
                    ? 'No sound detected — check your mic'
                    : 'Mic is picking up sound'}
                </p>
              </div>
            )}

            <p style={{ marginTop: 'var(--space-md)', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
              {phase === 'recording' ? 'Tap to stop' : 'Tap to start'}
            </p>
          </div>
        )}

        {/* ── TRANSCRIBING PHASE ── */}
        {phase === 'transcribing' && (
          <div style={{ textAlign: 'center', padding: 'var(--space-xl) 0' }}>
            <Loader2 size={32} className="animate-spin" style={{ color: 'var(--color-accent)', margin: '0 auto' }} />
            <p style={{ marginTop: 'var(--space-md)', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
              Transcribing your recording…
            </p>
            <p style={{ marginTop: '4px', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
              You'll review the text before any activities are created.
            </p>
          </div>
        )}

        {/* ── TRANSCRIPT CONFIRMATION — the anti-fabrication checkpoint ──
            Nothing is built until the user confirms this text is what they
            actually said. Editable, so a misheard name is fixed once here
            instead of in five table rows afterwards. */}
        {phase === 'transcript' && (
          <div style={{ padding: 'var(--space-md) 0' }}>
            {transcriptWarning ? (
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-sm)',
                padding: 'var(--space-sm) var(--space-md)',
                background: 'var(--color-warning-light)',
                border: '1px solid var(--color-warning-border)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-md)',
                color: 'var(--color-warning)',
                fontSize: '0.8125rem',
              }}>
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{transcriptWarning}</span>
              </div>
            ) : (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-sm)',
                padding: 'var(--space-sm) var(--space-md)',
                background: 'var(--color-success-light)',
                border: '1px solid var(--color-success-border)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-md)',
                color: 'var(--color-success)',
                fontSize: '0.8125rem',
                fontWeight: 500,
              }}>
                <CheckCircle2 size={16} />
                Here's what I heard — check it before I build the activities.
              </div>
            )}

            <label style={{
              display: 'block',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              marginBottom: '6px',
            }}>
              Transcript ({transcript.length.toLocaleString()} characters) — edit anything that was misheard
            </label>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={14}
              style={{
                width: '100%',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8125rem',
                lineHeight: 1.5,
                padding: 'var(--space-sm)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                resize: 'vertical',
              }}
            />

            {audioUrl && (
              <div style={{ marginTop: 'var(--space-sm)' }}>
                <audio controls src={audioUrl} style={{ width: '100%', height: '36px' }} />
              </div>
            )}

            <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', marginTop: 'var(--space-md)' }}>
              <button
                className="btn btn-primary"
                onClick={buildActivities}
                disabled={!transcript.trim()}
                style={{ flex: '1 1 auto' }}
              >
                <CheckCircle2 size={16} />
                Looks right — build activities
              </button>
              <button
                className="btn btn-outline"
                onClick={processRecording}
                title="Run the transcription again on the same recording"
              >
                <RotateCcw size={16} />
                Re-transcribe
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => { setTranscript(''); setTranscriptWarning(null); setPhase('review'); }}
              >
                <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
                Back
              </button>
            </div>
          </div>
        )}

        {/* ── REVIEW PHASE — Recording saved, ready to process ── */}
        {phase === 'review' && audioBlob && (
          <div style={{ padding: 'var(--space-md) 0' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-sm)',
              padding: 'var(--space-sm) var(--space-md)',
              background: 'var(--color-success-light)',
              border: '1px solid var(--color-success-border)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-md)',
              color: 'var(--color-success)',
              fontSize: '0.8125rem',
              fontWeight: 500,
            }}>
              <CheckCircle2 size={16} />
              Recording saved! ({formatDuration(recordingDuration)} · {formatFileSize(audioBlob.size)})
            </div>

            {/* Audio player */}
            {audioUrl && (
              <div style={{ marginBottom: 'var(--space-md)' }}>
                <audio controls src={audioUrl} style={{ width: '100%', height: '40px' }} />
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={processRecording}
                style={{ flex: '1 1 auto' }}
              >
                <Play size={16} />
                Process with AI
              </button>
              <button
                className="btn btn-outline"
                onClick={downloadRecording}
                title="Save recording to your device as backup"
              >
                <Download size={16} />
                Download
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  if (audioUrl) URL.revokeObjectURL(audioUrl);
                  setAudioBlob(null);
                  setAudioUrl(null);
                  setError(null);
                  setPhase('idle');
                }}
                title="Discard this recording and start over"
              >
                <X size={16} />
                Discard
              </button>
            </div>
          </div>
        )}

        {/* ── PROCESSING PHASE ── */}
        {phase === 'processing' && (
          <div style={{ textAlign: 'center', padding: 'var(--space-xl) 0' }}>
            <Loader2 size={32} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--color-accent)', marginBottom: 'var(--space-md)' }} />
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
              Building activities...
            </p>
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-xs)' }}>
              Splitting your confirmed transcript into activities by location.
            </p>
            <p style={{ fontSize: '0.6875rem', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-sm)' }}>
              Your recording and transcript are saved — if this times out, you can retry without re-recording.
            </p>
          </div>
        )}

        {/* Error banner — shows in review or results phase */}
        {error && (
          <div style={{
            marginTop: 'var(--space-md)',
            padding: 'var(--space-sm) var(--space-md)',
            background: 'var(--color-danger-light)',
            border: '1px solid var(--color-danger-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.875rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color: 'var(--color-danger)', marginBottom: 'var(--space-xs)' }}>
              <AlertCircle size={16} />
              <strong>{phase === 'recording' ? 'Recording problem' : "Couldn't process that recording"}</strong>
            </div>
            <p style={{ color: 'var(--color-danger)', fontSize: '0.8125rem', margin: '0 0 var(--space-sm) 0' }}>
              {error}
            </p>
            {audioBlob && phase === 'review' && (
              <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={processRecording}>
                  <RotateCcw size={14} />
                  Retry
                </button>
                <button className="btn btn-outline btn-sm" onClick={downloadRecording}>
                  <Download size={14} />
                  Download Backup
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── RESULTS PHASE ── */}
        {phase === 'results' && result && (
          <div>
            {/* Summary bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-md)',
            }}>
              <span className="font-semibold" style={{ fontSize: '0.875rem' }}>
                {result.activities.length} Activities Found
              </span>
              {!added ? (
                <button className="btn btn-primary btn-sm" onClick={handleAddAll}>
                  <Plus size={14} /> Add All to Report
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', color: 'var(--color-success)', fontSize: '0.8125rem', fontWeight: 500 }}>
                    <CheckCircle2 size={16} />
                    Added!
                  </div>
                  <button className="btn btn-outline btn-sm" onClick={handleRecordMore}>
                    <Mic size={14} />
                    Record More
                  </button>
                </div>
              )}
            </div>

            {/* Activity preview cards */}
            {result.activities.map((act, i) => (
              <div
                key={act.id}
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: 'var(--space-sm)',
                  overflow: 'hidden',
                }}
              >
                <button
                  onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: 'var(--space-sm) var(--space-md)',
                    border: 'none',
                    background: 'var(--color-bg)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                    {expandedIdx === i ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="font-medium" style={{ fontSize: '0.8125rem' }}>
                      {act.work_area || `Activity ${i + 1}`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-sm)', fontSize: '0.6875rem', color: 'var(--color-text-tertiary)' }}>
                    {act.manpower.length > 0 && <span>{act.manpower.length} crew</span>}
                    {act.equipment.length > 0 && <span>{act.equipment.length} equip</span>}
                  </div>
                </button>

                {expandedIdx === i && (
                  <div style={{ padding: 'var(--space-sm) var(--space-md)', fontSize: '0.8125rem', borderTop: '1px solid var(--color-border)' }}>
                    {act.summary && (
                      <div
                        style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--space-sm)' }}
                        dangerouslySetInnerHTML={{ __html: act.summary.replace(/\n/g, '<br/>') }}
                      />
                    )}
                    {act.manpower.length > 0 && (
                      <div style={{ marginBottom: 'var(--space-xs)' }}>
                        <strong style={{ fontSize: '0.75rem' }}>Manpower:</strong>
                        {act.manpower.map((m, mi) => (
                          <div key={mi} style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                            {m.trade} ×{m.qty} — {m.hours}h {m.company ? `(${m.company})` : ''}
                          </div>
                        ))}
                      </div>
                    )}
                    {act.equipment.length > 0 && (
                      <div>
                        <strong style={{ fontSize: '0.75rem' }}>Equipment:</strong>
                        {act.equipment.map((e, ei) => (
                          <div key={ei} style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                            {e.name} ×{e.qty} — {e.hours}h
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Raw transcription toggle */}
            {result.rawTranscription && (
              <details style={{ marginTop: 'var(--space-md)' }}>
                <summary style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
                  Raw Transcription
                </summary>
                <div style={{
                  marginTop: 'var(--space-xs)',
                  padding: 'var(--space-sm)',
                  background: 'var(--color-bg)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.75rem',
                  color: 'var(--color-text-secondary)',
                  fontStyle: 'italic',
                  maxHeight: '150px',
                  overflowY: 'auto',
                }}>
                  {result.rawTranscription}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
