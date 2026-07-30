/**
 * Daily Reporter V3 — Activity Editor
 *
 * A single collapsible activity section.
 * Contains: work area, summary, manpower table, equipment table.
 * Supports extra work and consultant sections.
 *
 * AI Features:
 * -  AI Rewrite button in summary toolbar
 * -  AI Assistant side panel (WWWW + generate)
 * -  Update with Media (Smart Merge) panel
 *
 * This is an ON-PAGE section, NOT a modal.
 * Clicking outside does nothing. You close it by collapsing it.
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { DocTally } from '@/components/ui/Doc';
import { useReportStore } from '@/stores/reportStore';
import { ResourceTable } from '@/components/report/ResourceTable';
import { AIReportAssistant } from '@/components/report/AIReportAssistant';
import { ActivityUpdatePanel } from '@/components/report/ActivityUpdatePanel';
import { PhoneScannerModal } from '@/components/report/PhoneScannerModal';
import { scanApi } from '@/lib/api';
import { getResourceMatcher } from '@/lib/resourceMatcher';
import { applyEndTimeToRows, isEndTimeApplied, formatEndTime } from '@/lib/dispatchHelpers';
import type { Activity, ManpowerRow, EquipmentRow } from '@/types';
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  HardHat,
  Truck,
  AlertTriangle,
  Users,
  Sparkles,
  Wand2,
  Camera,
  Loader2,
  Mic,
  MicOff,
  FileText,
  Clock,
  AlertCircle,
  X,
  CheckCircle2,
} from 'lucide-react';

// ============================================
// Merge Helpers (ported from V1 — idempotent dedup)
// ============================================

/** Merge incoming manpower rows into existing, deduping by trade+name key */
function mergeManpower(existing: ManpowerRow[], incoming: ManpowerRow[]): ManpowerRow[] {
  const result = [...existing];
  for (const row of incoming) {
    const key = `${(row.trade || '').toLowerCase()}|${(row.name || '').toLowerCase()}`;
    const idx = result.findIndex(
      (r) => `${(r.trade || '').toLowerCase()}|${(r.name || '').toLowerCase()}` === key
    );
    if (idx >= 0) {
      // Update existing row — keep higher qty/hours
      result[idx] = {
        ...result[idx],
        qty: Math.max(result[idx].qty || 0, row.qty || 0),
        hours: Math.max(result[idx].hours || 0, row.hours || 0),
        start_time: row.start_time || result[idx].start_time,
        stop_time: row.stop_time || result[idx].stop_time,
        company: row.company || result[idx].company,
      };
    } else {
      result.push({ ...row, id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` });
    }
  }
  return result;
}

/** Merge incoming equipment rows into existing, deduping by name+description key */
function mergeEquipment(existing: EquipmentRow[], incoming: EquipmentRow[]): EquipmentRow[] {
  const result = [...existing];
  for (const row of incoming) {
    const key = `${(row.name || '').toLowerCase()}|${(row.description || '').toLowerCase()}`;
    const idx = result.findIndex(
      (r) => `${(r.name || '').toLowerCase()}|${(r.description || '').toLowerCase()}` === key
    );
    if (idx >= 0) {
      result[idx] = {
        ...result[idx],
        qty: Math.max(result[idx].qty || 0, row.qty || 0),
        hours: Math.max(result[idx].hours || 0, row.hours || 0),
        start_time: row.start_time || result[idx].start_time,
        stop_time: row.stop_time || result[idx].stop_time,
        company: row.company || result[idx].company,
      };
    } else {
      result.push({ ...row, id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` });
    }
  }
  return result;
}

// ============================================
// Manpower → Equipment Default Cascade
// ============================================

/** Derive representative defaults from manpower rows for equipment cascade */
function deriveManpowerDefaults(rows: ManpowerRow[]): {
  startTime: string | undefined;
  stopTime: string | undefined;
  hours: number | undefined;
  company: string | undefined;
} {
  // Only consider rows that have a trade assigned (skip empty placeholder rows)
  const filled = rows.filter((r) => r.trade?.trim());
  if (filled.length === 0) return { startTime: undefined, stopTime: undefined, hours: undefined, company: undefined };

  // Find the mode (most common value) for each field
  function mode(values: string[]): string | undefined {
    const nonEmpty = values.filter((v) => v?.trim());
    if (nonEmpty.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const v of nonEmpty) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [val, count] of counts) {
      if (count > bestCount) { best = val; bestCount = count; }
    }
    return best || undefined;
  }

  function modeNum(values: number[]): number | undefined {
    const nonZero = values.filter((v) => v > 0);
    if (nonZero.length === 0) return undefined;
    const counts = new Map<number, number>();
    for (const v of nonZero) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [val, count] of counts) {
      if (count > bestCount) { best = val; bestCount = count; }
    }
    return best || undefined;
  }

  return {
    startTime: mode(filled.map((r) => r.start_time || '')),
    stopTime: mode(filled.map((r) => r.stop_time || '')),
    hours: modeNum(filled.map((r) => r.hours || 0)),
    company: mode(filled.map((r) => r.company || '')),
  };
}

interface ActivityEditorProps {
  activity: Activity;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  companyOptions?: string[];
  /**
   * End time the first activity in this report was closed out with. Pre-fills
   * this activity's box so crews that finished together only get typed once —
   * it is only a starting value and can be changed before applying.
   */
  sharedEndTime?: string;
  /** Called when this activity applies an end time, so later ones inherit it. */
  onEndTimeApplied?: (endTime: string) => void;
}

export function ActivityEditor({
  activity,
  index,
  isExpanded,
  onToggle,
  onRemove,
  companyOptions,
  sharedEndTime = '',
  onEndTimeApplied,
}: ActivityEditorProps) {
  const { report, updateActivity } = useReportStore();
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [isUpdatePanelOpen, setIsUpdatePanelOpen] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [showPhoneScanner, setShowPhoneScanner] = useState(false);
  const [scanningFromCamera, setScanningFromCamera] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  // Collapsible resource table sections — expand only when needed
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // End time for this activity. Null means "untouched" — show whatever the first
  // closed-out activity used, so typing it once covers crews that left together.
  const [typedEndTime, setTypedEndTime] = useState<string | null>(null);
  const endTime = typedEndTime ?? sharedEndTime;

  // Derive defaults from manpower rows to cascade to equipment tables.
  // Contract manpower → contract equipment, extra work manpower → extra work equipment.
  const mpDefaults = useMemo(
    () => deriveManpowerDefaults(activity.manpower || []),
    [activity.manpower],
  );
  const ewMpDefaults = useMemo(
    () => deriveManpowerDefaults(activity.extra_work_manpower || []),
    [activity.extra_work_manpower],
  );

  // How many rows the end time would land on, for the button's caption
  const endTimeTargets = useMemo(() => {
    const all = [
      ...(activity.manpower || []),
      ...(activity.equipment || []),
      ...(activity.extra_work_manpower || []),
      ...(activity.extra_work_equipment || []),
      ...(activity.consultant_manpower || []),
    ];
    return { checked: all.filter(isEndTimeApplied).length, total: all.length };
  }, [activity]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timesheetInputRef = useRef<HTMLInputElement>(null);

  // --- Scan Timesheet (file upload → scanNotes → merge) ---
  const handleTimesheetScan = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsScanning(true);
    try {
      const data = await scanApi.scanNotes(Array.from(files), true);
      if (!data?.activities?.length) { console.warn('[Scan] No data returned'); return; }

      const matcher = getResourceMatcher();
      const updates: Partial<Activity> = {};
      const allManpower: ManpowerRow[] = [];
      const allEquipment: EquipmentRow[] = [];
      const summaryParts: string[] = [];

      for (const act of data.activities) {
        if (act.manpower?.length) {
          const processed = matcher.processManpower(act.manpower.map((m: Record<string, unknown>) => ({
            trade: String(m.trade || ''), name: String(m.name || ''),
            qty: Number(m.qty || 0), hours: Number(m.hours || 0),
            start_time: String(m.start_time || ''), stop_time: String(m.stop_time || ''),
            company: String(m.company || ''), is_3rd_party: !!m.is_3rd_party,
          })));
          allManpower.push(...(processed.rows as unknown as ManpowerRow[]));
        }
        if (act.equipment?.length) {
          const processed = matcher.processEquipment(act.equipment.map((eq: Record<string, unknown>) => ({
            name: String(eq.name || ''), description: String(eq.description || ''),
            qty: Number(eq.qty || 0), hours: Number(eq.hours || 0),
            start_time: String(eq.start_time || ''), stop_time: String(eq.stop_time || ''),
            company: String(eq.company || ''), is_3rd_party: !!eq.is_3rd_party, is_rental: !!eq.is_rental,
          })));
          allEquipment.push(...(processed.rows as unknown as EquipmentRow[]));
        }
        if (act.summary_html || act.summary) summaryParts.push(String(act.summary_html || act.summary));
        if (act.work_area && !activity.work_area) updates.work_area = String(act.work_area);
      }

      if (allManpower.length) updates.manpower = mergeManpower(activity.manpower || [], allManpower);
      if (allEquipment.length) updates.equipment = mergeEquipment(activity.equipment || [], allEquipment);
      if (summaryParts.length) {
        const current = activity.summary || '';
        updates.summary = current ? `${current}\n[Timesheet]\n${summaryParts.join('\n')}` : summaryParts.join('\n');
      }

      if (Object.keys(updates).length > 0) updateActivity(activity.id, updates);
      console.debug('[Scan] Timesheet applied:', { manpower: allManpower.length, equipment: allEquipment.length });
    } catch (err) {
      console.error('[Scan] Timesheet error:', err);
    } finally {
      setIsScanning(false);
      if (e.target) e.target.value = '';
    }
  }, [activity, updateActivity]);

  // --- Smart Dictation (record → transcribe-smart → merge) ---
  const handleVoiceRecord = useCallback(async () => {
    if (isRecording) {
      // Stop recording
      if (!mediaRecorderRef.current) return;
      mediaRecorderRef.current.stop();
      return;
    }
    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (ev) => audioChunksRef.current.push(ev.data);
      recorder.onstop = async () => {
        setIsRecording(false);
        setIsProcessingAudio(true);
        stream.getTracks().forEach((t) => t.stop());
        try {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onloadend = async () => {
            try {
              const base64 = reader.result as string;
              const data = await scanApi.transcribeSmart(base64, 'summary', 'audio/webm', {});
              const updates: Partial<Activity> = {};
              if (data.summary_html) {
                const cur = activity.summary || '';
                updates.summary = cur ? `${cur}\n${data.summary_html}` : data.summary_html;
              }
              if (data.work_area && !activity.work_area) updates.work_area = data.work_area;
              if (data.manpower?.length) {
                const matcher = getResourceMatcher();
                const proc = matcher.processManpower(data.manpower);
                updates.manpower = mergeManpower(activity.manpower || [], proc.rows as unknown as ManpowerRow[]);
              }
              if (data.equipment?.length) {
                const matcher = getResourceMatcher();
                const proc = matcher.processEquipment(data.equipment);
                updates.equipment = mergeEquipment(activity.equipment || [], proc.rows as unknown as EquipmentRow[]);
              }
              if (Object.keys(updates).length > 0) updateActivity(activity.id, updates);
            } catch (err) { console.error('[Dictate] Transcribe error:', err); }
            setIsProcessingAudio(false);
          };
          reader.readAsDataURL(blob);
        } catch (err) { console.error('[Dictate] Blob error:', err); setIsProcessingAudio(false); }
      };
      recorder.start();
      setIsRecording(true);
    } catch (err) { console.error('[Dictate] Mic denied:', err); }
  }, [isRecording, activity, updateActivity]);

  // --- Camera capture (PhoneScannerModal → scanNotes → merge) ---
  const handleCameraCapture = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setScanningFromCamera(true);
    try {
      const data = await scanApi.scanNotes(files, true);
      if (!data?.activities?.length) return;
      const matcher = getResourceMatcher();
      const updates: Partial<Activity> = {};
      const allMp: ManpowerRow[] = [];
      const allEq: EquipmentRow[] = [];
      const parts: string[] = [];
      for (const act of data.activities) {
        if (act.manpower?.length) allMp.push(...(matcher.processManpower(act.manpower).rows as unknown as ManpowerRow[]));
        if (act.equipment?.length) allEq.push(...(matcher.processEquipment(act.equipment).rows as unknown as EquipmentRow[]));
        if (act.summary_html || act.summary) parts.push(String(act.summary_html || act.summary));
      }
      if (allMp.length) updates.manpower = mergeManpower(activity.manpower || [], allMp);
      if (allEq.length) updates.equipment = mergeEquipment(activity.equipment || [], allEq);
      if (parts.length) {
        const cur = activity.summary || '';
        updates.summary = cur ? `${cur}\n${parts.join('\n')}` : parts.join('\n');
      }
      if (Object.keys(updates).length > 0) updateActivity(activity.id, updates);
    } catch (err) { console.error('[Camera] Scan error:', err); }
    finally { setScanningFromCamera(false); }
  }, [activity, updateActivity]);

  function handleChange(field: string, value: string) {
    updateActivity(activity.id, { [field]: value });
  }

  function handleManpowerChange(rows: (ManpowerRow | EquipmentRow)[]) {
    updateActivity(activity.id, { manpower: rows as ManpowerRow[] });
  }

  function handleEquipmentChange(rows: (ManpowerRow | EquipmentRow)[]) {
    updateActivity(activity.id, { equipment: rows as EquipmentRow[] });
  }

  function handleExtraWorkManpowerChange(rows: (ManpowerRow | EquipmentRow)[]) {
    updateActivity(activity.id, { extra_work_manpower: rows as ManpowerRow[] });
  }

  function handleExtraWorkEquipmentChange(rows: (ManpowerRow | EquipmentRow)[]) {
    updateActivity(activity.id, { extra_work_equipment: rows as EquipmentRow[] });
  }

  function handleConsultantManpowerChange(rows: (ManpowerRow | EquipmentRow)[]) {
    updateActivity(activity.id, { consultant_manpower: rows as ManpowerRow[] });
  }

  // --- Set End Time: stamp stop times + hours across this activity's tables ---
  function handleApplyEndTime() {
    if (!endTime) return;

    updateActivity(activity.id, {
      manpower: applyEndTimeToRows(activity.manpower || [], endTime),
      equipment: applyEndTimeToRows(activity.equipment || [], endTime),
      extra_work_manpower: applyEndTimeToRows(activity.extra_work_manpower || [], endTime),
      extra_work_equipment: applyEndTimeToRows(activity.extra_work_equipment || [], endTime),
      consultant_manpower: applyEndTimeToRows(activity.consultant_manpower || [], endTime),
    });

    // Later activities inherit this time as their starting value
    onEndTimeApplied?.(endTime);
    console.debug('[ActivityEditor] End time applied to activity', activity.id, '→', endTime);
  }

  // --- AI Rewrite ---
  async function handleRewrite() {
    if (!activity.summary?.trim() || isRewriting) return;
    setIsRewriting(true);
    setRewriteError(null);
    try {
      const data = await scanApi.rewrite(activity.summary);
      const polished = data.text || data.report_text || '';
      if (!polished) {
        // Server said OK but sent nothing usable — don't wipe the summary
        throw new Error('The AI returned an empty rewrite. Your notes are unchanged.');
      }
      updateActivity(activity.id, { summary: polished });
    } catch (err) {
      console.error('[ActivityEditor] Rewrite failed:', err);
      const httpErr = err as { response?: { data?: { detail?: string } } };
      setRewriteError(
        httpErr?.response?.data?.detail
        || (err instanceof Error ? err.message : 'Rewrite failed. Try again.')
      );
    } finally {
      setIsRewriting(false);
    }
  }

  // --- AI Assistant Apply ---
  function handleAssistantApply(updates: Partial<Activity>) {
    updateActivity(activity.id, updates);
  }

  // --- Update Panel Apply ---
  function handleUpdateApply(updates: Partial<Activity>) {
    updateActivity(activity.id, updates);
  }

  // Summary for collapsed view
  const mpCount = (activity.manpower?.length || 0) +
    (activity.extra_work_manpower?.length || 0) +
    (activity.consultant_manpower?.length || 0);
  const eqCount = (activity.equipment?.length || 0) +
    (activity.extra_work_equipment?.length || 0);

  // What this activity still needs, shown on the collapsed header so you can
  // see what wants attention without opening all five resource tables.
  // "Hours" counts only rows that have a resource picked — an empty placeholder
  // row is not a missing-hours problem.
  const gaps: string[] = [];
  if (!activity.work_area?.trim()) gaps.push('location');
  if (!activity.summary?.trim()) gaps.push('summary');
  if (mpCount === 0) gaps.push('crew');
  else {
    const filled = [
      ...(activity.manpower || []),
      ...(activity.extra_work_manpower || []),
      ...(activity.consultant_manpower || []),
    ].filter((r) => r.trade?.trim());
    if (filled.length > 0 && filled.some((r) => !r.hours)) gaps.push('hours');
  }

  return (
    <>
      <div className="doc-activity" data-open={isExpanded}>
        {/* Collapsible Header — the activity is the content of the report, so
            it gets a number, a real heading, and its location as a subtitle.
            Previously this was a thin strip with the same weight as everything
            else on the page. */}
        <button
          type="button"
          onClick={onToggle}
          className="doc-activity-head"
        >
          <span className="doc-activity-index">{index + 1}</span>

          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="doc-activity-title">
              {activity.work_area || `Activity ${index + 1}`}
            </span>
            {(activity.stations || !activity.work_area) && (
              <span className="doc-activity-sub">
                {activity.stations || 'No location set'}
              </span>
            )}
          </span>

          <span style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
            flexShrink: 0,
          }}>
            {mpCount > 0 && <DocTally value={mpCount} label="crew" />}
            {eqCount > 0 && <DocTally value={eqCount} label="equip" />}
            {gaps.length > 0 ? (
              <span
                className="doc-status doc-status-warn"
                title={`Still needed: ${gaps.join(', ')}`}
              >
                {gaps.length === 1 ? gaps[0] : `${gaps.length} missing`}
              </span>
            ) : (
              <CheckCircle2 size={15} style={{ color: 'var(--color-success)' }} />
            )}
            {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </span>
        </button>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="card-body" style={{ borderTop: '1px solid var(--color-border)' }}>
            {/* Work Area + Stations */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr',
              gap: 'var(--space-md)',
              marginBottom: 'var(--space-md)',
            }}>
              <div>
                <label className="label">Work Area</label>
                <input
                  className="input"
                  value={activity.work_area}
                  onChange={(e) => handleChange('work_area', e.target.value)}
                  placeholder="e.g. North Tunnel Portal, Morena Pipeline"
                />
              </div>
              <div>
                <label className="label">Stations</label>
                <input
                  className="input"
                  value={activity.stations}
                  onChange={(e) => handleChange('stations', e.target.value)}
                  placeholder="e.g. Sta 10+00 to 15+50"
                />
              </div>
            </div>

            {/* Summary with AI toolbar */}
            <div style={{ marginBottom: 'var(--space-lg)' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '4px',
              }}>
                <label className="label" style={{ margin: 0 }}>Work Summary</label>
                <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
                  {/* Smart Dictate — record voice → AI parses summary + resources */}
                  <button
                    className={`btn btn-ghost btn-sm ${isRecording ? 'btn-recording' : ''}`}
                    onClick={handleVoiceRecord}
                    disabled={isProcessingAudio}
                    title={isRecording ? 'Stop recording' : isProcessingAudio ? 'Processing...' : 'Smart Dictate — speak to fill summary + resources'}
                    style={{ fontSize: '0.6875rem', padding: '2px 8px', gap: '3px', color: isRecording ? 'var(--color-danger)' : undefined }}
                  >
                    {isProcessingAudio ? (
                      <><Loader2 size={12} style={{ animation: 'spin 0.6s linear infinite' }} /> Processing...</>
                    ) : isRecording ? (
                      <><MicOff size={12} /> Stop</>
                    ) : (
                      <><Mic size={12} /> Dictate</>
                    )}
                  </button>
                  {/* Camera — opens device camera for document capture */}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowPhoneScanner(true)}
                    disabled={scanningFromCamera}
                    title="Camera — capture timesheets or notes"
                    style={{ fontSize: '0.6875rem', padding: '2px 8px', gap: '3px' }}
                  >
                    {scanningFromCamera ? (
                      <><Loader2 size={12} style={{ animation: 'spin 0.6s linear infinite' }} /> Scanning...</>
                    ) : (
                      <><Camera size={12} /> Camera</>
                    )}
                  </button>
                  {/* Scan Timesheet — file upload */}
                  <input
                    ref={timesheetInputRef}
                    type="file"
                    accept="image/*,.pdf,.heic,.heif"
                    multiple
                    onChange={handleTimesheetScan}
                    style={{ display: 'none' }}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => timesheetInputRef.current?.click()}
                    disabled={isScanning}
                    title="Scan Timesheet — upload images/PDFs"
                    style={{ fontSize: '0.6875rem', padding: '2px 8px', gap: '3px' }}
                  >
                    {isScanning ? (
                      <><Loader2 size={12} style={{ animation: 'spin 0.6s linear infinite' }} /> Scanning...</>
                    ) : (
                      <><FileText size={12} /> Scan Timesheet</>
                    )}
                  </button>
                  {/* AI Rewrite button */}
                  {activity.summary?.trim() && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleRewrite}
                      disabled={isRewriting}
                      title="AI Rewrite — polish into professional bullets"
                      style={{ fontSize: '0.6875rem', padding: '2px 8px', gap: '3px' }}
                    >
                      {isRewriting ? (
                        <Loader2 size={12} style={{ animation: 'spin 0.6s linear infinite' }} />
                      ) : (
                        <Wand2 size={12} />
                      )}
                      Rewrite
                    </button>
                  )}
                  {/* AI Assistant button */}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setIsAssistantOpen(true)}
                    title="AI Assistant — chat-based report helper"
                    style={{ fontSize: '0.6875rem', padding: '2px 8px', gap: '3px', color: 'var(--color-accent)' }}
                  >
                    <Sparkles size={12} />
                    AI Assistant
                  </button>
                  {/* Update with Media button */}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setIsUpdatePanelOpen(!isUpdatePanelOpen)}
                    title="Update with photo, video, audio, or document"
                    style={{ fontSize: '0.6875rem', padding: '2px 8px', gap: '3px' }}
                  >
                    <Camera size={12} />
                    Media
                  </button>
                </div>
              </div>
              {rewriteError && (
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '6px',
                  padding: '8px 10px',
                  marginBottom: '6px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-danger-bg, #FEF2F2)',
                  color: 'var(--color-danger, #dc2626)',
                  fontSize: '0.75rem',
                }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ flex: 1 }}>{rewriteError}</span>
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => setRewriteError(null)}
                    aria-label="Dismiss"
                    style={{ width: 18, height: 18, padding: 0, flexShrink: 0 }}
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
              <textarea
                className="textarea"
                value={activity.summary}
                onChange={(e) => handleChange('summary', e.target.value)}
                placeholder="Describe the work performed in this area today..."
                style={{ minHeight: '200px' }}
              />
            </div>

            {/* Activity Update Panel (Smart Merge from media) */}
            {isUpdatePanelOpen && (
              <ActivityUpdatePanel
                activity={activity}
                onApply={handleUpdateApply}
                onClose={() => setIsUpdatePanelOpen(false)}
              />
            )}

            {/* --- Set End Time --- */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-sm)',
              flexWrap: 'wrap',
              padding: 'var(--space-sm) var(--space-md)',
              marginTop: 'var(--space-md)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg)',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
              }}>
                <Clock size={14} />
                End Time
              </div>
              <input
                className="input"
                type="time"
                value={endTime}
                onChange={(e) => setTypedEndTime(e.target.value)}
                style={{ width: '130px', fontSize: '0.8125rem' }}
                id={`activity-${index}-end-time`}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleApplyEndTime}
                disabled={!endTime || endTimeTargets.checked === 0}
                title={
                  endTimeTargets.checked === 0
                    ? 'No rows are checked in the End column'
                    : `Set stop time and recalculate hours for ${endTimeTargets.checked} row(s)`
                }
                style={{ fontSize: '0.75rem' }}
              >
                Set End Time
              </button>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                {endTimeTargets.total === 0
                  ? 'No resource rows yet'
                  : `Applies to ${endTimeTargets.checked} of ${endTimeTargets.total} rows${
                      endTime ? ` — stops at ${formatEndTime(endTime)}` : ''
                    }. Untick a row's End box to leave it alone.`}
              </span>
            </div>

            {/* --- Contract Manpower --- */}
            <CollapsibleResourceSection
              icon={<HardHat size={16} />}
              label="Manpower"
              color="var(--color-accent)"
              count={activity.manpower?.length || 0}
              isExpanded={expandedSections.has('manpower')}
              onToggle={() => setExpandedSections(prev => {
                const next = new Set(prev);
                next.has('manpower') ? next.delete('manpower') : next.add('manpower');
                return next;
              })}
            >
              <ResourceTable
                type="manpower"
                rows={activity.manpower}
                onChange={handleManpowerChange}
                companyOptions={companyOptions}
              />
            </CollapsibleResourceSection>

            {/* --- Contract Equipment --- */}
            <CollapsibleResourceSection
              icon={<Truck size={16} />}
              label="Equipment"
              color="var(--color-accent)"
              count={activity.equipment?.length || 0}
              isExpanded={expandedSections.has('equipment')}
              onToggle={() => setExpandedSections(prev => {
                const next = new Set(prev);
                next.has('equipment') ? next.delete('equipment') : next.add('equipment');
                return next;
              })}
            >
              <ResourceTable
                type="equipment"
                rows={activity.equipment}
                onChange={handleEquipmentChange}
                companyOptions={companyOptions}
                defaultStartTime={mpDefaults.startTime}
                defaultStopTime={mpDefaults.stopTime}
                defaultHours={mpDefaults.hours}
                defaultCompany={mpDefaults.company}
              />
            </CollapsibleResourceSection>

            {/* --- Extra Work Manpower --- */}
            <CollapsibleResourceSection
              icon={<AlertTriangle size={16} />}
              label="Extra Work — Manpower"
              color="var(--color-warning)"
              count={activity.extra_work_manpower?.length || 0}
              isExpanded={expandedSections.has('ew_manpower')}
              onToggle={() => setExpandedSections(prev => {
                const next = new Set(prev);
                next.has('ew_manpower') ? next.delete('ew_manpower') : next.add('ew_manpower');
                return next;
              })}
            >
              <ResourceTable
                type="manpower"
                rows={activity.extra_work_manpower}
                onChange={handleExtraWorkManpowerChange}
                companyOptions={companyOptions}
              />
            </CollapsibleResourceSection>

            {/* --- Extra Work Equipment --- */}
            <CollapsibleResourceSection
              icon={<AlertTriangle size={16} />}
              label="Extra Work — Equipment"
              color="var(--color-warning)"
              count={activity.extra_work_equipment?.length || 0}
              isExpanded={expandedSections.has('ew_equipment')}
              onToggle={() => setExpandedSections(prev => {
                const next = new Set(prev);
                next.has('ew_equipment') ? next.delete('ew_equipment') : next.add('ew_equipment');
                return next;
              })}
            >
              <ResourceTable
                type="equipment"
                rows={activity.extra_work_equipment}
                onChange={handleExtraWorkEquipmentChange}
                companyOptions={companyOptions}
                defaultStartTime={ewMpDefaults.startTime}
                defaultStopTime={ewMpDefaults.stopTime}
                defaultHours={ewMpDefaults.hours}
                defaultCompany={ewMpDefaults.company}
              />
            </CollapsibleResourceSection>

            {/* --- Consultants --- */}
            <CollapsibleResourceSection
              icon={<Users size={16} />}
              label="Consultants"
              color="var(--color-ai)"
              count={activity.consultant_manpower?.length || 0}
              isExpanded={expandedSections.has('consultants')}
              onToggle={() => setExpandedSections(prev => {
                const next = new Set(prev);
                next.has('consultants') ? next.delete('consultants') : next.add('consultants');
                return next;
              })}
            >
              <ResourceTable
                type="manpower"
                rows={activity.consultant_manpower}
                onChange={handleConsultantManpowerChange}
                companyOptions={companyOptions}
              />
            </CollapsibleResourceSection>

            {/* Delete button */}
            <div style={{
              borderTop: '1px solid var(--color-border)',
              paddingTop: 'var(--space-md)',
              marginTop: 'var(--space-lg)',
              display: 'flex',
              justifyContent: 'flex-end',
            }}>
              <button className="btn btn-danger btn-sm" onClick={onRemove}>
                <Trash2 size={14} />
                Remove Activity
              </button>
            </div>
          </div>
        )}
      </div>

      {/* AI Report Assistant — side panel */}
      {isAssistantOpen && (
        <AIReportAssistant
          activity={activity}
          reportDate={report?.general?.report_date || ''}
          onApply={handleAssistantApply}
          onClose={() => setIsAssistantOpen(false)}
        />
      )}

      {/* Phone Camera Scanner Modal */}
      <PhoneScannerModal
        isOpen={showPhoneScanner}
        onClose={() => setShowPhoneScanner(false)}
        onCapturedImages={handleCameraCapture}
      />
    </>
  );
}

/** Collapsible resource table section — header bar with count badge, click to expand/collapse */
function CollapsibleResourceSection({
  icon,
  label,
  color,
  count,
  isExpanded,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 'var(--space-md)' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '8px 12px',
          border: `1px solid ${isExpanded ? color : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-md)',
          background: isExpanded ? `${color}10` : 'var(--color-bg)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
          transition: 'all 0.12s ease',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color }}>
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {icon}
          <span className="font-medium" style={{ fontSize: '0.8125rem' }}>{label}</span>
        </div>
        <span className="badge" style={{
          background: count > 0 ? color : 'var(--color-border)',
          color: count > 0 ? '#fff' : 'var(--color-text-tertiary)',
          fontSize: '0.7rem',
          padding: '1px 8px',
          borderRadius: '10px',
          fontWeight: 600,
        }}>
          {count}
        </span>
      </button>
      {isExpanded && (
        <div style={{ marginTop: 'var(--space-xs)' }}>
          {children}
        </div>
      )}
    </div>
  );
}
