/**
 * Daily Reporter V3 — Auto-Create Dialog
 *
 * One-click report factory: enter a date + start time → press Create Report
 * → system fetches weather, seeds the header from Settings, and — only when a
 * dispatch PDF exists for that date — loads it, matches the schedule shift and
 * builds activities.
 *
 * Most days there is no dispatch (they only exist for paving work with one
 * particular company), so every dispatch-driven step is optional. Without one
 * you get a report with the header and weather filled in and no activities.
 *
 * Crew hours are deliberately left at 0 until the day is closed out — use the
 * "Set End Time" button on each activity in the report.
 *
 * The dialog shows real-time progress for each step.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReportStore } from '@/stores/reportStore';
import { weatherApi, dispatchApi, scheduleApi } from '@/lib/api';
import { settingsApi } from '@/lib/settingsApi';
import { buildActivity } from '@/lib/dispatchHelpers';
import { loadResourceAliases } from '@/lib/resourceMatcher';
import { SKY_CONDITIONS } from '@/lib/constants';
import type {
  DispatchJob,
  ScheduleShift,
  GeneralInfo,
} from '@/types';
import type { WeatherData } from '@/lib/api';
import {
  Zap, Calendar, FileText,
  Loader2, CheckCircle2, AlertCircle, X, Upload, Clock,
  MapPin, Hash,
} from 'lucide-react';

// ============================================
// Types
// ============================================

type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

/** Where the weather lookup gets its location from */
type LocationMode = 'device' | 'zip';

interface StepState {
  status: StepStatus;
  label: string;
  detail: string;
  /**
   * Kept out of the progress list entirely.
   *
   * WHY: dispatches only exist for paving work with one company, so nine days
   * in ten have none. Showing "Load dispatch — none for this date", "Match
   * schedule — needs a dispatch" and "Build activities — skipped" makes the
   * ordinary, correct outcome look like three failures and reads as though the
   * app is asking for a file that does not exist. When there is no dispatch
   * these steps are not skipped work, they are not part of the job.
   */
  hidden?: boolean;
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
  // Hidden until a dispatch is actually found. A paving day reveals all three;
  // every other day never sees them.
  { status: 'pending', label: 'Load dispatch', detail: '', hidden: true },
  { status: 'pending', label: 'Match schedule', detail: '', hidden: true },
  { status: 'pending', label: 'Build activities', detail: '', hidden: true },
];

/** Browser geolocation — resolves to coordinates or rejects. */
function getDeviceCoords(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This device does not support location services'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(new Error(err.message || 'Could not get device location')),
      { timeout: 10_000, maximumAge: 300_000 },
    );
  });
}

/** Convert a "7:00 AM" settings value into the "07:00" a time input expects. */
function to24Hour(value: string): string {
  if (!value?.trim()) return '';
  const match12 = value.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12) {
    let hrs = parseInt(match12[1]);
    const period = match12[3].toUpperCase();
    if (period === 'PM' && hrs !== 12) hrs += 12;
    if (period === 'AM' && hrs === 12) hrs = 0;
    return `${hrs.toString().padStart(2, '0')}:${match12[2]}`;
  }
  const match24 = value.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) return `${match24[1].padStart(2, '0')}:${match24[2]}`;
  return '';
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
  const [startTime, setStartTime] = useState('');
  const [locationMode, setLocationMode] = useState<LocationMode>('device');
  const [zipInput, setZipInput] = useState('');
  const [defaultZip, setDefaultZip] = useState('');

  // --- Progress state ---
  const [isRunning, setIsRunning] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([...INITIAL_STEPS]);
  const [overallError, setOverallError] = useState<string | null>(null);

  // --- Optional dispatch upload ---
  const [canUploadDispatch, setCanUploadDispatch] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // ── Seed the form from settings ──
  useEffect(() => {
    settingsApi.get()
      .then(s => {
        const seeded = to24Hour(s.default_start_time || '');
        if (seeded) setStartTime(seeded);
        setDefaultZip(s.default_zip_code || '');
        console.debug('[AutoCreate] Form seeded from settings — start:', seeded, 'zip:', s.default_zip_code);
      })
      .catch(err => console.warn('[AutoCreate] Could not seed form from settings:', err));
  }, []);

  // ── Step updater ──
  const updateStep = useCallback((index: number, updates: Partial<StepState>) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, ...updates } : s));
  }, []);

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

    console.debug('[AutoCreate] Starting automation for date:', date, 'startTime:', startTime);
    setIsRunning(true);
    setIsDone(false);
    setOverallError(null);
    setCanUploadDispatch(false);
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

      // Close any existing report and start fresh. Header fields come from
      // Settings where they've been filled in, and stay blank where they haven't.
      closeReport();
      const reportDefaults: Partial<GeneralInfo> = {
        project_name: (settings.default_project as string) || '',
        project_number: (settings.default_project_number as string) || '',
        project_location: (settings.default_project_location as string) || '',
        inspector_name: (settings.default_inspector_name as string) || '',
        resident_engineer: (settings.default_resident_engineer as string) || '',
        report_date: date,
        start_time: startTime,
        // Filled in later by "Set End Time" on each activity
        end_time: '',
      };

      newReport(reportDefaults);
      updateStep(0, {
        status: 'success',
        detail: `${formatDateDisplay(date)}`,
      });

      // ─── STEP 1: Fetch weather ───
      updateStep(1, { status: 'running' });
      try {
        const settingsZip = (settings.default_zip_code as string) || '';
        let weather: WeatherData;
        let sourceLabel: string;

        if (locationMode === 'device') {
          // Device location chosen — send the device's current position.
          // If it's refused or unavailable, fall back to the Settings ZIP.
          try {
            const { lat, lon } = await getDeviceCoords();
            console.debug('[AutoCreate] Device location:', lat, lon);
            weather = await weatherApi.fetchByCoords(lat, lon, date);
            sourceLabel = 'device location';
          } catch (locErr) {
            console.warn('[AutoCreate] Device location unavailable:', locErr);
            if (!settingsZip) {
              throw new Error(
                'Device location unavailable and no default ZIP set in Settings',
                { cause: locErr },
              );
            }
            weather = await weatherApi.fetchByZip(settingsZip, date);
            sourceLabel = `ZIP ${settingsZip} (Settings fallback)`;
          }
        } else {
          // ZIP chosen — use what was typed, or the Settings default if blank.
          const zip = zipInput.trim() || settingsZip;
          if (!zip) {
            throw new Error('Enter a ZIP code, or set a default ZIP in Settings');
          }
          console.debug('[AutoCreate] Fetching weather for ZIP:', zip);
          weather = await weatherApi.fetchByZip(zip, date);
          sourceLabel = `ZIP ${zip}${zipInput.trim() ? '' : ' (Settings default)'}`;
        }

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
          detail: `${weather.temperature_high}°F / ${weather.temperature_low}°F — ${weather.condition} (${sourceLabel})`,
        });
      } catch (err) {
        console.warn('[AutoCreate] Weather fetch failed:', err);
        const msg = err instanceof Error ? err.message : 'Weather unavailable';
        updateStep(1, { status: 'error', detail: `${msg} — fill manually` });
        // Non-fatal: continue without weather
      }

      // ─── STEP 2: Load dispatch (optional) ───
      // Dispatches only exist for paving work with one particular company, so
      // most days there won't be one. Never block on it.
      // Looked up silently. The step only joins the list if one turns up, so a
      // day without a dispatch never advertises the absence.
      let dispatchData: { date: string; company: string; jobs: DispatchJob[] } | null = null;
      try {
        console.debug('[AutoCreate] Looking for dispatch for date:', date);
        dispatchData = await dispatchApi.getByDate(date);
        console.debug('[AutoCreate] Dispatch loaded:', {
          company: dispatchData?.company,
          jobCount: dispatchData?.jobs.length,
        });
        updateStep(2, {
          status: 'success',
          hidden: false,
          detail: `${dispatchData?.jobs.length} jobs — ${dispatchData?.company}`,
        });
      } catch (err: unknown) {
        const httpErr = err as { response?: { status?: number; data?: { detail?: string } } };
        const status = httpErr?.response?.status;
        if (status === 404) {
          console.debug('[AutoCreate] No dispatch for date:', date, '— continuing without one');
          // Not a skipped step — there was nothing to do. Stays hidden.
        } else {
          // A dispatch file existed but couldn't be parsed, or the server
          // errored. Report it and carry on — the report is still usable.
          const detail = httpErr?.response?.data?.detail
            || (err instanceof Error ? err.message : 'Dispatch could not be loaded');
          // A dispatch existed but could not be read — that IS worth showing,
          // because something was there and did not work.
          console.warn('[AutoCreate] Dispatch load failed:', detail);
          updateStep(2, { status: 'error', hidden: false, detail });
        }
        setCanUploadDispatch(true);
      }

      if (dispatchData) {
        // A dispatch turned up, so the work it drives becomes visible.
        updateStep(3, { hidden: false });
        updateStep(4, { hidden: false });

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
            console.debug('[AutoCreate] No schedule shift matches date:', formattedDate);
            updateStep(3, { status: 'skipped', detail: 'No matching shift in schedule' });
          }
        } catch (err) {
          console.debug('[AutoCreate] Schedule unavailable:', err);
          updateStep(3, { status: 'skipped', detail: 'No schedule uploaded' });
          // Non-fatal: continue without schedule data
        }

        // ─── STEP 4: Build activities from dispatch + schedule ───
        updateStep(4, { status: 'running' });
        try {
          const company = (settings.default_company as string) || dispatchData.company || '';

          // Station ranges are empty for auto-create — add them manually after.
          // The end time is empty on purpose: hours stay 0 until the day is
          // closed out with "Set End Time" on the activity.
          console.debug('[AutoCreate] Building activity from', dispatchData.jobs.length, 'jobs, company:', company);
          const activity = buildActivity(
            dispatchData.jobs,
            company,
            '',
            matchedShift,
            matchedShiftKey,
            detectedScheduleType,
          );

          addActivity(activity);

          const totalManpower = activity.manpower.length +
            activity.extra_work_manpower.length +
            activity.consultant_manpower.length;
          const totalEquipment = activity.equipment.length +
            activity.extra_work_equipment.length;

          updateStep(4, {
            status: 'success',
            detail: `${totalManpower} crew, ${totalEquipment} equipment — hours set when you close out`,
          });
          console.debug('[AutoCreate] Activity built:', {
            workArea: activity.work_area,
            manpower: activity.manpower.length,
            ewManpower: activity.extra_work_manpower.length,
            equipment: activity.equipment.length,
            ewEquipment: activity.extra_work_equipment.length,
          });
        } catch (err) {
          console.error('[AutoCreate] Activity build failed:', err);
          updateStep(4, { status: 'error', detail: 'Could not build activities — add them manually' });
        }
      } else {
        // No dispatch, which is the ordinary case. Nothing was skipped and
        // nothing is missing — these steps simply do not apply today, so they
        // stay out of the list rather than reporting themselves as gaps.
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
  }, [
    date, startTime, locationMode, zipInput,
    newReport, updateGeneral, addActivity, closeReport, bumpRevision, updateStep,
  ]);

  // ============================================
  // DISPATCH UPLOAD HANDLER (Optional)
  // ============================================

  const handleDispatchUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !date) return;

    console.debug('[AutoCreate] Uploading dispatch for date:', date, 'file:', file.name);
    setIsUploading(true);
    try {
      await dispatchApi.upload(file, date);
      console.debug('[AutoCreate] Dispatch uploaded successfully, re-running automation...');
      setCanUploadDispatch(false);
      // Re-run the full automation now that the dispatch is available
      await runAutomation();
    } catch (err) {
      console.error('[AutoCreate] Dispatch upload failed:', err);
      setOverallError('Failed to upload dispatch. Please try again.');
    } finally {
      setIsUploading(false);
      if (e.target) e.target.value = '';
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

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: 'var(--space-sm) var(--space-md)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border)',
    fontSize: '1rem',
    background: 'var(--color-bg)',
  };

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-xs)',
    marginBottom: 'var(--space-xs)',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
  };

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
            <label htmlFor="auto-create-date" style={labelStyle}>
              <Calendar size={14} />
              Report Date
            </label>
            <input
              id="auto-create-date"
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              disabled={isRunning}
              style={fieldStyle}
            />
          </div>

          {/* Start Time Input */}
          <div style={{ marginBottom: 'var(--space-lg)' }}>
            <label htmlFor="auto-create-start-time" style={labelStyle}>
              <Clock size={14} />
              Start Time
            </label>
            <input
              id="auto-create-start-time"
              type="time"
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
              disabled={isRunning}
              style={fieldStyle}
            />
            <p style={{
              margin: 'var(--space-xs) 0 0',
              fontSize: '0.75rem',
              color: 'var(--color-text-tertiary)',
            }}>
              When did the crew start? Set the end time from the report when the
              day is done — that's what fills in hours.
            </p>
          </div>

          {/* Weather Location */}
          <div style={{ marginBottom: 'var(--space-lg)' }}>
            <label style={labelStyle}>
              <MapPin size={14} />
              Weather Location
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
              {([
                { mode: 'device' as LocationMode, label: 'Current location' },
                { mode: 'zip' as LocationMode, label: 'Enter ZIP' },
              ]).map(({ mode, label }) => (
                <button
                  key={mode}
                  type="button"
                  id={`auto-create-location-${mode}`}
                  onClick={() => setLocationMode(mode)}
                  disabled={isRunning}
                  className={locationMode === mode ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
                  style={{ flex: 1, fontSize: '0.8125rem' }}
                >
                  {label}
                </button>
              ))}
            </div>
            {locationMode === 'zip' && (
              <input
                id="auto-create-zip"
                type="text"
                inputMode="numeric"
                value={zipInput}
                onChange={e => setZipInput(e.target.value)}
                disabled={isRunning}
                placeholder={defaultZip ? `${defaultZip} (Settings default)` : 'e.g. 92101'}
                style={fieldStyle}
              />
            )}
            <p style={{
              margin: 'var(--space-xs) 0 0',
              fontSize: '0.75rem',
              color: 'var(--color-text-tertiary)',
            }}>
              {locationMode === 'device'
                ? defaultZip
                  ? `Uses this device's location. Falls back to ZIP ${defaultZip} from Settings.`
                  : "Uses this device's location."
                : defaultZip
                  ? `Leave blank to use ZIP ${defaultZip} from Settings.`
                  : 'No default ZIP is set in Settings, so enter one here.'}
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
                {steps.filter(s => !s.hidden).map((step) => (
                  <StepRow key={step.label} step={step} />
                ))}
              </div>
            </div>
          )}

          {/* Optional Dispatch Upload — offered, never required */}
          {canUploadDispatch && (
            <div style={{
              padding: 'var(--space-md)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-md)',
            }}>
              <p style={{
                margin: '0 0 var(--space-xs)',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}>
                <Hash size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                Paving day?
              </p>
              <p style={{
                margin: '0 0 var(--space-md)',
                fontSize: '0.8125rem',
                color: 'var(--color-text-secondary)',
              }}>
                Only if there's a dispatch for {formatDateDisplay(date)} — upload it
                and the crew and equipment get filled in automatically. Otherwise
                just open the report and add the work yourself.
              </p>
              <label
                className="btn btn-outline btn-sm"
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
