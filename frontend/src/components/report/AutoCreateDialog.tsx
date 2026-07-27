/**
 * Daily Reporter V3 — Auto-Create Dialog
 *
 * One-click report factory: enter a date + end time → press Create Report
 * → system automatically fetches weather, loads dispatch from library,
 * matches schedule shift, builds activities, and generates TC description.
 *
 * The dialog shows real-time progress for each step.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReportStore } from '@/stores/reportStore';
import { weatherApi, dispatchApi, scheduleApi, tcApi } from '@/lib/api';
import { settingsApi } from '@/lib/settingsApi';
import { buildActivity } from '@/lib/dispatchHelpers';
import { loadResourceAliases } from '@/lib/resourceMatcher';
import { SKY_CONDITIONS } from '@/lib/constants';
import type {
  DispatchJob,
  ScheduleShift,
  Activity,
  GeneralInfo,
  ManpowerRow,
} from '@/types';
import type { WeatherData } from '@/lib/api';
import {
  Zap, Calendar, FileText,
  Loader2, CheckCircle2, AlertCircle, X, Upload, Clock,
} from 'lucide-react';

// ============================================
// Types
// ============================================

type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

interface StepState {
  status: StepStatus;
  label: string;
  detail: string;
}

interface AutoCreateDialogProps {
  onClose: () => void;
}

// ============================================
// Constants
// ============================================

const INITIAL_STEPS: StepState[] = [
  { status: 'pending', label: 'Create report', detail: '' },
  { status: 'pending', label: 'Fetch weather', detail: '' },
  { status: 'pending', label: 'Load dispatch', detail: '' },
  { status: 'pending', label: 'Match schedule', detail: '' },
  { status: 'pending', label: 'Build activities', detail: '' },
  { status: 'pending', label: 'Traffic control', detail: '' },
];

// ============================================
// Helper: Generate unique IDs
// ============================================

function generateId(): string {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================
// Component
// ============================================

export function AutoCreateDialog({ onClose }: AutoCreateDialogProps) {
  const navigate = useNavigate();
  const {
    newReport,
    updateGeneral,
    addActivity,
    closeReport,
    bumpRevision,
  } = useReportStore();

  // --- Form state ---
  const [date, setDate] = useState('');
  const [endTime, setEndTime] = useState('05:00');

  // --- Progress state ---
  const [isRunning, setIsRunning] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([...INITIAL_STEPS]);
  const [overallError, setOverallError] = useState<string | null>(null);

  // --- Dispatch upload fallback ---
  const [needsUpload, setNeedsUpload] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // ── Step updater ──
  const updateStep = useCallback((index: number, updates: Partial<StepState>) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, ...updates } : s));
  }, []);

  // ── Format end time for display ──
  function formatEndTimeDisplay(t: string): string {
    const match = t.match(/(\d{1,2}):(\d{2})/);
    if (!match) return t;
    let hrs = parseInt(match[1]);
    const mins = match[2];
    const period = hrs >= 12 ? 'PM' : 'AM';
    if (hrs > 12) hrs -= 12;
    if (hrs === 0) hrs = 12;
    return `${hrs}:${mins} ${period}`;
  }

  // ── Format date for display ──
  function formatDateDisplay(d: string): string {
    if (!d) return '';
    const parts = d.split('-');
    if (parts.length !== 3) return d;
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const monthIdx = parseInt(parts[1]) - 1;
    return `${months[monthIdx]} ${parseInt(parts[2])}, ${parts[0]}`;
  }

  // ============================================
  // MAIN AUTOMATION PIPELINE
  // ============================================

  const runAutomation = useCallback(async () => {
    if (!date) {
      setOverallError('Please select a report date.');
      return;
    }

    console.debug('[AutoCreate] Starting automation for date:', date, 'endTime:', endTime);
    setIsRunning(true);
    setIsDone(false);
    setOverallError(null);
    setNeedsUpload(false);
    setSteps([...INITIAL_STEPS]);

    try {
      // Load resource aliases for PMWeb matching
      await loadResourceAliases();

      // ─── STEP 0: Fetch settings + create report ───
      updateStep(0, { status: 'running' });
      let settings: Record<string, unknown> = {};
      try {
        settings = await settingsApi.get() as unknown as Record<string, unknown>;
        console.debug('[AutoCreate] Settings loaded:', {
          project: settings.default_project,
          company: settings.default_company,
          zip: settings.default_zip_code,
        });
      } catch (err) {
        console.warn('[AutoCreate] Settings fetch failed, using defaults:', err);
      }

      // Close any existing report and start fresh
      closeReport();
      const reportDefaults: Partial<GeneralInfo> = {
        project_name: (settings.default_project as string) || '',
        resident_engineer: (settings.default_resident_engineer as string) || '',
        report_date: date,
        start_time: endTime, // Night work — start time might differ, but we'll use settings
        end_time: endTime,
      };

      // Use settings start time if available
      const startTimeSetting = settings.default_start_time as string;
      if (startTimeSetting) {
        // Convert 12h to 24h if needed
        const match12 = startTimeSetting.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (match12) {
          let hrs = parseInt(match12[1]);
          const mins = match12[2];
          const period = match12[3].toUpperCase();
          if (period === 'PM' && hrs !== 12) hrs += 12;
          if (period === 'AM' && hrs === 12) hrs = 0;
          reportDefaults.start_time = `${hrs.toString().padStart(2, '0')}:${mins}`;
        } else {
          reportDefaults.start_time = startTimeSetting;
        }
      }

      newReport(reportDefaults);
      updateStep(0, {
        status: 'success',
        detail: `${formatDateDisplay(date)}`,
      });

      // ─── STEP 1: Fetch weather ───
      updateStep(1, { status: 'running' });
      try {
        const zipCode = (settings.default_zip_code as string) || '92101';
        console.debug('[AutoCreate] Fetching weather for', date, 'ZIP:', zipCode);
        const weather: WeatherData = await weatherApi.fetchByZip(zipCode, date);

        // Apply weather to report
        const weatherUpdates: Partial<GeneralInfo> = {
          temperature_high: weather.temperature_high,
          temperature_low: weather.temperature_low,
          wind_info: weather.wind_info,
        };

        // Auto-select sky condition chip
        if (weather.sky_condition_id) {
          const skyItem = SKY_CONDITIONS.find(s => s.id === weather.sky_condition_id);
          if (skyItem) {
            weatherUpdates.sky_conditions = [skyItem];
          }
        }

        updateGeneral(weatherUpdates);
        bumpRevision();
        updateStep(1, {
          status: 'success',
          detail: `${weather.temperature_high}°F / ${weather.temperature_low}°F — ${weather.condition}`,
        });
      } catch (err) {
        console.warn('[AutoCreate] Weather fetch failed:', err);
        updateStep(1, { status: 'error', detail: 'Weather unavailable — fill manually' });
        // Non-fatal: continue without weather
      }

      // ─── STEP 2: Load dispatch ───
      updateStep(2, { status: 'running' });
      let dispatchData: { date: string; company: string; jobs: DispatchJob[] };
      try {
        console.debug('[AutoCreate] Loading dispatch for date:', date);
        dispatchData = await dispatchApi.getByDate(date);
        console.debug('[AutoCreate] Dispatch loaded:', {
          company: dispatchData.company,
          jobCount: dispatchData.jobs.length,
        });
        updateStep(2, {
          status: 'success',
          detail: `${dispatchData.jobs.length} jobs — ${dispatchData.company}`,
        });
      } catch (err: unknown) {
        const httpErr = err as { response?: { status?: number } };
        if (httpErr?.response?.status === 404) {
          console.warn('[AutoCreate] No dispatch found for date:', date);
          updateStep(2, { status: 'error', detail: 'No dispatch found — upload one below' });
          setNeedsUpload(true);
          setIsRunning(false);
          return; // Stop — need user to upload
        }
        throw err; // Re-throw unexpected errors
      }

      // ─── STEP 3: Match schedule shift ───
      updateStep(3, { status: 'running' });
      let matchedShift: ScheduleShift | null = null;
      let matchedShiftKey = '';
      let detectedScheduleType: 'digout' | 'grind_overlay' = 'digout';
      try {
        console.debug('[AutoCreate] Loading active schedule...');
        const schedule = await scheduleApi.getActive();
        const shifts = schedule.shifts as Record<string, ScheduleShift>;
        const shiftKeys = Object.keys(shifts);
        detectedScheduleType = (schedule.schedule_type as 'digout' | 'grind_overlay') || 'digout';
        console.debug('[AutoCreate] Schedule loaded, type:', detectedScheduleType, 'shifts:', shiftKeys);

        // Match by date string — schedule keys are like "June 18, 2026"
        const formattedDate = formatDateDisplay(date);
        const dateKey = shiftKeys.find(k =>
          k.toLowerCase() === formattedDate.toLowerCase()
        );

        if (dateKey) {
          matchedShift = shifts[dateKey];
          matchedShiftKey = dateKey;
          console.debug('[AutoCreate] Schedule shift matched:', dateKey, {
            rows: matchedShift.rows.length,
            totalSF: matchedShift.total_sf,
            totalTons: matchedShift.total_tons,
          });
          updateStep(3, {
            status: 'success',
            detail: `${dateKey} — ${matchedShift.total_sf.toLocaleString()} SF / ${matchedShift.total_tons.toLocaleString()} Tons`,
          });
        } else {
          console.warn('[AutoCreate] No schedule shift matches date:', formattedDate);
          updateStep(3, { status: 'skipped', detail: 'No matching shift in schedule' });
        }
      } catch (err) {
        console.warn('[AutoCreate] Schedule load failed:', err);
        updateStep(3, { status: 'skipped', detail: 'No schedule uploaded' });
        // Non-fatal: continue without schedule data
      }

      // ─── STEP 4: Build activities from dispatch + schedule ───
      updateStep(4, { status: 'running' });
      const company = (settings.default_company as string) || dispatchData.company || '';

      // Build the activity using shared helper (same logic as DispatchImportDialog)
      // Note: station ranges are empty for auto-create — user can add them manually after
      console.debug('[AutoCreate] Building activity from', dispatchData.jobs.length, 'jobs, company:', company);
      const activity = buildActivity(
        dispatchData.jobs,
        company,
        endTime,
        matchedShift,
        matchedShiftKey,
        detectedScheduleType,
      );

      // Add the activity to the report
      addActivity(activity);

      const totalManpower = activity.manpower.length +
        activity.extra_work_manpower.length +
        activity.consultant_manpower.length;
      const totalEquipment = activity.equipment.length +
        activity.extra_work_equipment.length;

      updateStep(4, {
        status: 'success',
        detail: `${totalManpower} crew, ${totalEquipment} equipment`,
      });
      console.debug('[AutoCreate] Activity built:', {
        workArea: activity.work_area,
        manpower: activity.manpower.length,
        ewManpower: activity.extra_work_manpower.length,
        equipment: activity.equipment.length,
        ewEquipment: activity.extra_work_equipment.length,
      });

      // ─── STEP 5: Generate traffic control activity ───
      updateStep(5, { status: 'running' });
      try {
        // Gather TC crew from all jobs
        const tcCrew: { name: string; time: string }[] = [];
        let subTc: { company: string; details: string; count?: number; time?: string } | null = null;

        for (const job of dispatchData.jobs) {
          for (const tc of (job.traffic_control || [])) {
            tcCrew.push(tc);
          }
          if (job.sub_traffic_control?.company && job.sub_traffic_control.details !== 'N/A') {
            subTc = job.sub_traffic_control;
          }
        }

        // Collect work location info
        const allStreets = new Set<string>();
        const allLocations = new Set<string>();
        for (const job of dispatchData.jobs) {
          (job.streets || []).forEach((s: string) => { if (s && s !== 'N/A') allStreets.add(s); });
          if (job.location && job.location !== 'N/A') allLocations.add(job.location);
        }

        if (tcCrew.length > 0 || subTc) {
          console.debug('[AutoCreate] Generating TC activity:', {
            tcCrewCount: tcCrew.length,
            subTc: subTc?.company,
            streets: [...allStreets],
          });

          const tcResult = await tcApi.generate({
            streets: [...allStreets],
            location: [...allLocations].join(' / '),
            tc_crew: tcCrew,
            sub_tc: subTc,
            work_description: activity.summary.slice(0, 500),
            schedule_shift: matchedShiftKey,
            start_time: dispatchData.jobs[0]?.start_time || '',
            end_time: formatEndTimeDisplay(endTime),
          });

          // Build TC manpower from the TC crew
          const tcManpower: ManpowerRow[] = tcCrew.map(tc => ({
            id: generateId(),
            trade: 'LL-03- Laborers',
            name: tc.name,
            qty: 1,
            hours: 0, // Will be calculated below
            start_time: tc.time || '',
            stop_time: formatEndTimeDisplay(endTime),
            company,
            classification: '',
            is_3rd_party: false,
            is_extra_work: false,
            is_consultant: false,
            locked: false,
          }));

          // Add sub TC if present
          if (subTc) {
            tcManpower.push({
              id: generateId(),
              trade: 'LL-03- Laborers',
              name: `${subTc.company} Flagger`,
              qty: subTc.count || 1,
              hours: 0,
              start_time: subTc.time || dispatchData.jobs[0]?.start_time || '',
              stop_time: formatEndTimeDisplay(endTime),
              company: subTc.company,
              classification: '',
              is_3rd_party: true,
              is_extra_work: false,
              is_consultant: false,
              locked: false,
            });
          }

          const tcActivity: Activity = {
            id: generateId(),
            work_area: tcResult.work_area || 'Traffic Control',
            stations: [...allStreets].join(' / '),
            summary: tcResult.summary,
            manpower: tcManpower,
            equipment: [],
            extra_work_manpower: [],
            extra_work_equipment: [],
            consultant_manpower: [],
          };

          addActivity(tcActivity);
          updateStep(5, {
            status: 'success',
            detail: `TC activity created (${tcCrew.length} crew${subTc ? ` + ${subTc.company}` : ''})`,
          });
        } else {
          console.debug('[AutoCreate] No TC crew found in dispatch — skipping TC activity');
          updateStep(5, { status: 'skipped', detail: 'No TC crew in dispatch' });
        }
      } catch (err) {
        console.warn('[AutoCreate] TC generation failed:', err);
        updateStep(5, { status: 'error', detail: 'TC generation failed — add manually' });
        // Non-fatal: report is still usable without TC
      }

      // ─── DONE ───
      bumpRevision();
      setIsDone(true);
      console.debug('[AutoCreate] Automation complete for date:', date);

    } catch (err) {
      console.error('[AutoCreate] Fatal error:', err);
      setOverallError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setIsRunning(false);
    }
  }, [date, endTime, newReport, updateGeneral, addActivity, closeReport, bumpRevision, updateStep]);

  // ============================================
  // DISPATCH UPLOAD HANDLER (Fallback)
  // ============================================

  const handleDispatchUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !date) return;

    console.debug('[AutoCreate] Uploading dispatch for date:', date, 'file:', file.name);
    setIsUploading(true);
    try {
      await dispatchApi.upload(file, date);
      console.debug('[AutoCreate] Dispatch uploaded successfully, re-running automation...');
      setNeedsUpload(false);
      // Re-run the full automation now that the dispatch is available
      await runAutomation();
    } catch (err) {
      console.error('[AutoCreate] Dispatch upload failed:', err);
      setOverallError('Failed to upload dispatch. Please try again.');
    } finally {
      setIsUploading(false);
    }
  }, [date, runAutomation]);

  // ============================================
  // OPEN REPORT HANDLER
  // ============================================

  const handleOpenReport = useCallback(() => {
    onClose();
    navigate('/report/new');
  }, [navigate, onClose]);

  // ============================================
  // RENDER
  // ============================================

  return (
    <div
      id="auto-create-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 'var(--space-md)',
      }}
    >
      <div
        id="auto-create-dialog"
        className="card"
        style={{
          width: '100%',
          maxWidth: 480,
          maxHeight: '90vh',
          overflow: 'auto',
          position: 'relative',
          animation: 'fadeIn 0.2s ease-out',
        }}
      >
        {/* Header */}
        <div
          className="card-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--color-border)',
            padding: 'var(--space-md) var(--space-lg)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <Zap size={20} style={{ color: 'var(--color-primary)' }} />
            <h2 style={{ margin: 0, fontSize: '1.125rem' }}>Quick Create Report</h2>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={isRunning}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="card-body" style={{ padding: 'var(--space-lg)' }}>
          {/* Date Input */}
          <div style={{ marginBottom: 'var(--space-lg)' }}>
            <label
              htmlFor="auto-create-date"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                marginBottom: 'var(--space-xs)',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
              }}
            >
              <Calendar size={14} />
              Report Date
            </label>
            <input
              id="auto-create-date"
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              disabled={isRunning}
              style={{
                width: '100%',
                padding: 'var(--space-sm) var(--space-md)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border)',
                fontSize: '1rem',
                background: 'var(--color-bg)',
              }}
            />
          </div>

          {/* End Time Input */}
          <div style={{ marginBottom: 'var(--space-lg)' }}>
            <label
              htmlFor="auto-create-end-time"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                marginBottom: 'var(--space-xs)',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
              }}
            >
              <Clock size={14} />
              End Time
            </label>
            <input
              id="auto-create-end-time"
              type="time"
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
              disabled={isRunning}
              style={{
                width: '100%',
                padding: 'var(--space-sm) var(--space-md)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border)',
                fontSize: '1rem',
                background: 'var(--color-bg)',
              }}
            />
            <p style={{
              margin: 'var(--space-xs) 0 0',
              fontSize: '0.75rem',
              color: 'var(--color-text-tertiary)',
            }}>
              When did the crew finish? (Night work default: 5:00 AM)
            </p>
          </div>

          {/* Create Button */}
          {!isRunning && !isDone && (
            <button
              id="auto-create-start-btn"
              className="btn btn-primary"
              onClick={runAutomation}
              disabled={!date}
              style={{
                width: '100%',
                padding: 'var(--space-md)',
                fontSize: '1rem',
                fontWeight: 600,
                marginBottom: 'var(--space-lg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-sm)',
              }}
            >
              <Zap size={18} />
              Create Report
            </button>
          )}

          {/* Overall Error */}
          {overallError && (
            <div style={{
              padding: 'var(--space-md)',
              background: 'var(--color-danger-light)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-danger)',
              fontSize: '0.875rem',
              marginBottom: 'var(--space-md)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-sm)',
            }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              {overallError}
            </div>
          )}

          {/* Progress Steps */}
          {(isRunning || isDone || steps.some(s => s.status !== 'pending')) && (
            <div style={{ marginBottom: 'var(--space-lg)' }}>
              <h3 style={{
                margin: '0 0 var(--space-md)',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>
                Progress
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                {steps.map((step, i) => (
                  <StepRow key={i} step={step} />
                ))}
              </div>
            </div>
          )}

          {/* Dispatch Upload Fallback */}
          {needsUpload && (
            <div style={{
              padding: 'var(--space-md)',
              background: 'var(--color-warning-light)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-md)',
            }}>
              <p style={{
                margin: '0 0 var(--space-sm)',
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--color-warning)',
              }}>
                No dispatch found for {formatDateDisplay(date)}
              </p>
              <p style={{
                margin: '0 0 var(--space-md)',
                fontSize: '0.8125rem',
                color: 'var(--color-text-secondary)',
              }}>
                Upload the dispatch PDF and automation will continue.
              </p>
              <label
                className="btn btn-primary btn-sm"
                style={{
                  cursor: isUploading ? 'wait' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-xs)',
                }}
              >
                {isUploading ? (
                  <><Loader2 size={14} className="spin" /> Uploading &amp; Parsing...</>
                ) : (
                  <><Upload size={14} /> Upload Dispatch PDF</>
                )}
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleDispatchUpload}
                  disabled={isUploading}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          )}

          {/* Done — Open Report */}
          {isDone && (
            <button
              id="auto-create-open-btn"
              className="btn btn-primary"
              onClick={handleOpenReport}
              style={{
                width: '100%',
                padding: 'var(--space-md)',
                fontSize: '1rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-sm)',
              }}
            >
              <FileText size={18} />
              Open Report →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Step Row Component
// ============================================

function StepRow({ step }: { step: StepState }) {
  const iconMap: Record<StepStatus, React.ReactNode> = {
    pending: <div style={{
      width: 18, height: 18, borderRadius: '50%',
      border: '2px solid var(--color-border)',
    }} />,
    running: <Loader2 size={18} className="spin" style={{ color: 'var(--color-primary)' }} />,
    success: <CheckCircle2 size={18} style={{ color: 'var(--color-success)' }} />,
    error: <AlertCircle size={18} style={{ color: 'var(--color-danger)' }} />,
    skipped: <div style={{
      width: 18, height: 18, borderRadius: '50%',
      background: 'var(--color-border)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '10px', color: 'var(--color-text-tertiary)',
    }}>—</div>,
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'var(--space-sm)',
      padding: 'var(--space-xs) 0',
      opacity: step.status === 'pending' ? 0.5 : 1,
      transition: 'opacity 0.2s',
    }}>
      <div style={{ flexShrink: 0, marginTop: 1 }}>
        {iconMap[step.status]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '0.875rem',
          fontWeight: step.status === 'running' ? 600 : 400,
          color: step.status === 'error' ? 'var(--color-danger)' : 'var(--color-text)',
        }}>
          {step.label}
        </div>
        {step.detail && (
          <div style={{
            fontSize: '0.75rem',
            color: step.status === 'error' ? 'var(--color-danger)' : 'var(--color-text-tertiary)',
            marginTop: 2,
          }}>
            {step.detail}
          </div>
        )}
      </div>
    </div>
  );
}
