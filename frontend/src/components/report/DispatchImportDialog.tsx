/**
 * Daily Reporter V3 — Dispatch Import Dialog
 *
 * Upload a dispatch PDF → AI parses job columns → User selects jobs,
 * picks shift + end time → Activity is built and added to the report.
 *
 * 4-Phase Flow:
 *   Phase 1: Upload PDF
 *   Phase 2: Select job columns
 *   Phase 3: Choose shift + end time
 *   Phase 4: Preview + add to report
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
import {
  Truck, Upload, Loader2, AlertCircle, CheckCircle2, X,
  ChevronDown, ChevronUp, Clock, Users, Wrench, FileText, CalendarDays,
} from 'lucide-react';

// ============================================
// Constants
// ============================================

const PHASE_LABELS = ['Upload', 'Select Jobs', 'Shift & Time', 'Preview'] as const;
type Phase = 0 | 1 | 2 | 3;

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
    setPhase(2);

    // Load schedule
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      const schedule = await scheduleApi.getActive();
      console.debug('[DispatchImport] Loaded schedule:', schedule.filename, 'type:', schedule.schedule_type, 'shifts:', Object.keys(schedule.shifts).length);
      const keys = Object.keys(schedule.shifts).sort();
      setShiftKeys(keys);
      setAllShifts(schedule.shifts);
      setScheduleType((schedule.schedule_type as 'digout' | 'grind_overlay') || 'digout');
      if (keys.length > 0) {
        setSelectedShift(keys[0]);
        setShiftData(schedule.shifts[keys[0]]);
      }
      setNoSchedule(false);
    } catch (err) {
      console.debug('[DispatchImport] No active schedule found (expected if none uploaded):', err);
      setNoSchedule(true);
    } finally {
      setScheduleLoading(false);
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
      const keys = Object.keys(schedule.shifts || {}).sort();
      setShiftKeys(keys);
      setAllShifts(schedule.shifts || {});
      setScheduleType((schedule.schedule_type as 'digout' | 'grind_overlay') || 'digout');
      if (keys.length > 0) {
        setSelectedShift(keys[0]);
        setShiftData(schedule.shifts[keys[0]]);
      }
      setNoSchedule(false);
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
        setPhase(3);
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
      );
      setPreviewActivity(activity);
      setPhase(3);
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
    setPhase(3);
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
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  color: '#DC2626',
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
                                background: job.contract_type === 'CHANGE ORDER' ? '#FFF7ED' : '#EFF6FF',
                                color: job.contract_type === 'CHANGE ORDER' ? '#C2410C' : '#1D4ED8',
                                border: `1px solid ${job.contract_type === 'CHANGE ORDER' ? '#FED7AA' : '#BFDBFE'}`,
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
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  color: '#DC2626',
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
                  Next — Shift & Time
                </button>
              </div>
            </>
          )}

          {/* ========== Phase 2: Shift + End Time ========== */}
          {phase === 2 && (
            <>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-lg)' }}>
                Select the digout schedule shift and enter the end time for this crew.
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
                  background: '#EFF6FF',
                  border: '1px solid #BFDBFE',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: 'var(--space-lg)',
                  fontSize: '0.875rem',
                  color: '#1D4ED8',
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
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  color: '#DC2626',
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
                <button className="btn btn-outline" onClick={() => setPhase(1)}>Back</button>
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
          {phase === 3 && previewActivity && (
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
                        <FileText size={14} style={{ color: '#C2410C' }} />
                        <span style={{ fontSize: '0.875rem', color: '#C2410C' }}>
                          <strong>{previewActivity.extra_work_manpower.length}</strong> EW manpower
                        </span>
                      </div>
                    )}
                    {previewActivity.extra_work_equipment.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                        <Wrench size={14} style={{ color: '#C2410C' }} />
                        <span style={{ fontSize: '0.875rem', color: '#C2410C' }}>
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
                <button className="btn btn-outline" onClick={() => setPhase(2)}>Back</button>
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
              setPhase(3);
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
