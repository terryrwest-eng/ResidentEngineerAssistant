/**
 * Daily Reporter V3 — Scan Document Page
 *
 * Tool for scanning timesheets, extra work tickets, and consultant records.
 * Also provides the voice dictation interface.
 *
 * UX Rules:
 * - No disappearing panels: file drop zone stays on screen
 * - Processing indicator is inline (not a separate modal)
 * - Results are shown below the dropzone — user explicitly clicks "Add to Report"
 * - NO auto-merge: user reviews before committing
 */

import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReportStore } from '@/stores/reportStore';
import { scanApi } from '@/lib/api';
import type { Activity, ManpowerRow, EquipmentRow } from '@/types';
import { useMicLevel } from '@/hooks/useMicLevel';
import { MicLevelMeter } from '@/components/ui/MicLevelMeter';
import {
  Camera,
  Mic,
  FileText,
  HardHat,
  Upload,
  X,
  ChevronRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Plus,
  AlertTriangle,
} from 'lucide-react';

type ScanMode = 'timesheet' | 'extra-work' | 'consultant' | 'dictation';

function generateId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ScanPage() {
  const navigate = useNavigate();
  const { report, addActivity } = useReportStore();
  const [mode, setMode] = useState<ScanMode>('timesheet');

  // File scanning state
  const [files, setFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<Activity[] | null>(null);
  const [added, setAdded] = useState(false);

  // Dictation state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  /** Live mic level — a flat bar means the mic isn't picking you up. */
  const mic = useMicLevel('scan-page');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [dictationResult, setDictationResult] = useState<Activity[] | null>(null);
  const [dictationText, setDictationText] = useState<string>('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scanModes: { id: ScanMode; label: string; icon: React.ReactNode; description: string }[] = [
    {
      id: 'timesheet',
      label: 'Timesheet / Notes',
      icon: <FileText size={20} />,
      description: 'Handwritten notes, contractor timesheets, PDFs',
    },
    {
      id: 'extra-work',
      label: 'Extra Work Ticket',
      icon: <AlertTriangle size={20} />,
      description: 'T&M tickets — all resources flagged as Extra Work',
    },
    {
      id: 'consultant',
      label: 'Consultant Visit',
      icon: <HardHat size={20} />,
      description: 'Site visit records — resources flagged as Consultant',
    },
    
    {
      id: 'dictation',
      label: 'Voice Dictation',
      icon: <Mic size={20} />,
      description: 'Speak your field notes — AI extracts activities',
    },
  ];

  // ──────────────────────────────────────
  // FILE HANDLING
  // ──────────────────────────────────────

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    setFiles((prev) => [...prev, ...dropped]);
    setScanResult(null);
    setAdded(false);
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    setFiles((prev) => [...prev, ...selected]);
    setScanResult(null);
    setAdded(false);
    e.target.value = '';
  }, []);

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setScanResult(null);
    setAdded(false);
  }

  // ──────────────────────────────────────
  // SCANNING
  // ──────────────────────────────────────

  async function handleScan() {
    if (files.length === 0) return;
    setIsScanning(true);
    setScanError(null);
    setScanResult(null);
    setAdded(false);

    try {
      let result: Activity[] = [];

      if (mode === 'timesheet') {
        const data = await scanApi.scanNotes(files);
        result = _mapActivities(data.activities || []);
      } else if (mode === 'extra-work') {
        const reportDate = report?.general?.report_date;
        const data = await scanApi.scanExtraWork(files[0], reportDate);
        result = _mapExtraWorkResult(data);
      } else if (mode === 'consultant') {
        const data = await scanApi.scanConsultant(files[0]);
        result = _mapConsultantResult(data);
      }

      setScanResult(result);
      console.debug('[ScanPage] Scan result:', result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scan failed. Check console for details.';
      setScanError(msg);
      console.error('[ScanPage] Scan error:', err);
    } finally {
      setIsScanning(false);
    }
  }

  // ──────────────────────────────────────
  // VOICE DICTATION
  // ──────────────────────────────────────

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      mic.start(stream);

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      setRecordingDuration(0);
      setDictationError(null);
      setDictationResult(null);

      timerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch (err) {
      setDictationError('Microphone access denied. Please allow microphone access and try again.');
    }
  }

  async function stopRecording() {
    if (!mediaRecorderRef.current) return;

    return new Promise<void>((resolve) => {
      mediaRecorderRef.current!.onstop = async () => {
        // Stop timer
        if (timerRef.current) clearInterval(timerRef.current);
        setIsRecording(false);

        // Get audio blob
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

        // Stop all tracks
        mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
        mic.stop();

        if (blob.size < 1000) {
          setDictationError('Recording too short. Please speak for at least a few seconds.');
          resolve();
          return;
        }

        // Transcribe
        setIsTranscribing(true);
        try {
          const base64 = await _blobToBase64(blob);
          const data = await scanApi.transcribe(base64, 'audio/webm', {
            project_name: report?.general?.project_name || '',
            report_date: report?.general?.report_date || '',
          });

          const activities = _mapActivities(data.activities || []);
          setDictationResult(activities);
          setDictationText(data.raw_transcription || '');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Transcription failed.';
          setDictationError(msg);
        } finally {
          setIsTranscribing(false);
        }
        resolve();
      };

      mediaRecorderRef.current!.stop();
    });
  }

  function _blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]); // strip data URL prefix
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ──────────────────────────────────────
  // ADD RESULTS TO REPORT
  // ──────────────────────────────────────

  function handleAddToReport(activities: Activity[]) {
    if (!report) {
      // No active report — navigate to new report first
      navigate('/report/new');
      return;
    }

    activities.forEach((act) => addActivity(act));
    setAdded(true);
  }

  // ──────────────────────────────────────
  // ACTIVITY MAPPERS
  // ──────────────────────────────────────

  function _mapActivities(rawList: Record<string, unknown>[]): Activity[] {
    return rawList.map((raw, idx) => {
      // DEBUG: Log each raw activity's keys and values
      console.debug(`[ScanPage] Raw activity ${idx} keys:`, Object.keys(raw));
      console.debug(`[ScanPage] Raw activity ${idx} summary_html:`, raw.summary_html);
      console.debug(`[ScanPage] Raw activity ${idx} manpower:`, raw.manpower);
      console.debug(`[ScanPage] Raw activity ${idx} equipment:`, raw.equipment);

      // Safely extract arrays — handle both undefined and non-array cases
      const rawManpower = Array.isArray(raw.manpower) ? raw.manpower as Record<string, unknown>[] : [];
      const rawEquipment = Array.isArray(raw.equipment) ? raw.equipment as Record<string, unknown>[] : [];

      if (rawManpower.length === 0) {
        console.warn(`[ScanPage] Activity ${idx}: manpower is EMPTY or not an array. raw.manpower =`, raw.manpower);
      }
      if (rawEquipment.length === 0) {
        console.warn(`[ScanPage] Activity ${idx}: equipment is EMPTY or not an array. raw.equipment =`, raw.equipment);
      }

      const summary = String(raw.summary_html || raw.summary || raw.description || '');
      if (!summary) {
        console.warn(`[ScanPage] Activity ${idx}: summary is BLANK.`);
      }

      return {
        id: generateId(),
        work_area: String(raw.work_area || raw.location || ''),
        stations: String(raw.stations || ''),
        summary,
        manpower: _mapManpower(rawManpower),
        equipment: _mapEquipment(rawEquipment),
        extra_work_manpower: [],
        extra_work_equipment: [],
        consultant_manpower: [],
      };
    });
  }

  function _mapExtraWorkResult(raw: Record<string, unknown>): Activity[] {
    console.debug('[ScanPage] Extra work raw keys:', Object.keys(raw));
    const rawManpower = Array.isArray(raw.manpower) ? raw.manpower as Record<string, unknown>[] : [];
    const rawEquipment = Array.isArray(raw.equipment) ? raw.equipment as Record<string, unknown>[] : [];

    return [{
      id: generateId(),
      work_area: 'Extra Work',
      stations: '',
      summary: String(raw.summary_html || raw.description || ''),
      manpower: [],
      equipment: [],
      extra_work_manpower: _mapManpower(rawManpower),
      extra_work_equipment: _mapEquipment(rawEquipment),
      consultant_manpower: [],
    }];
  }

  function _mapConsultantResult(raw: Record<string, unknown>): Activity[] {
    console.debug('[ScanPage] Consultant raw keys:', Object.keys(raw));
    const rawManpower = Array.isArray(raw.manpower) ? raw.manpower as Record<string, unknown>[] : [];

    return [{
      id: generateId(),
      work_area: 'Consultant Visit',
      stations: '',
      summary: String(raw.description || ''),
      manpower: [],
      equipment: [],
      extra_work_manpower: [],
      extra_work_equipment: [],
      consultant_manpower: _mapManpower(rawManpower),
    }];
  }

  function _mapManpower(list: Record<string, unknown>[]): ManpowerRow[] {
    if (!Array.isArray(list)) return [];
    return list.map((r) => ({
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
  }

  function _mapEquipment(list: Record<string, unknown>[]): EquipmentRow[] {
    if (!Array.isArray(list)) return [];
    return list.map((r) => ({
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
  }

  // ──────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────

  const activeResult = mode === 'dictation' ? dictationResult : scanResult;

  return (
    <div>
      <div style={{ marginBottom: 'var(--space-lg)' }}>
        <h1 style={{ margin: 0 }}>Scan Document</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-tertiary)', fontSize: '0.875rem' }}>
          AI extracts activities, manpower, and equipment from photos or recordings
        </p>
      </div>

      {/* Scan Mode Tabs */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 'var(--space-sm)',
        marginBottom: 'var(--space-lg)',
      }}>
        {scanModes.map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setMode(m.id);
              setFiles([]);
              setScanResult(null);
              setDictationResult(null);
              setScanError(null);
              setDictationError(null);
              setAdded(false);
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--space-xs)',
              padding: 'var(--space-md)',
              border: `2px solid ${mode === m.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-md)',
              background: mode === m.id ? 'var(--color-accent-light)' : 'var(--color-surface)',
              color: mode === m.id ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              transition: 'all 0.12s ease',
              textAlign: 'center',
            }}
          >
            <span style={{ color: mode === m.id ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>
              {m.icon}
            </span>
            <span style={{ fontWeight: mode === m.id ? 600 : 400, fontSize: '0.8125rem' }}>{m.label}</span>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-tertiary)', lineHeight: 1.3 }}>{m.description}</span>
          </button>
        ))}
      </div>

      {/* File Upload / Dictation area */}
      {mode !== 'dictation' ? (
        <div className="card">
          <div className="card-body">
            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${isDragOver ? 'var(--color-accent)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-2xl)',
                textAlign: 'center',
                cursor: 'pointer',
                background: isDragOver ? 'var(--color-accent-light)' : 'var(--color-bg)',
                transition: 'all 0.12s ease',
              }}
            >
              <Camera size={36} style={{ color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-sm)' }} />
              <p className="font-medium">Drop files here or click to browse</p>
              <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-xs)' }}>
                JPEG, PNG, PDF, HEIC supported
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,.heic,.heif"
                multiple={mode === 'timesheet'}
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </div>

            {/* File list */}
            {files.length > 0 && (
              <div style={{ marginTop: 'var(--space-md)' }}>
                {files.map((file, idx) => (
                  <div key={idx} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: 'var(--space-sm) var(--space-md)',
                    background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)',
                    marginBottom: 'var(--space-xs)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                      <Upload size={14} style={{ color: 'var(--color-accent)' }} />
                      <span style={{ fontSize: '0.8125rem' }}>{file.name}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                        ({(file.size / 1024).toFixed(0)} KB)
                      </span>
                    </div>
                    <button className="btn btn-ghost btn-icon" onClick={(e) => { e.stopPropagation(); removeFile(idx); }}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Scan button */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-md)' }}>
              <button
                className="btn btn-primary"
                onClick={handleScan}
                disabled={files.length === 0 || isScanning}
              >
                {isScanning ? (
                  <><Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} /> Scanning...</>
                ) : (
                  <><Camera size={16} /> Scan {files.length} File{files.length !== 1 ? 's' : ''}</>
                )}
              </button>
            </div>

            {/* Error */}
            {scanError && (
              <div style={{
                marginTop: 'var(--space-md)', padding: 'var(--space-sm) var(--space-md)',
                background: 'var(--color-danger-light)', border: '1px solid var(--color-danger-border)', borderRadius: 'var(--radius-md)',
                display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color: 'var(--color-danger)', fontSize: '0.875rem',
              }}>
                <AlertCircle size={16} />
                {scanError}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Dictation panel */
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--space-lg)' }}>
              Press the button and describe the day's work. Include location, manpower, equipment, and any extra work.
            </p>
            <button
              onClick={isRecording ? stopRecording : startRecording}
              disabled={isTranscribing}
              style={{
                width: '100px', height: '100px',
                borderRadius: '50%',
                border: `4px solid ${isRecording ? 'var(--color-danger)' : 'var(--color-accent)'}`,
                background: isRecording ? 'var(--color-danger-light)' : 'var(--color-accent-light)',
                cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 'var(--space-xs)',
                transition: 'all 0.2s ease',
                margin: '0 auto',
                boxShadow: isRecording ? '0 0 0 8px rgba(220,38,38,0.15)' : 'none',
              }}
            >
              <Mic size={32} style={{ color: isRecording ? 'var(--color-danger)' : 'var(--color-accent)' }} />
              {isRecording && (
                <span style={{ fontSize: '0.75rem', color: 'var(--color-danger)', fontWeight: 600 }}>
                  {Math.floor(recordingDuration / 60).toString().padStart(2, '0')}:{(recordingDuration % 60).toString().padStart(2, '0')}
                </span>
              )}
            </button>

            {/* Live mic level — a flat bar means the mic isn't picking you up,
                which is visible NOW instead of after a wasted take. */}
            {isRecording && (
              <MicLevelMeter {...mic} style={{ marginTop: 'var(--space-md)', marginInline: 'auto' }} />
            )}

            <p style={{ marginTop: 'var(--space-md)', fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
              {isTranscribing ? 'Processing recording...' : isRecording ? 'Tap to stop' : 'Tap to start'}
            </p>

            {isTranscribing && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-sm)', marginTop: 'var(--space-md)', color: 'var(--color-text-tertiary)' }}>
                <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} />
                <span>Analyzing recording with AI...</span>
              </div>
            )}

            {dictationText && (
              <div style={{
                marginTop: 'var(--space-lg)', padding: 'var(--space-md)',
                background: 'var(--color-bg)', borderRadius: 'var(--radius-md)',
                textAlign: 'left', fontSize: '0.875rem', color: 'var(--color-text-secondary)',
                fontStyle: 'italic',
              }}>
                <strong style={{ fontStyle: 'normal', color: 'var(--color-text-primary)', display: 'block', marginBottom: 'var(--space-xs)' }}>
                  Transcription:
                </strong>
                {dictationText}
              </div>
            )}

            {dictationError && (
              <div style={{
                marginTop: 'var(--space-md)', padding: 'var(--space-sm) var(--space-md)',
                background: 'var(--color-danger-light)', border: '1px solid var(--color-danger-border)', borderRadius: 'var(--radius-md)',
                color: 'var(--color-danger)', fontSize: '0.875rem',
              }}>
                {dictationError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {activeResult && activeResult.length > 0 && (
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
            <h2 style={{ margin: 0 }}>
              Extracted Activities ({activeResult.length})
            </h2>
            {!added ? (
              <button className="btn btn-primary" onClick={() => handleAddToReport(activeResult)}>
                <Plus size={16} />
                {report ? 'Add to Report' : 'Open New Report'}
                <ChevronRight size={16} />
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color: 'var(--color-success)', fontSize: '0.875rem', fontWeight: 500 }}>
                <CheckCircle2 size={18} />
                Added to report!
              </div>
            )}
          </div>

          {activeResult.map((act, i) => (
            <div key={act.id} className="card" style={{ marginBottom: 'var(--space-md)' }}>
              <div className="card-header">
                <span className="font-semibold">{act.work_area || `Activity ${i + 1}`}</span>
              </div>
              <div className="card-body" style={{ fontSize: '0.875rem' }}>
                {act.summary && (
                  <div
                    style={{ marginBottom: 'var(--space-md)', color: 'var(--color-text-secondary)' }}
                    dangerouslySetInnerHTML={{ __html: act.summary.replace(/\n/g, '<br/>') }}
                  />
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }}>
                  {act.manpower.length > 0 && (
                    <div>
                      <p className="font-medium" style={{ marginBottom: 'var(--space-xs)', fontSize: '0.8125rem' }}>
                        Manpower ({act.manpower.length})
                      </p>
                      {act.manpower.map((m, mi) => (
                        <div key={mi} style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', paddingBottom: '2px' }}>
                          {m.trade} {m.qty > 1 ? `×${m.qty}` : ''} — {m.hours}h {m.company ? `(${m.company})` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {act.equipment.length > 0 && (
                    <div>
                      <p className="font-medium" style={{ marginBottom: 'var(--space-xs)', fontSize: '0.8125rem' }}>
                        Equipment ({act.equipment.length})
                      </p>
                      {act.equipment.map((e, ei) => (
                        <div key={ei} style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', paddingBottom: '2px' }}>
                          {e.name} — {e.hours}h {(e as any).is_rental ? '(Rental)' : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
