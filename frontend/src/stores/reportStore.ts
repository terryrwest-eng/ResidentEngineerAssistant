/**
 * Daily Reporter V3 — Report Store (Zustand)
 *
 * Manages report state with Word/Excel-style save behavior:
 * - New reports: NO auto-save until first explicit Save
 * - After first save: auto-save on every change (debounced)
 * - Version history: each save creates a snapshot
 * - Navigation guard: warns if unsaved changes
 */

import { create } from 'zustand';
import { reportApi } from '@/lib/api';
import type { Report, Activity, GeneralInfo } from '@/types';

// --- Constants ---
const AUTO_SAVE_DELAY_MS = 2000;
const EMPTY_GENERAL: GeneralInfo = {
  project_name: '',
  project_number: '',
  project_location: '',
  inspector_name: '',
  resident_engineer: '',
  report_date: new Date().toISOString().split('T')[0], // Today's date
  start_time: '07:00',
  end_time: '15:30',
  sky_conditions: [],
  temperature_high: '',
  temperature_low: '',
  wind_info: '',
  notes: '',
};

interface ReportStoreState {
  // --- Report Data ---
  report: Report | null;

  // --- Save State (Word/Excel model) ---
  /** Has the report ever been saved to disk? */
  isSaved: boolean;
  /** Has the report been modified since the last save? */
  isDirty: boolean;
  /** Is a save operation in progress? */
  isSaving: boolean;
  /** Last save timestamp */
  lastSavedAt: string | null;
  /** Error from last save attempt */
  saveError: string | null;

  // --- Loading State ---
  isLoading: boolean;
  loadError: string | null;

  // --- Auto-save timer ---
  _autoSaveTimer: ReturnType<typeof setTimeout> | null;

  // --- Actions ---
  /** Create a new blank report (NOT saved to disk) */
  newReport: (defaults?: Partial<GeneralInfo>) => void;
  /** Load an existing report from the server */
  loadReport: (id: string) => Promise<void>;
  /** Update the general info section */
  updateGeneral: (updates: Partial<GeneralInfo>) => void;
  /** Add a new activity */
  addActivity: (activity: Activity) => void;
  /** Update an existing activity */
  updateActivity: (activityId: string, updates: Partial<Activity>) => void;
  /** Remove an activity */
  removeActivity: (activityId: string) => void;
  /** Reorder activities */
  reorderActivities: (fromIndex: number, toIndex: number) => void;
  /** Replace all activities (from AI Co-Pilot) */
  replaceActivities: (activities: Activity[]) => void;
  /** First-time save (creates the report file) */
  saveReport: () => Promise<string | null>;
  /** Save As (creates a copy with a new ID) */
  saveReportAs: () => Promise<string | null>;
  /** Mark report as submitted */
  submitReport: () => Promise<void>;
  /** Clear the current report from memory */
  closeReport: () => void;
  /** Check if it's safe to navigate away */
  canNavigateAway: () => boolean;
  /** Internal auto-save scheduler */
  _scheduleAutoSave: () => void;
}

export const useReportStore = create<ReportStoreState>((set, get) => ({
  // --- Initial State ---
  report: null,
  isSaved: false,
  isDirty: false,
  isSaving: false,
  lastSavedAt: null,
  saveError: null,
  isLoading: false,
  loadError: null,
  _autoSaveTimer: null,

  // --- Actions ---

  newReport: (defaults) => {
    // Clear any existing auto-save timer
    const timer = get()._autoSaveTimer;
    if (timer) clearTimeout(timer);

    const now = new Date().toISOString();
    const general: GeneralInfo = { ...EMPTY_GENERAL, ...defaults };

    set({
      report: {
        id: '', // No ID yet — not saved
        general,
        activities: [],
        photos: [],
        status: 'draft',
        created_at: now,
        updated_at: now,
      },
      isSaved: false,
      isDirty: false,
      isSaving: false,
      lastSavedAt: null,
      saveError: null,
      isLoading: false,
      loadError: null,
      _autoSaveTimer: null,
    });

    console.debug('[ReportStore] New blank report created (not saved to disk)');
  },

  loadReport: async (id) => {
    set({ isLoading: true, loadError: null });
    try {
      const data = await reportApi.get(id);
      set({
        report: data,
        isSaved: true,      // It exists on disk
        isDirty: false,      // Just loaded — no changes yet
        isLoading: false,
        lastSavedAt: data.updated_at,
      });
      console.debug(`[ReportStore] Loaded report ${id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load report';
      set({ isLoading: false, loadError: msg });
      console.error(`[ReportStore] Failed to load report ${id}:`, err);
    }
  },

  updateGeneral: (updates) => {
    const { report } = get();
    if (!report) return;

    set({
      report: {
        ...report,
        general: { ...report.general, ...updates },
        updated_at: new Date().toISOString(),
      },
      isDirty: true,
      saveError: null,
    });

    // Schedule auto-save if report has been saved before
    get()._scheduleAutoSave();
  },

  addActivity: (activity) => {
    const { report } = get();
    if (!report) return;

    set({
      report: {
        ...report,
        activities: [...report.activities, activity],
        updated_at: new Date().toISOString(),
      },
      isDirty: true,
    });

    get()._scheduleAutoSave();
  },

  updateActivity: (activityId, updates) => {
    const { report } = get();
    if (!report) return;

    set({
      report: {
        ...report,
        activities: report.activities.map((act) =>
          act.id === activityId ? { ...act, ...updates } : act
        ),
        updated_at: new Date().toISOString(),
      },
      isDirty: true,
    });

    get()._scheduleAutoSave();
  },

  removeActivity: (activityId) => {
    const { report } = get();
    if (!report) return;

    set({
      report: {
        ...report,
        activities: report.activities.filter((act) => act.id !== activityId),
        updated_at: new Date().toISOString(),
      },
      isDirty: true,
    });

    get()._scheduleAutoSave();
  },

  reorderActivities: (fromIndex, toIndex) => {
    const { report } = get();
    if (!report) return;

    const activities = [...report.activities];
    const [moved] = activities.splice(fromIndex, 1);
    activities.splice(toIndex, 0, moved);

    set({
      report: { ...report, activities, updated_at: new Date().toISOString() },
      isDirty: true,
    });

    get()._scheduleAutoSave();
  },

  replaceActivities: (activities) => {
    const { report } = get();
    if (!report) return;

    set({
      report: { ...report, activities, updated_at: new Date().toISOString() },
      isDirty: true,
    });

    get()._scheduleAutoSave();
  },

  saveReport: async () => {
    const { report, isSaved } = get();
    if (!report) return null;

    set({ isSaving: true, saveError: null });

    try {
      let savedId: string;

      if (isSaved && report.id) {
        // Update existing report
        const result = await reportApi.update(report.id, report as unknown as Record<string, unknown>);
        savedId = result.id;
        console.debug(`[ReportStore] Updated report ${savedId}`);
      } else {
        // First save — create new report
        const result = await reportApi.create(report as unknown as Record<string, unknown>);
        savedId = result.id;
        console.debug(`[ReportStore] Created report ${savedId}`);
      }

      const now = new Date().toISOString();
      set({
        report: { ...report, id: savedId, updated_at: now },
        isSaved: true,
        isDirty: false,
        isSaving: false,
        lastSavedAt: now,
      });

      return savedId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save report';
      set({ isSaving: false, saveError: msg });
      console.error('[ReportStore] Save failed:', err);
      return null;
    }
  },

  saveReportAs: async () => {
    const { report } = get();
    if (!report) return null;

    // Create a copy with no ID (forces a new file)
    const copy = { ...report, id: '' };
    set({ report: copy, isSaved: false });

    return get().saveReport();
  },

  submitReport: async () => {
    const { report, saveReport } = get();
    if (!report) return;

    // Save first if dirty
    if (get().isDirty || !get().isSaved) {
      await saveReport();
    }

    // Then mark as submitted
    set({
      report: { ...get().report!, status: 'submitted' },
      isDirty: true,
    });

    await saveReport();
  },

  closeReport: () => {
    const timer = get()._autoSaveTimer;
    if (timer) clearTimeout(timer);

    set({
      report: null,
      isSaved: false,
      isDirty: false,
      isSaving: false,
      lastSavedAt: null,
      saveError: null,
      _autoSaveTimer: null,
    });

    console.debug('[ReportStore] Report closed');
  },

  canNavigateAway: () => {
    const { isDirty, isSaved } = get();

    // If no changes, safe to leave
    if (!isDirty) return true;

    // If report has never been saved AND has changes → NOT safe
    if (!isSaved && isDirty) return false;

    // If report is saved but has pending changes → auto-save will handle it,
    // but we should still warn
    return false;
  },

  // --- Internal: Auto-save scheduler ---
  _scheduleAutoSave: () => {
    const { isSaved, _autoSaveTimer } = get();

    // Only auto-save if the report has been saved at least once
    if (!isSaved) return;

    // Clear existing timer
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);

    // Schedule new save
    const timer = setTimeout(async () => {
      console.debug('[ReportStore] Auto-saving...');
      await get().saveReport();
    }, AUTO_SAVE_DELAY_MS);

    set({ _autoSaveTimer: timer });
  },
}));
