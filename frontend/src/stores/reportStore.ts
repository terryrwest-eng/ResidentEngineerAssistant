/**
 * Daily Reporter V3 — Report Store (Zustand)
 *
 * Manages report state and persistence:
 * - Auto-save from the first edit — a new report is written as soon as it has
 *   anything in it, then re-saved on every change (debounced by 2s)
 * - A create NEVER overwrites: if a report already exists for the same date and
 *   project the server returns 409 having written nothing, auto-save stops, and
 *   the user is asked whether to open that report or keep both
 * - Single-flight: only one save request runs at a time; edits made during a
 *   save are flushed immediately after it returns
 * - Navigation guard: warns if unsaved changes
 */

import { create } from 'zustand';
import { reportApi } from '@/lib/api';
import { getToken } from '@/lib/authClient';
import { cleanSummaryBullets, localDateString } from '@/lib/formatters';
import type { Report, Activity, GeneralInfo } from '@/types';

// --- Constants ---
const AUTO_SAVE_DELAY_MS = 2000;

/**
 * Built fresh on each call — NOT a module constant.
 * A module-level object would capture the date at import time, so an app left
 * open overnight would keep stamping yesterday onto new reports.
 */
const emptyGeneral = (): GeneralInfo => ({
  project_name: '',
  project_number: '',
  project_location: '',
  inspector_name: '',
  resident_engineer: '',
  report_date: localDateString(), // today, local timezone
  start_time: '07:00',
  end_time: '15:30',
  sky_conditions: [],
  temperature_high: '',
  temperature_low: '',
  wind_info: '',
  notes: '',
});

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
  /** Edits landed while a save was in flight — save again once it finishes. */
  _pendingSave: boolean;

  /**
   * Set when the server refused to create this report because one already
   * exists for its date and project. Auto-save stops while this is set and the
   * report stays in memory, untouched and unsaved, until the user answers the
   * warning. Nothing on the server has been modified.
   */
  duplicateConflict: {
    existingId: string;
    reportDate: string;
    projectName: string;
  } | null;

  /** Revision counter — incremented when AI applies changes. Used as React key to force remount. */
  revision: number;

  // --- Actions ---
  /** Create a new blank report (NOT saved to disk) */
  newReport: (defaults?: Partial<GeneralInfo>) => void;
  /** Load an existing report from the server */
  loadReport: (id: string) => Promise<void>;
  /** Update the general info section */
  /** Store the guided interview answers on the report. */
  setInterview: (interview: unknown) => void;
  /** Store the weather captured when the report was opened. */
  setWeather: (weather: { summary: string; raw?: unknown }) => void;
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
  /** Bump revision counter to force remount of defaultValue components (AI use only) */
  bumpRevision: () => void;
  /**
   * Save the report. Creates it on first call, updates it after.
   * Pass allowDuplicate to force a second report on a date that already has
   * one — only Save As should ever need this.
   */
  saveReport: (options?: { allowDuplicate?: boolean }) => Promise<string | null>;
  /** Save As (creates a copy with a new ID) */
  saveReportAs: () => Promise<string | null>;
  /** Answer the duplicate warning by opening the report that already exists. */
  openConflictingReport: () => Promise<void>;
  /** Answer the duplicate warning by deliberately keeping both reports. */
  keepBothReports: () => Promise<string | null>;
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
  _pendingSave: false,
  duplicateConflict: null,
  revision: 0,

  // --- Actions ---

  newReport: (defaults) => {
    // Clear any existing auto-save timer
    const timer = get()._autoSaveTimer;
    if (timer) clearTimeout(timer);

    const now = new Date().toISOString();
    const general: GeneralInfo = { ...emptyGeneral(), ...defaults };

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
      _pendingSave: false,
      duplicateConflict: null,
    });

    console.debug('[ReportStore] New blank report created — auto-saves on first edit');
  },

  loadReport: async (id) => {
    set({ isLoading: true, loadError: null });
    try {
      const data = await reportApi.get(id);
      const cleanedData: Report = {
        ...data,
        activities: (data.activities || []).map((act: Activity) => ({
          ...act,
          summary: cleanSummaryBullets(act.summary || (act as unknown as { summary_html?: string }).summary_html),
        })),
      };
      set({
        report: cleanedData,
        duplicateConflict: null,
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

  setWeather: (weather) => {
    const { report } = get();
    if (!report) return;
    set({
      report: { ...report, weather, updated_at: new Date().toISOString() } as typeof report,
      isDirty: true,
      saveError: null,
    });
    get()._scheduleAutoSave();
  },

  setInterview: (interview) => {
    const { report } = get();
    if (!report) return;

    // Same dirty + auto-save path as every other edit. The interview is filled
    // in on a phone in the field, so an answer that only lives in component
    // state until some later action is an answer waiting to be lost.
    set({
      report: {
        ...report,
        interview,
        updated_at: new Date().toISOString(),
      } as typeof report,
      isDirty: true,
      saveError: null,
    });

    // Written NOW, not on the 2-second debounce.
    //
    // An interview answer is spoken once and is expensive to reproduce - the
    // inspector has moved on by the time they find out it did not stick. Two
    // ways they were being lost: the tab closing inside the debounce window,
    // and _scheduleAutoSave refusing to run at all while a duplicate-date
    // conflict is unresolved, which held a whole interview in memory and then
    // dropped it.
    //
    // saveReport is single-flight, so answering quickly folds into one request
    // rather than queueing one per answer.
    const { report: current, duplicateConflict } = get();
    if (current?.id && !duplicateConflict) {
      get().saveReport().catch((err) => {
        console.error('[ReportStore] Could not save interview answers:', err);
      });
    } else {
      get()._scheduleAutoSave();
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

    const cleanedActivity: Activity = {
      ...activity,
      summary: cleanSummaryBullets(activity.summary || (activity as unknown as { summary_html?: string }).summary_html),
    };

    set({
      report: {
        ...report,
        activities: [...report.activities, cleanedActivity],
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
        activities: report.activities.map((act) => {
          if (act.id !== activityId) return act;
          const rawSummary = updates.summary ?? (updates as unknown as { summary_html?: string }).summary_html;
          const updatedSummary = rawSummary !== undefined
            ? (/<[a-z][\s\S]*>/i.test(rawSummary) ? cleanSummaryBullets(rawSummary) : rawSummary)
            : act.summary;
          return { ...act, ...updates, summary: updatedSummary };
        }),
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

    const cleanedActivities = (activities || []).map((act) => ({
      ...act,
      summary: cleanSummaryBullets(act.summary || (act as unknown as { summary_html?: string }).summary_html),
    }));

    set({
      report: { ...report, activities: cleanedActivities, updated_at: new Date().toISOString() },
      isDirty: true,
    });

    get()._scheduleAutoSave();
  },

  bumpRevision: () => {
    const { revision } = get();
    set({ revision: revision + 1 });
    console.debug('[ReportStore] Revision bumped to', revision + 1);
  },

  saveReport: async (options) => {
    const { report, isSaved, isSaving } = get();
    if (!report) return null;

    // Single-flight. Two saves running at once on a report that has no ID yet
    // would both POST, mint two IDs, and leave duplicate reports for the same
    // day. Fold this call into the one already running instead.
    if (isSaving) {
      console.debug('[ReportStore] Save already in flight — queuing another');
      set({ _pendingSave: true });
      return null;
    }

    // What we are about to send. Kept so we can tell afterwards whether the
    // user changed anything while the request was in flight.
    const sent = report;

    set({ isSaving: true, saveError: null, _pendingSave: false });

    try {
      let savedId: string;

      if (isSaved && report.id) {
        // Update existing report
        const result = await reportApi.update(report.id, report as unknown as Record<string, unknown>);
        savedId = result.id;
        console.debug(`[ReportStore] Updated report ${savedId}`);
      } else {
        // First save. The server collapses this onto an existing report for the
        // same date + project unless we explicitly ask for a duplicate.
        const payload = {
          ...(report as unknown as Record<string, unknown>),
          ...(options?.allowDuplicate ? { allow_duplicate: true } : {}),
        };
        const result = await reportApi.create(payload);
        savedId = result.id;
        console.debug(
          `[ReportStore] Created report ${savedId}`,
          result.reused_existing ? '(adopted the existing report for this date)' : '',
        );
      }

      // Re-read from the store rather than reusing the captured `report`: the
      // user keeps typing while the request is in flight, and writing the stale
      // snapshot back would silently discard whatever they entered meanwhile.
      const current = get().report;
      if (!current) {
        // Report was closed mid-save — nothing left to update
        set({ isSaving: false, _pendingSave: false });
        return savedId;
      }

      const now = new Date().toISOString();
      const stillPending = get()._pendingSave;

      // ── DATA LOSS FIX ────────────────────────────────────────────────────
      // Two independent ways an in-flight edit can be lost, so we check both.
      //
      // `stillPending` catches another saveReport() call folded into this one
      // by the single-flight guard above.
      //
      // `changedDuringSave` catches the quieter case: the user typed while the
      // request was in flight but the auto-save timer had not fired yet, so no
      // second save was ever attempted. Marking the report clean there means
      // closing the app before the next timer drops the edit. Every update
      // action replaces the report object immutably, so an identity check
      // reliably detects it.
      const changedDuringSave = current !== sent;

      set({
        report: { ...current, id: savedId, updated_at: current.updated_at || now },
        isSaved: true,
        // Keep it dirty if newer edits exist, so they are not silently dropped.
        isDirty: stillPending || changedDuringSave,
        isSaving: false,
        lastSavedAt: now,
      });

      // Another save was folded into this one — flush it now.
      if (stillPending) {
        set({ _pendingSave: false });
        return await get().saveReport(options);
      }

      // Edits landed mid-flight but no second save was ever attempted, so
      // nothing is queued to carry them to disk. Re-arm the timer.
      if (changedDuringSave) {
        console.debug('[ReportStore] Edits arrived during save — rescheduling');
        get()._scheduleAutoSave();
      }

      return savedId;
    } catch (err) {
      // 409 = a report already exists for this date + project. The server wrote
      // nothing. Stop auto-saving and hold everything in memory until the user
      // answers the warning — never overwrite, never discard.
      const httpErr = err as {
        response?: { status?: number; data?: { detail?: Record<string, string> } };
      };
      if (httpErr?.response?.status === 409) {
        const detail = httpErr.response?.data?.detail || {};
        console.warn('[ReportStore] A report already exists for this date — asking the user');
        set({
          isSaving: false,
          _pendingSave: false,
          isDirty: true,
          duplicateConflict: {
            existingId: detail.existing_id || '',
            reportDate: detail.report_date || '',
            projectName: detail.project_name || '',
          },
        });
        return null;
      }

      const msg = err instanceof Error ? err.message : 'Failed to save report';
      set({ isSaving: false, saveError: msg, _pendingSave: false });
      console.error('[ReportStore] Save failed:', err);
      return null;
    }
  },

  openConflictingReport: async () => {
    const conflict = get().duplicateConflict;
    if (!conflict?.existingId) return;

    // Discards only what was entered into this unsaved report — the report on
    // the server is opened untouched.
    const timer = get()._autoSaveTimer;
    if (timer) clearTimeout(timer);

    set({ duplicateConflict: null, _autoSaveTimer: null, _pendingSave: false });
    await get().loadReport(conflict.existingId);
    console.debug('[ReportStore] Opened the existing report', conflict.existingId);
  },

  keepBothReports: async () => {
    if (!get().duplicateConflict) return null;
    set({ duplicateConflict: null });
    return get().saveReport({ allowDuplicate: true });
  },

  saveReportAs: async () => {
    const { report } = get();
    if (!report) return null;

    // Create a copy with no ID (forces a new file). allowDuplicate is required
    // here — otherwise the server would fold the copy back onto the original,
    // since it has the same date and project.
    const copy = { ...report, id: '' };
    set({ report: copy, isSaved: false });

    return get().saveReport({ allowDuplicate: true });
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

    // --- Desktop App: Auto-save Word file to local work folder ---
    // window.pywebview.api is ONLY available when running inside the
    // native desktop app (PyWebView). On web browsers and mobile,
    // window.pywebview is undefined and this block is safely skipped.
    // This block runs AFTER the report is fully saved to the cloud,
    // so even if this fails, the report data is safe.
    try {
      const pywebview = (window as unknown as Record<string, unknown>).pywebview as
        | { api: { auto_save_word: (id: string, date: string, token: string) => Promise<{ success: boolean; path?: string; error?: string; skipped?: boolean }> } }
        | undefined;
      const currentReport = get().report;
      const reportDate = currentReport?.general?.report_date || 'unknown';

      if (pywebview?.api?.auto_save_word) {
        if (currentReport?.id) {
          // The desktop shell downloads the .docx over its own HTTP client,
          // which has no session of its own. Reports are per-user now, so it
          // needs this page's token to be told which report it may fetch.
          const result = await pywebview.api.auto_save_word(
            currentReport.id, reportDate, getToken() || '',
          );
          if (result?.skipped) {
            console.info('[Desktop] Word already saved for this report — no duplicate created');
          } else if (result?.success) {
            console.info('[Desktop] Word auto-saved to:', result.path);
          } else {
            console.warn('[Desktop] Word auto-save failed:', result?.error);
          }
        }
      } else if (currentReport?.id) {
        // WEB AND MOBILE — the copy step used to live ONLY inside the
        // pywebview branch above, so on the web app (which is how this is
        // actually used most of the time) submitting produced no copy at all.
        // A browser cannot write to a work folder, so the equivalent is to
        // hand the file to the user's downloads.
        await reportApi.downloadWord(
          currentReport.id,
          `DailyReport_${reportDate}.docx`,
        );
        console.info('[Submit] Word copy downloaded for', reportDate);
      }
    } catch (err) {
      // Silent catch — must NEVER break the submit flow.
      // The report is already saved at this point, so a failed copy is an
      // inconvenience, not data loss.
      console.warn('[Submit] Word copy failed (non-fatal):', err);
    }
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
      _pendingSave: false,
      duplicateConflict: null,
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
    const { _autoSaveTimer, duplicateConflict } = get();

    // A report already exists for this date and the user has not said what to
    // do about it. Retrying would just 409 forever — wait for their answer.
    if (duplicateConflict) return;

    // Auto-save from the very first edit — a new report is written as soon as
    // there is anything in it, so nothing is lost by closing the tab. The
    // server keeps this from creating a second report for a date that already
    // has one, and saveReport() will not run two requests at once.

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
