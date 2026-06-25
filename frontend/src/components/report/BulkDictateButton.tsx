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

type DictatePhase = 'idle' | 'recording' | 'review' | 'processing' | 'results';

export function BulkDictateButton() {
  const { report, addActivity, updateGeneral } = useReportStore();

  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<DictatePhase>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkDictateResult | null>(null);
  const [added, setAdded] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // The recorded audio blob — persists until explicitly discarded
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Recording ---
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        stream.getTracks().forEach((t) => t.stop());

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

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
        console.debug('[BulkDictate] Recording saved:', {
          size: `${(blob.size / 1024 / 1024).toFixed(2)} MB`,
          duration: `${recordingDuration}s`,
        });
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setPhase('recording');
      setRecordingDuration(0);
      setError(null);
      setResult(null);
      setAdded(false);

      timerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch {
      setError('Microphone access denied. Please allow microphone access.');
    }
  }, [recordingDuration]);

  const stopRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
  }, []);

  // --- Process the saved recording ---
  const processRecording = useCallback(async () => {
    if (!audioBlob) {
      setError('No recording found. Please record again.');
      return;
    }

    setPhase('processing');
    setError(null);

    try {
      const base64 = await blobToBase64(audioBlob);
      const data = await scanApi.bulkDictate(base64, 'audio/webm');

      console.debug('[BulkDictate] Raw API response:', JSON.stringify(data, null, 2));
      console.debug('[BulkDictate] Activities array length:', (data.activities || []).length);

      const activities = mapActivities(data.activities || []);

      activities.forEach((act, i) => {
        console.debug(`[BulkDictate] Mapped Activity ${i}:`, {
          work_area: act.work_area,
          summary_length: act.summary?.length || 0,
          summary_preview: act.summary?.substring(0, 100) || '(BLANK)',
          manpower_count: act.manpower?.length || 0,
          equipment_count: act.equipment?.length || 0,
        });
      });

      setResult({
        activities,
        rawTranscription: data.raw_transcription || '',
        locations: data.locations || '',
        generalNotes: data.general_notes || '',
      });
      setPhase('results');
      console.debug('[BulkDictate] Parsed', activities.length, 'activities');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Processing failed';
      setError(msg);
      // Stay in review phase — recording is still available for retry
      setPhase('review');
      console.error('[BulkDictate] Error:', err);
    }
  }, [audioBlob]);

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
                border: `4px solid ${phase === 'recording' ? '#DC2626' : 'var(--color-accent)'}`,
                background: phase === 'recording' ? '#FEF2F2' : 'var(--color-accent-light)',
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
                <MicOff size={28} style={{ color: '#DC2626' }} />
              ) : (
                <Mic size={28} style={{ color: 'var(--color-accent)' }} />
              )}
              {phase === 'recording' && (
                <span style={{ fontSize: '0.6875rem', color: '#DC2626', fontWeight: 600 }}>
                  {formatDuration(recordingDuration)}
                </span>
              )}
            </button>

            <p style={{ marginTop: 'var(--space-md)', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
              {phase === 'recording' ? 'Tap to stop' : 'Tap to start'}
            </p>
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
              background: '#F0FDF4',
              border: '1px solid #BBF7D0',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-md)',
              color: '#16A34A',
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
              Processing with AI...
            </p>
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-xs)' }}>
              Transcribing audio, then splitting into activities by location.
            </p>
            <p style={{ fontSize: '0.6875rem', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-sm)' }}>
              Your recording is saved — if this times out, you can retry without re-recording.
            </p>
          </div>
        )}

        {/* Error banner — shows in review or results phase */}
        {error && (
          <div style={{
            marginTop: 'var(--space-md)',
            padding: 'var(--space-sm) var(--space-md)',
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.875rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color: '#DC2626', marginBottom: 'var(--space-xs)' }}>
              <AlertCircle size={16} />
              <strong>Upload failed</strong>
            </div>
            <p style={{ color: '#991B1B', fontSize: '0.8125rem', margin: '0 0 var(--space-sm) 0' }}>
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
