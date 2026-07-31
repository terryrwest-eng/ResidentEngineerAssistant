/**
 * Daily Reporter V3 — Dispatch Import Dialog
 *
 * Upload a dispatch PDF → AI parses job columns → User selects jobs,
 * picks shift + end time → Activity is built and added to the report.
 *
 * 6-Phase Flow:
 * Phase 0: Upload PDF
 * Phase 1: Select job columns
 * Phase 2: Asphalt tonnage
 * Phase 3: Traffic control + additional context (voice)
 * Phase 4: Choose shift + end time
 * Phase 5: Preview + add to report
 */

import { useState, useRef } from 'react';
import { scanApi, scheduleApi } from '@/lib/api';
import { useReportStore } from '@/stores/reportStore';
import { getResourceMatcher, loadResourceAliases } from '@/lib/resourceMatcher';
import { calcHours, formatEndTime, buildActivity } from '@/lib/dispatchHelpers';
import { ResourceResolutionDialog, type UnmatchedResource, type Resolution } from '@/components/report/ResourceResolutionDialog';
import type {
  DispatchJob,
  DispatchParseResult,
  ScheduleShift,
  Activity,
  ManpowerRow,
  EquipmentRow,
} from '@/types';
import { useMicLevel } from '@/hooks/useMicLevel';
import { MicLevelMeter } from '@/components/ui/MicLevelMeter';
import {
  Truck, Upload, Loader2, AlertCircle, CheckCircle2, X,
  ChevronDown, ChevronUp, Clock, Users, Wrench, FileText, CalendarDays, Mic, Square,
} from 'lucide-react';

// ============================================
// Constants
// ============================================

const PHASE_LABELS = ['Upload', 'Select Jobs', 'Tonnage', 'Details', 'Shift & Time', 'Preview'] as const;
type Phase = 0 | 1 | 2 | 3 | 4 | 5;

// ============================================
// Props
// ============================================

interface DispatchImportDialogProps {
  onClose: () => void;
}

// Helper functions (generateId, cleanTime, parseTimeToMinutes, calcHours, formatEndTime, buildActivity)
// are imported from @/lib/dispatchHelpers — shared with auto-create feature

// ============================================
// Helper: Get crew counts from a job
// ============================================

function getCrewCounts(job: DispatchJob): { operators: number; laborers: number; equipment: number } {
  return {
    operators: (job.operators || []).length + (job.foreman?.name ? 1 : 0),
    laborers: (job.laborers || []).length + (job.rakers || []).length + (job.traffic_control || []).length,
    equipment: (job.equipment || []).length,
  };
}

// buildActivity is imported from @/lib/dispatchHelpers

// ============================================
// Component
// ============================================

export function DispatchImportDialog({ onClose }: DispatchImportDialogProps) {
  const { addActivity } = useReportStore();

  // --- Phase state ---
  const [phase, setPhase] = useState<Phase>(0);

  // --- Phase 1: Upload ---
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Phase 2: Selection ---
  const [parseResult, setParseResult] = useState<DispatchParseResult | null>(null);
  const [selectedJobIndices, setSelectedJobIndices] = useState<Set<number>>(new Set());
  const [expandedJobIndices, setExpandedJobIndices] = useState<Set<number>>(new Set());

  // --- Phase 3: Shift + End Time ---
  const [shiftData, setShiftData] = useState<ScheduleShift | null>(null);
  const [shiftKeys, setShiftKeys] = useState<string[]>([]);
  const [selectedShift, setSelectedShift] = useState<string>('');
  const [allShifts, setAllShifts] = useState<Record<string, ScheduleShift>>({});
  const [endTime, setEndTime] = useState('05:00');
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [noSchedule, setNoSchedule] = useState(false);
  const [isUploadingSchedule, setIsUploadingSchedule] = useState(false);
  const scheduleFileRef = useRef<HTMLInputElement>(null);
  // Schedule type detection (digout or grind_overlay)
  const [scheduleType, setScheduleType] = useState<'digout' | 'grind_overlay'>('digout');
  // Station ranges for grind & overlay (user enters manually)
  const [stationRanges, setStationRanges] = useState<{ from: string; to: string }[]>([{ from: '', to: '' }]);
  const isGrindOverlay = scheduleType === 'grind_overlay';
  // Schedule picker — lets user switch between uploaded schedules
  const [scheduleList, setScheduleList] = useState<{ id: string; filename: string; schedule_type: string }[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>('');

  // --- Phase 2: Asphalt Tonnage ---
  const [asphaltTons, setAsphaltTons] = useState('');

  // --- Phase 3: Traffic Control + Additional Context (voice) ---
  const [trafficControl, setTrafficControl] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [isRecordingTC, setIsRecordingTC] = useState(false);
  const [isRecordingCtx, setIsRecordingCtx] = useState(false);
  /**
   * Live mic level. One instance serves both recorders — only one can be
   * running at a time, and start() tears down any previous graph anyway.
   */
  const mic = useMicLevel('dispatch-import');
  const [isTranscribingTC, setIsTranscribingTC] = useState(false);
  const [isTranscribingCtx, setIsTranscribingCtx] = useState(false);
  const tcRecorderRef = useRef<MediaRecorder | null>(null);
  const tcChunksRef = useRef<Blob[]>([]);
  const ctxRecorderRef = useRef<MediaRecorder | null>(null);
  const ctxChunksRef = useRef<Blob[]>([]);

  // --- Phase 4: Preview ---
  const [previewActivity, setPreviewActivity] = useState<Activity | null>(null);

  // --- Resource Resolution ---
  const [showResolution, setShowResolution] = useState(false);
  const [unmatchedItems, setUnmatchedItems] = useState<UnmatchedResource[]>([]);
  const [pendingActivity, setPendingActivity] = useState<Activity | null>(null);

  // ============================================
  // Phase 1 Handlers
  // ============================================

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] || null;
    if (selected) {
      const ext = selected.name.split('.').pop()?.toLowerCase();
      if (ext !== 'pdf') {
        setError('Only PDF dispatch files are supported.');
        console.warn('[DispatchImport] Rejected non-PDF file:', selected.name);
        return;
      }
      setFile(selected);
      setError(null);
      console.debug('[DispatchImport] File selected:', selected.name, `(${(selected.size / 1024).toFixed(0)} KB)`);
    }
  }

  async function handleParse() {
    if (!file) {
      console.warn('[DispatchImport] handleParse called with no file');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      console.debug('[DispatchImport] Parsing dispatch:', file.name);
      const data: DispatchParseResult = await scanApi.parseDispatch(file);
      console.debug('[DispatchImport] Parse result:', data.jobs?.length, 'jobs, company:', data.company);

      if (!data.jobs || data.jobs.length === 0) {
        setError('No jobs found in the dispatch PDF. Make sure the file is a valid dispatch document.');
        return;
      }

      setParseResult(data);
      // Select all jobs by default
      setSelectedJobIndices(new Set(data.jobs.map((_, i) => i)));
      setPhase(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to parse dispatch';
      setError(msg);
      console.error('[DispatchImport] Parse error:', err);
    } finally {
      setIsProcessing(false);
    }
  }

  // ============================================
  // Phase 2 Handlers
  // ============================================

  function toggleJobSelection(index: number) {
    setSelectedJobIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function toggleJobExpand(index: number) {
    setExpandedJobIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function selectAll() {
    if (!parseResult) return;
    setSelectedJobIndices(new Set(parseResult.jobs.map((_, i) => i)));
  }

  function deselectAll() {
    setSelectedJobIndices(new Set());
  }

  async function handlePhase2Next() {
    if (selectedJobIndices.size === 0) {
      setError('Select at least one job to import.');
      return;
    }
    setError(null);
    // Go to Phase 2: Asphalt Tonnage
    setPhase(2);
  }

  function handleTonnageNext() {
    // Go to Phase 3: Traffic Control + Context
    setPhase(3);
  }

  async function handleDetailsNext() {
    setError(null);
    // Go to Phase 4: Shift & Time — load schedule now
    setPhase(4);

    // Load schedule
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      // Fetch schedule list so user can switch between them
      try {
        const listResult = await scheduleApi.list();
        const list = (listResult.schedules || []).map((s: { id: string; filename: string; schedule_type?: string }) => ({
          id: s.id,
          filename: s.filename,
          schedule_type: s.schedule_type || 'digout',
        }));
        setScheduleList(list);
        console.debug('[DispatchImport] Schedule list:', list.length, 'schedules');
      } catch (listErr) {
        console.debug('[DispatchImport] Failed to load schedule list:', listErr);
      }

      const schedule = await scheduleApi.getActive();
      console.debug('[DispatchImport] Loaded schedule:', schedule.filename, 'type:', schedule.schedule_type, 'shifts:', Object.keys(schedule.shifts).length);
      _applySchedule(schedule);
      setSelectedScheduleId(schedule.id || '');
      setNoSchedule(false);
    } catch (err) {
      console.debug('[DispatchImport] No active schedule found (expected if none uploaded):', err);
      setNoSchedule(true);
    } finally {
      setScheduleLoading(false);
    }
  }

  // ============================================
  // Voice Recording Helpers (Traffic Control + Context)
  // ============================================

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]); // strip data:audio/webm;base64, prefix
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function startVoiceRecording(
    recorderRef: React.MutableRefObject<MediaRecorder | null>,
    chunksRef: React.MutableRefObject<Blob[]>,
    setRecording: (v: boolean) => void,
  ) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      mic.start(stream);
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
      console.debug('[DispatchImport] Voice recording started');
    } catch {
      setError('Microphone access denied. Please allow microphone access.');
    }
  }

  async function stopAndTranscribe(
    recorderRef: React.MutableRefObject<MediaRecorder | null>,
    chunksRef: React.MutableRefObject<Blob[]>,
    setRecording: (v: boolean) => void,
    setTranscribing: (v: boolean) => void,
    setText: (prev: string) => void,
    currentText: string,
  ) {
    if (!recorderRef.current) return;
    const recorder = recorderRef.current;

    // Wait for the recorder to fully stop and assemble chunks
    await new Promise<void>((resolve) => {
      recorder.onstop = () => {
        recorder.stream.getTracks().forEach(t => t.stop());
        mic.stop();
        resolve();
      };
      recorder.stop();
    });

    setRecording(false);
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    if (blob.size < 1000) {
      setError('Recording too short. Please speak for at least a few seconds.');
      return;
    }

    // Transcribe
    setTranscribing(true);
    try {
      const base64 = await blobToBase64(blob);
      const result = await scanApi.transcribe(base64, 'audio/webm', {});
      // The transcribe endpoint returns raw_transcription or transcription
      const transcription = result.raw_transcription || result.transcription || '';
      console.debug('[DispatchImport] Transcription result:', transcription);
      // Append to existing text
      const separator = currentText.trim() ? ' ' : '';
      setText(currentText.trim() + separator + transcription.trim());
    } catch (err) {
      console.error('[DispatchImport] Transcription failed:', err);
      setError('Transcription failed. Try again or type your answer.');
    } finally {
      setTranscribing(false);
    }
  }

  // ============================================
  // Phase 3: Inline schedule upload
  // ============================================

  async function handleInlineScheduleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const schedFile = e.target.files?.[0];
    if (!schedFile) return;

    setIsUploadingSchedule(true);
    setScheduleError(null);
    try {
      console.debug('[DispatchImport] Inline schedule upload:', schedFile.name);
      const schedule = await scheduleApi.upload(schedFile);
      console.debug('[DispatchImport] Schedule parsed:', schedule.total_shifts, 'shifts, type:', schedule.schedule_type);
      _applySchedule(schedule);
      setSelectedScheduleId(schedule.id || '');
      setNoSchedule(false);

      // Refresh schedule list so the new upload appears in the picker
      try {
        const listResult = await scheduleApi.list();
        setScheduleList((listResult.schedules || []).map((s: { id: string; filename: string; schedule_type?: string }) => ({
          id: s.id,
          filename: s.filename,
          schedule_type: s.schedule_type || 'digout',
        })));
      } catch { /* non-fatal */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Schedule upload failed';
      setScheduleError(msg);
      console.error('[DispatchImport] Schedule upload failed:', err);
    } finally {
      setIsUploadingSchedule(false);
      if (scheduleFileRef.current) scheduleFileRef.current.value = '';
    }
  }

  // ============================================
  // Phase 3 Handlers
  // ============================================

  function handleShiftChange(key: string) {
    setSelectedShift(key);
    setShiftData(allShifts[key] || null);
    console.debug('[DispatchImport] Selected shift:', key, 'rows:', allShifts[key]?.rows?.length);
  }

  /** Apply a loaded schedule's data to state */
  function _applySchedule(schedule: { shifts: Record<string, ScheduleShift>; schedule_type?: string }) {
    const keys = Object.keys(schedule.shifts || {}).sort();
    setShiftKeys(keys);
    setAllShifts(schedule.shifts || {});
    setScheduleType((schedule.schedule_type as 'digout' | 'grind_overlay') || 'digout');
    // Reset station ranges when switching schedules
    setStationRanges([{ from: '', to: '' }]);
    if (keys.length > 0) {
      setSelectedShift(keys[0]);
      setShiftData(schedule.shifts[keys[0]]);
    } else {
      setSelectedShift('');
      setShiftData(null);
    }
  }

  /** Switch to a different uploaded schedule */
  async function handleScheduleSwitch(scheduleId: string) {
    if (!scheduleId || scheduleId === selectedScheduleId) return;
    setSelectedScheduleId(scheduleId);
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      const schedule = await scheduleApi.getById(scheduleId);
      console.debug('[DispatchImport] Switched to schedule:', schedule.filename, 'type:', schedule.schedule_type);
      _applySchedule(schedule);
      setNoSchedule(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load schedule';
      setScheduleError(msg);
      console.error('[DispatchImport] Schedule switch failed:', err);
    } finally {
      setScheduleLoading(false);
    }
  }

  function handlePhase3Next() {
    if (!parseResult) {
      console.warn('[DispatchImport] No parse result at phase 3');
      return;
    }

    // Ensure aliases are loaded before matching
    loadResourceAliases().then(() => {
      const selectedJobs = parseResult.jobs.filter((_, i) => selectedJobIndices.has(i));
      const activity = buildActivity(
        selectedJobs,
        parseResult.company || '',
        endTime,
        noSchedule ? null : shiftData,
        noSchedule ? '' : selectedShift,
        scheduleType,
        isGrindOverlay ? stationRanges.filter(r => r.from.trim() || r.to.trim()) : [],
        { asphaltTons, trafficControl, additionalContext },
      );

      // Scan for unmatched resources
      const matcher = getResourceMatcher();
      const unmatched: UnmatchedResource[] = [];

      // Check equipment rows
      const allEquipmentArrays: { rows: EquipmentRow[]; field: string }[] = [
        { rows: activity.equipment || [], field: 'equipment' },
        { rows: activity.extra_work_equipment || [], field: 'extra_work_equipment' },
      ];
      for (const { rows, field: _field } of allEquipmentArrays) {
        rows.forEach((row, i) => {
          // If name doesn't look like a valid LE- code, it's unmatched
          if (row.name && !row.name.match(/^LE-\d+/)) {
            const result = matcher.match(row.name, 'equipment');
            unmatched.push({
              index: i,
              type: 'equipment',
              rawDescription: row.name,
              bestGuess: result.matched,
              confidence: result.confidence,
              alternatives: result.alternatives,
            });
          }
        });
      }

      // Check manpower rows
      const allManpowerArrays: { rows: ManpowerRow[]; field: string }[] = [
        { rows: activity.manpower || [], field: 'manpower' },
        { rows: activity.extra_work_manpower || [], field: 'extra_work_manpower' },
        { rows: activity.consultant_manpower || [], field: 'consultant_manpower' },
      ];
      for (const { rows } of allManpowerArrays) {
        rows.forEach((row, i) => {
          if (row.trade && !row.trade.match(/^LL-\d+/)) {
            const result = matcher.match(row.trade, 'manpower');
            unmatched.push({
              index: i,
              type: 'manpower',
              rawDescription: row.trade,
              bestGuess: result.matched,
              confidence: result.confidence,
              alternatives: result.alternatives,
            });
          }
        });
      }

      if (unmatched.length > 0) {
        console.debug('[DispatchImport] Found', unmatched.length, 'unmatched resources — showing resolution dialog');
        setUnmatchedItems(unmatched);
        setPendingActivity(activity);
        setShowResolution(true);
      } else {
        console.debug('[DispatchImport] All resources matched — advancing to preview');
        setPreviewActivity(activity);
        setPhase(5);
      }
    }).catch(err => {
      console.error('[DispatchImport] Alias load failed, continuing anyway:', err);
      // Still build and advance even if alias loading fails
      const selectedJobs = parseResult.jobs.filter((_, i) => selectedJobIndices.has(i));
      const activity = buildActivity(
        selectedJobs,
        parseResult.company || '',
        endTime,
        noSchedule ? null : shiftData,
        noSchedule ? '' : selectedShift,
        scheduleType,
        isGrindOverlay ? stationRanges.filter(r => r.from.trim() || r.to.trim()) : [],
        { asphaltTons, trafficControl, additionalContext },
      );
      setPreviewActivity(activity);
      setPhase(5);
    });
  }

  function handleResolutionComplete(resolutions: Resolution[]) {
    if (!pendingActivity) return;

    const updated = { ...pendingActivity };
    // Apply each resolution to the correct resource row
    for (const res of resolutions) {
      if (res.type === 'equipment') {
        // Find and update in equipment arrays
        const eqArrays: (EquipmentRow[] | undefined)[] = [updated.equipment, updated.extra_work_equipment];
        for (const arr of eqArrays) {
          if (!arr) continue;
          const row = arr.find(r => r.name === res.rawDescription);
          if (row) {
            row.name = res.code;
            break;
          }
        }
      } else {
        // Find and update in manpower arrays
        const mpArrays: (ManpowerRow[] | undefined)[] = [updated.manpower, updated.extra_work_manpower, updated.consultant_manpower];
        for (const arr of mpArrays) {
          if (!arr) continue;
          const row = arr.find(r => r.trade === res.rawDescription);
          if (row) {
            row.trade = res.code;
            break;
          }
        }
      }
    }

    console.debug('[DispatchImport] Resolutions applied, advancing to preview');
    setPreviewActivity(updated);
    setShowResolution(false);
    setUnmatchedItems([]);
    setPendingActivity(null);
    setPhase(5);
  }

  // ============================================
  // Phase 4 Handlers
  // ============================================

  function handleAddToReport() {
    if (!previewActivity) {
      console.warn('[DispatchImport] No preview activity to add');
      return;
    }
    addActivity(previewActivity);
    console.debug('[DispatchImport] Activity added to report:', previewActivity.id);
    onClose();
  }

  // ============================================
  // Computed values
  // ============================================

  // For Phase 3: show calculated hours from the most common start time
  const commonStartTime = (() => {
    if (!parseResult) return '';
    const selectedJobs = parseResult.jobs.filter((_, i) => selectedJobIndices.has(i));
    const times: Record<string, number> = {};
    for (const job of selectedJobs) {
      if (job.start_time) {
        times[job.start_time] = (times[job.start_time] || 0) + 1;
      }
    }
    const sorted = Object.entries(times).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || '';
  })();

  const calculatedHours = commonStartTime && endTime
    ? calcHours(commonStartTime, endTime)
    : 0;

  // ============================================
  // Render
  // ============================================

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          background: 'var(--color-surface)',
          borderRadius: 'var(--radius-lg)',
          width: '600px',
          maxWidth: '95vw',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 16px 48px rgba(0,0,0,0.15)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-lg)',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <Truck size={20} style={{ color: 'var(--color-accent)' }} />
            <h3 style={{ margin: 0 }}>Import Dispatch</h3>
            <span className="badge badge-info" style={{ marginLeft: 'var(--space-xs)' }}>
              {PHASE_LABELS[phase]}
            </span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 'var(--space-lg)' }}>

          {/* ========== Phase 0: Upload ========== */}
          {phase === 0 && (
            <>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-lg)' }}>
                Upload a dispatch PDF. AI will parse all job columns, crew assignments,
                equipment, and subcontractor info.
              </p>

              {/* Drop zone */}
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: '2px dashed var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-2xl)',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: file ? 'var(--color-accent-light)' : 'var(--color-bg)',
                  transition: 'all 0.12s ease',
                }}
              >
                {file ? (
                  <>
                    <FileText size={32} style={{ color: 'var(--color-accent)', marginBottom: 'var(--space-sm)' }} />
                    <p className="font-medium">{file.name}</p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                      {(file.size / 1024).toFixed(0)} KB — Click to change
                    </p>
                  </>
                ) : (
                  <>
                    <Upload size={32} style={{ color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-sm)' }} />
                    <p className="font-medium">Click to select a dispatch PDF</p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                      PDF files only
                    </p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                />
              </div>

              {/* Error */}
              {error && (
                <div style={{
                  marginTop: 'var(--space-md)',
                  padding: 'var(--space-sm) var(--space-md)',
                  background: 'var(--color-danger-light)',
                  border: '1px solid var(--color-danger-border)',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  color: 'var(--color-danger)',
                  fontSize: '0.875rem',
                }}>
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}

              {/* Parse button */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-lg)' }}>
                <button
                  className="btn btn-primary"
                  onClick={handleParse}
                  disabled={!file || isProcessing}
                >
                  {isProcessing ? (
                    <><Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} /> Parsing Dispatch...</>
                  ) : (
                    <><Truck size={16} /> Parse Dispatch</>
                  )}
                </button>
              </div>
            </>
          )}

          {/* ========== Phase 1: Column Selection ========== */}
          {phase === 1 && parseResult && (
            <>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 'var(--space-md)',
              }}>
                <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', margin: 0 }}>
                  {parseResult.jobs.length} job{parseResult.jobs.length !== 1 ? 's' : ''} found
                  {parseResult.company ? ` — ${parseResult.company}` : ''}
                  {parseResult.date ? ` — ${parseResult.date}` : ''}
                </p>
                <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                  <button className="btn btn-ghost" onClick={selectAll} style={{ fontSize: '0.75rem' }}>Select All</button>
                  <button className="btn btn-ghost" onClick={deselectAll} style={{ fontSize: '0.75rem' }}>Deselect All</button>
                </div>
              </div>

              {/* Job Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', maxHeight: '400px', overflow: 'auto' }}>
                {parseResult.jobs.map((job, index) => {
                  const counts = getCrewCounts(job);
                  const isSelected = selectedJobIndices.has(index);
                  const isExpanded = expandedJobIndices.has(index);

                  return (
                    <div
                      key={index}
                      className="card"
                      style={{
                        border: isSelected ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        background: isSelected ? 'var(--color-accent-light)' : 'var(--color-surface)',
                        transition: 'all 0.12s ease',
                      }}
                    >
                      <div
                        style={{
                          padding: 'var(--space-md)',
                          cursor: 'pointer',
                          display: 'flex',
                          gap: 'var(--space-sm)',
                          alignItems: 'flex-start',
                        }}
                        onClick={() => toggleJobSelection(index)}
                      >
                        {/* Checkbox */}
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleJobSelection(index)}
                          style={{ marginTop: '2px', accentColor: 'var(--color-accent)' }}
                        />

                        {/* Job Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
                            <span className="font-medium" style={{ fontSize: '0.875rem' }}>
                              {job.job_name || 'Unnamed Job'}
                            </span>
                            {job.job_number && (
                              <span className="badge badge-info" style={{ fontSize: '0.7rem' }}>
                                #{job.job_number}
                              </span>
                            )}
                            <span
                              className="badge"
                              style={{
                                fontSize: '0.7rem',
                                background: job.contract_type === 'CHANGE ORDER' ? 'var(--color-warning-light)' : 'var(--color-info-light)',
                                color: job.contract_type === 'CHANGE ORDER' ? 'var(--color-warning)' : 'var(--color-info)',
                                border: `1px solid ${job.contract_type === 'CHANGE ORDER' ? 'var(--color-warning-border)' : 'var(--color-info-border)'}`,
                              }}
                            >
                              {job.contract_type || 'CONTRACT'}
                            </span>
                          </div>
                          {job.job_description && (
                            <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>
                              {job.job_description}
                            </p>
                          )}
                          <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-xs)', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                            {job.start_time && (
                              <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                                <Clock size={12} /> {job.start_time}
                              </span>
                            )}
                            <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                              <Users size={12} /> {counts.operators} ops, {counts.laborers} lab
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                              <Wrench size={12} /> {counts.equipment} equip
                            </span>
                          </div>
                        </div>

                        {/* Expand toggle */}
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={(e) => { e.stopPropagation(); toggleJobExpand(index); }}
                          style={{ padding: '4px' }}
                        >
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      </div>

                      {/* Expanded Details */}
                      {isExpanded && (
                        <div style={{
                          padding: '0 var(--space-md) var(--space-md)',
                          borderTop: '1px solid var(--color-border)',
                          paddingTop: 'var(--space-sm)',
                          fontSize: '0.8125rem',
                          color: 'var(--color-text-secondary)',
                        }}>
                          {/* Streets / Location */}
                          {((job.streets && job.streets.length > 0) || job.location) && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Location:</strong>{' '}
                              {(job.streets || []).filter(s => s && s !== 'N/A').join(', ')}
                              {job.location && job.location !== 'N/A' ? ` — ${job.location}` : ''}
                            </div>
                          )}

                          {/* Foreman */}
                          {job.foreman?.name && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Foreman:</strong> {job.foreman.name} ({job.foreman.time || job.start_time})
                            </div>
                          )}

                          {/* Crew Lists */}
                          {(job.operators || []).length > 0 && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Operators:</strong>{' '}
                              {job.operators.map(o => `${o.name} (${o.time || job.start_time})`).join(', ')}
                            </div>
                          )}
                          {(job.laborers || []).length > 0 && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Laborers:</strong>{' '}
                              {job.laborers.map(l => `${l.name} (${l.time || job.start_time})`).join(', ')}
                            </div>
                          )}
                          {(job.rakers || []).length > 0 && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Rakers:</strong>{' '}
                              {job.rakers.map(r => `${r.name} (${r.time || job.start_time})`).join(', ')}
                            </div>
                          )}
                          {(job.traffic_control || []).length > 0 && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Traffic Control:</strong>{' '}
                              {job.traffic_control.map(tc => `${tc.name} (${tc.time || job.start_time})`).join(', ')}
                            </div>
                          )}

                          {/* Equipment */}
                          {(job.equipment || []).length > 0 && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Equipment:</strong>{' '}
                              {job.equipment.map(eq => `${eq.id} (${eq.description})`).join(', ')}
                            </div>
                          )}

                          {/* Subs */}
                          {job.trucking?.company && job.trucking.details !== 'N/A' && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Trucking:</strong> {job.trucking.company} — {job.trucking.details}
                            </div>
                          )}
                          {job.grinders?.company && job.grinders.details !== 'N/A' && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}>
                              <strong>Grinders:</strong> {job.grinders.company} — {job.grinders.details}
                            </div>
                          )}

                          {/* Material / Plant */}
                          {job.material && job.material !== 'N/A' && (
                            <div style={{ marginBottom: 'var(--space-xs)' }}><strong>Material:</strong> {job.material}</div>
                          )}
                          {job.plant && job.plant !== 'N/A' && (
                            <div><strong>Plant:</strong> {job.plant}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Error */}
              {error && (
                <div style={{
                  marginTop: 'var(--space-md)',
                  padding: 'var(--space-sm) var(--space-md)',
                  background: 'var(--color-danger-light)',
                  border: '1px solid var(--color-danger-border)',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  color: 'var(--color-danger)',
                  fontSize: '0.875rem',
                }}>
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}

              {/* Navigation */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-lg)' }}>
                <button className="btn btn-outline" onClick={() => setPhase(0)}>Back</button>
                <button
                  className="btn btn-primary"
                  onClick={handlePhase2Next}
                  disabled={selectedJobIndices.size === 0}
                >
                  Next — Tonnage
                </button>
              </div>
            </>
          )}

          {/* ========== Phase 2: Asphalt Tonnage ========== */}
          {phase === 2 && (
            <>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-lg)' }}>
                Enter the asphalt tonnage placed today.
              </p>

              <div style={{ marginBottom: 'var(--space-lg)' }}>
                <label className="label" style={{ marginBottom: 'var(--space-xs)' }}>
                  How much asphalt was laid today? (tons)
                </label>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  placeholder="e.g. 1,500"
                  value={asphaltTons}
                  onChange={(e) => setAsphaltTons(e.target.value)}
                  style={{ maxWidth: 200 }}
                />
              </div>

              {/* Navigation */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-lg)' }}>
                <button className="btn btn-outline" onClick={() => setPhase(1)}>Back</button>
                <button
                  className="btn btn-primary"
                  onClick={handleTonnageNext}
                >
                  Next — Details
                </button>
              </div>
            </>
          )}

          {/* ========== Phase 3: Traffic Control + Additional Context ========== */}
          {phase === 3 && (
            <>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-lg)' }}>
                Describe the traffic control and add any additional summary context.
              </p>

              {/* Traffic Control */}
              <div style={{ marginBottom: 'var(--space-lg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-xs)' }}>
                  <label className="label" style={{ margin: 0 }}>
                    What traffic control was set up?
                  </label>
                  <button
                    className={`btn btn-icon ${isRecordingTC ? 'btn-danger' : 'btn-outline'}`}
                    onClick={() => {
                      if (isRecordingTC) {
                        stopAndTranscribe(tcRecorderRef, tcChunksRef, setIsRecordingTC, setIsTranscribingTC, setTrafficControl, trafficControl);
                      } else {
                        startVoiceRecording(tcRecorderRef, tcChunksRef, setIsRecordingTC);
                      }
                    }}
                    disabled={isTranscribingTC}
                    style={{ minWidth: 36, height: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title={isRecordingTC ? 'Stop recording' : 'Record voice'}
                  >
                    {isTranscribingTC ? (
                      <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} />
                    ) : isRecordingTC ? (
                      <Square size={16} />
                    ) : (
                      <Mic size={16} />
                    )}
                  </button>
                </div>
                {isRecordingTC && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-danger)', marginBottom: 'var(--space-xs)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-danger)', animation: 'pulse 1s infinite' }} />
                    Recording... tap stop when done
                    <MicLevelMeter {...mic} compact style={{ maxWidth: '120px', marginLeft: 'auto' }} />
                  </div>
                )}
                <textarea
                  className="input"
                  placeholder="e.g. Full lane closure with K-rail, flaggers on both ends..."
                  value={trafficControl}
                  onChange={(e) => setTrafficControl(e.target.value)}
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
              </div>

              {/* Additional Context */}
              <div style={{ marginBottom: 'var(--space-lg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-xs)' }}>
                  <label className="label" style={{ margin: 0 }}>
                    Any additional summary context?
                  </label>
                  <button
                    className={`btn btn-icon ${isRecordingCtx ? 'btn-danger' : 'btn-outline'}`}
                    onClick={() => {
                      if (isRecordingCtx) {
                        stopAndTranscribe(ctxRecorderRef, ctxChunksRef, setIsRecordingCtx, setIsTranscribingCtx, setAdditionalContext, additionalContext);
                      } else {
                        startVoiceRecording(ctxRecorderRef, ctxChunksRef, setIsRecordingCtx);
                      }
                    }}
                    disabled={isTranscribingCtx}
                    style={{ minWidth: 36, height: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title={isRecordingCtx ? 'Stop recording' : 'Record voice'}
                  >
                    {isTranscribingCtx ? (
                      <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} />
                    ) : isRecordingCtx ? (
                      <Square size={16} />
                    ) : (
                      <Mic size={16} />
                    )}
                  </button>
                </div>
                {isRecordingCtx && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-danger)', marginBottom: 'var(--space-xs)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-danger)', animation: 'pulse 1s infinite' }} />
                    Recording... tap stop when done
                    <MicLevelMeter {...mic} compact style={{ maxWidth: '120px', marginLeft: 'auto' }} />
                  </div>
                )}
                <textarea
                  className="input"
                  placeholder="e.g. Crew started late due to equipment breakdown..."
                  value={additionalContext}
                  onChange={(e) => setAdditionalContext(e.target.value)}
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
              </div>

              {error && (
                <div className="alert alert-error" style={{ marginBottom: 'var(--space-md)' }}>
                  <AlertCircle size={16} /> {error}
                </div>
              )}

              {/* Navigation */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-lg)' }}>
                <button className="btn btn-outline" onClick={() => setPhase(2)}>Back</button>
                <button
                  className="btn btn-primary"
                  onClick={handleDetailsNext}
                  disabled={isRecordingTC || isRecordingCtx || isTranscribingTC || isTranscribingCtx}
                >
                  Next — Shift & Time
                </button>
              </div>
            </>
          )}

          {/* ========== Phase 4: Shift + End Time ========== */}
          {phase === 4 && (
            <>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-lg)' }}>
                Select the schedule shift and enter the end time for this crew.
              </p>

              {/* Schedule Section */}
              {scheduleLoading ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-xl)' }}>
                  <Loader2 size={24} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--color-accent)' }} />
                  <p style={{ fontSize: '0.875rem', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-sm)' }}>
                    Loading schedule...
                  </p>
                </div>
              ) : noSchedule ? (
                <div style={{
                  padding: 'var(--space-md)',
                  background: 'var(--color-info-light)',
                  border: '1px solid var(--color-info-border)',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: 'var(--space-lg)',
                  fontSize: '0.875rem',
                  color: 'var(--color-info)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
                    <CalendarDays size={16} />
                    <strong>No schedule uploaded.</strong>
                  </div>
                  <p style={{ margin: '0 0 var(--space-sm)', fontSize: '0.8125rem' }}>
                    You can still import crew data without schedule info, or upload a schedule now.
                  </p>
                  <input
                    ref={scheduleFileRef}
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={handleInlineScheduleUpload}
                    style={{ display: 'none' }}
                  />
                  <button
                    className="btn btn-outline"
                    onClick={() => scheduleFileRef.current?.click()}
                    disabled={isUploadingSchedule}
                    style={{ fontSize: '0.8rem', padding: '4px 12px' }}
                  >
                    {isUploadingSchedule ? (
                      <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Parsing Schedule...</>
                    ) : (
                      <><Upload size={14} /> Upload Schedule PDF</>
                    )}
                  </button>
                </div>
              ) : (
                <div style={{ marginBottom: 'var(--space-lg)' }}>
                  {/* Schedule Picker — switch between uploaded schedules */}
                  {scheduleList.length > 1 && (
                    <div style={{ marginBottom: 'var(--space-md)' }}>
                      <label className="label" style={{ marginBottom: 'var(--space-xs)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                        Schedule
                        <span style={{
                          fontSize: '0.65rem',
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: isGrindOverlay ? 'var(--color-info-light)' : 'var(--color-success-light)',
                          color: isGrindOverlay ? 'var(--color-info)' : 'var(--color-success)',
                          fontWeight: 500,
                        }}>
                          {isGrindOverlay ? 'Grind & Overlay' : 'Digout'}
                        </span>
                      </label>
                      <select
                        className="input"
                        value={selectedScheduleId}
                        onChange={(e) => handleScheduleSwitch(e.target.value)}
                        style={{ marginBottom: 'var(--space-sm)' }}
                      >
                        {scheduleList.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.filename} ({s.schedule_type === 'grind_overlay' ? 'G&O' : 'Digout'})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Shift Dropdown */}
                  <label className="label" style={{ marginBottom: 'var(--space-xs)' }}>Shift</label>
                  <select
                    className="input"
                    value={selectedShift}
                    onChange={(e) => handleShiftChange(e.target.value)}
                    style={{ marginBottom: 'var(--space-md)' }}
                  >
                    {shiftKeys.map(key => (
                      <option key={key} value={key}>{key}</option>
                    ))}
                  </select>

                  {/* Shift Table */}
                  {shiftData && shiftData.rows.length > 0 && (
                    <div style={{ overflowX: 'auto', marginBottom: 'var(--space-md)' }}>
                      <table style={{
                        width: '100%',
                        fontSize: '0.75rem',
                        borderCollapse: 'collapse',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                      }}>
                        <thead>
                          <tr style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}>
                            <th style={thStyle}>Direction</th>
                            <th style={thStyle}>DO#</th>
                            <th style={thStyle}>Depth</th>
                            {!isGrindOverlay && <th style={thStyle}>W</th>}
                            {!isGrindOverlay && <th style={thStyle}>L</th>}
                            <th style={thStyle}>SF</th>
                            <th style={thStyle}>Tons</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shiftData.rows.map((row, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                              <td style={tdStyle}>{row.direction}</td>
                              <td style={tdStyle}>{row.do_number}</td>
                              <td style={tdStyle}>{row.depth}'</td>
                              {!isGrindOverlay && <td style={tdStyle}>{row.width}</td>}
                              {!isGrindOverlay && <td style={tdStyle}>{row.length}</td>}
                              <td style={tdStyle}>{row.sf.toLocaleString()}</td>
                              <td style={tdStyle}>{row.tons}</td>
                            </tr>
                          ))}
                          {/* Totals Row */}
                          <tr style={{ background: 'var(--color-bg)', fontWeight: 600 }}>
                            <td style={tdStyle} colSpan={isGrindOverlay ? 3 : 5}>Total</td>
                            <td style={tdStyle}>{shiftData.total_sf.toLocaleString()}</td>
                            <td style={tdStyle}>{shiftData.total_tons.toLocaleString()}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Station Ranges — G&O only */}
                  {isGrindOverlay && !noSchedule && (
                    <div style={{ marginBottom: 'var(--space-md)' }}>
                      <label className="label" style={{ marginBottom: 'var(--space-xs)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                        Stations Completed
                        <span style={{ fontSize: '0.7rem', color: 'var(--color-text-tertiary)', fontWeight: 400 }}>e.g. STA 10+00</span>
                      </label>
                      {stationRanges.map((range, i) => (
                        <div key={i} style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', marginBottom: 'var(--space-xs)' }}>
                          <input
                            type="text"
                            className="input"
                            placeholder="Start station"
                            value={range.from}
                            onChange={(e) => {
                              const updated = [...stationRanges];
                              updated[i] = { ...updated[i], from: e.target.value };
                              setStationRanges(updated);
                            }}
                            style={{ flex: 1 }}
                          />
                          <span style={{ color: 'var(--color-text-tertiary)', fontSize: '0.8rem' }}>to</span>
                          <input
                            type="text"
                            className="input"
                            placeholder="End station"
                            value={range.to}
                            onChange={(e) => {
                              const updated = [...stationRanges];
                              updated[i] = { ...updated[i], to: e.target.value };
                              setStationRanges(updated);
                            }}
                            style={{ flex: 1 }}
                          />
                          {stationRanges.length > 1 && (
                            <button
                              className="btn btn-outline"
                              style={{ padding: '4px 8px', fontSize: '0.75rem', minWidth: 'auto' }}
                              onClick={() => setStationRanges(stationRanges.filter((_, idx) => idx !== i))}
                              title="Remove this range"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        className="btn btn-outline"
                        style={{ fontSize: '0.75rem', padding: '4px 12px', marginTop: 'var(--space-xs)' }}
                        onClick={() => setStationRanges([...stationRanges, { from: '', to: '' }])}
                      >
                        + Add skipped section
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Schedule Error */}
              {scheduleError && (
                <div style={{
                  marginBottom: 'var(--space-md)',
                  padding: 'var(--space-sm) var(--space-md)',
                  background: 'var(--color-danger-light)',
                  border: '1px solid var(--color-danger-border)',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  color: 'var(--color-danger)',
                  fontSize: '0.875rem',
                }}>
                  <AlertCircle size={16} />
                  {scheduleError}
                </div>
              )}

              {/* End Time */}
              <div style={{ marginBottom: 'var(--space-md)' }}>
                <label className="label" style={{ marginBottom: 'var(--space-xs)' }}>End Time</label>
                <input
                  type="time"
                  className="input"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  style={{ maxWidth: '160px' }}
                />
                {commonStartTime && calculatedHours > 0 && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                    {commonStartTime} → {formatEndTime(endTime)} = <strong>{calculatedHours} hrs</strong>
                  </p>
                )}
              </div>

              {/* Navigation */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-lg)' }}>
                <button className="btn btn-outline" onClick={() => setPhase(3)}>Back</button>
                <button
                  className="btn btn-primary"
                  onClick={handlePhase3Next}
                >
                  Next — Preview
                </button>
              </div>
            </>
          )}

          {/* ========== Phase 3: Preview + Add ========== */}
          {phase === 5 && previewActivity && (
            <>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-lg)' }}>
                Review what will be added to your report.
              </p>

              <div className="card" style={{ marginBottom: 'var(--space-md)', border: '1px solid var(--color-border)' }}>
                <div className="card-body" style={{ padding: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                  {/* Work Area */}
                  <div>
                    <label className="label" style={{ fontSize: '0.75rem' }}>Work Area</label>
                    <p style={{ fontSize: '0.875rem', margin: 0 }}>{previewActivity.work_area || '—'}</p>
                  </div>

                  {/* Stations */}
                  <div>
                    <label className="label" style={{ fontSize: '0.75rem' }}>Stations / Location</label>
                    <p style={{ fontSize: '0.875rem', margin: 0 }}>{previewActivity.stations || '—'}</p>
                  </div>

                  {/* Summary */}
                  {previewActivity.summary && (
                    <div>
                      <label className="label" style={{ fontSize: '0.75rem' }}>Summary</label>
                      <pre style={{
                        fontSize: '0.8125rem',
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        fontFamily: 'inherit',
                        background: 'var(--color-bg)',
                        padding: 'var(--space-sm)',
                        borderRadius: 'var(--radius-sm)',
                        maxHeight: '150px',
                        overflow: 'auto',
                      }}>
                        {previewActivity.summary}
                      </pre>
                    </div>
                  )}

                  {/* Counts */}
                  <div style={{
                    display: 'flex', gap: 'var(--space-lg)', marginTop: 'var(--space-xs)',
                    paddingTop: 'var(--space-sm)', borderTop: '1px solid var(--color-border)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                      <Users size={14} style={{ color: 'var(--color-accent)' }} />
                      <span style={{ fontSize: '0.875rem' }}>
                        <strong>{previewActivity.manpower.length}</strong> manpower
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                      <Wrench size={14} style={{ color: 'var(--color-accent)' }} />
                      <span style={{ fontSize: '0.875rem' }}>
                        <strong>{previewActivity.equipment.length}</strong> equipment
                      </span>
                    </div>
                    {previewActivity.extra_work_manpower.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                        <FileText size={14} style={{ color: 'var(--color-warning)' }} />
                        <span style={{ fontSize: '0.875rem', color: 'var(--color-warning)' }}>
                          <strong>{previewActivity.extra_work_manpower.length}</strong> EW manpower
                        </span>
                      </div>
                    )}
                    {previewActivity.extra_work_equipment.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                        <Wrench size={14} style={{ color: 'var(--color-warning)' }} />
                        <span style={{ fontSize: '0.875rem', color: 'var(--color-warning)' }}>
                          <strong>{previewActivity.extra_work_equipment.length}</strong> EW equipment
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Success Icon */}
              <div style={{ textAlign: 'center', margin: 'var(--space-sm) 0' }}>
                <CheckCircle2 size={32} style={{ color: 'var(--color-success)' }} />
              </div>

              {/* Navigation */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-lg)' }}>
                <button className="btn btn-outline" onClick={() => setPhase(4)}>Back</button>
                <button
                  className="btn btn-primary"
                  onClick={handleAddToReport}
                >
                  <CheckCircle2 size={16} /> Add to Report
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Resource Resolution Dialog — shown when unmatched resources detected */}
      {showResolution && unmatchedItems.length > 0 && (
        <ResourceResolutionDialog
          items={unmatchedItems}
          onResolve={handleResolutionComplete}
          onCancel={() => {
            // Cancel resolution — advance with unmatched codes anyway
            if (pendingActivity) {
              setPreviewActivity(pendingActivity);
              setPhase(5);
            }
            setShowResolution(false);
            setUnmatchedItems([]);
            setPendingActivity(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================
// Shared table styles
// ============================================

const thStyle: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: '0.7rem',
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const tdStyle: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'left',
};
