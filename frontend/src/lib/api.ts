/**
 * Daily Reporter V3 — API Client
 *
 * Type-safe HTTP client connecting to the FastAPI backend.
 * Used by web, desktop (Electron), and mobile (Capacitor) builds.
 */

import { type AxiosInstance } from 'axios';
import { authApi, BASE_URL, createAuthedClient } from '@/lib/authClient';
import type { Report } from '@/types';
import { Capacitor } from '@capacitor/core';

/**
 * How a Word export ended up with the user. The caller needs this to say the
 * right thing — "downloaded" is wrong when the file went to a folder they
 * chose, and wronger still when it opened in the phone's browser.
 */
export type WordSaveResult = 'external' | 'saved-to-chosen-folder' | 'downloaded' | 'cancelled';

// In development, Vite's proxy handles /api → localhost:8000
// In production, the backend serves the frontend (same origin)
const api: AxiosInstance = createAuthedClient({
  baseURL: `${BASE_URL}/api`,
  timeout: 120000, // 2 minutes default
});

// ============================================
// REPORTS
// ============================================

export const reportApi = {
  list: async (params?: {
    limit?: number;
    offset?: number;
    status?: string;
    project?: string;
    date_from?: string;
    date_to?: string;
  }) => {
    const response = await api.get('/reports', { params });
    return response.data;
  },

  get: async (id: string): Promise<Report> => {
    const response = await api.get(`/reports/${id}`);
    return response.data as Report;
  },

  create: async (report: Record<string, unknown>) => {
    const response = await api.post('/reports', report);
    return response.data;
  },

  update: async (id: string, report: Record<string, unknown>) => {
    const response = await api.put(`/reports/${id}`, report);
    return response.data;
  },

  delete: async (id: string) => {
    const response = await api.delete(`/reports/${id}`);
    return response.data;
  },

  /** Download the Word .docx for a report */
  /**
   * Download a report as Word.
   *
   * `filename` is only a fallback — the backend owns the naming convention
   * ("Morena Conveyance North - Daily-TW-MM-DD-YYYY.docx") and sends it in
   * Content-Disposition, so the browser download, the desktop auto-save and the
   * batch export cannot drift apart.
   */
  downloadWord: async (id: string, filename: string): Promise<WordSaveResult> => {
    // ── ANDROID ─────────────────────────────────────────────────────────────
    // The blob-download path below cannot work inside the Capacitor WebView:
    // Android ignores `blob:` downloads unless the native app registers a
    // DownloadListener, and none is registered. Export would fire, report
    // success, and produce no file.
    //
    // The APK bundles its assets locally while the API lives on Railway, so the
    // export URL is a different origin — Capacitor hands those to the system
    // browser, which downloads the .docx properly. No plugin required.
    if (Capacitor.isNativePlatform()) {
      // The system browser is a DIFFERENT APPLICATION. It has no access to this
      // app's session, and window.open cannot attach an Authorization header —
      // so once the export endpoint started requiring a signed-in user, this
      // silently produced a 401 page instead of the Word file the phone has
      // always saved. A short-lived token in the URL is what that browser can
      // actually carry.
      let url = `${BASE_URL}/api/export/${id}/word`;
      try {
        const t = await authApi.downloadToken();
        url += `?t=${encodeURIComponent(t)}`;
      } catch (err) {
        // Better to open it and let the browser show the sign-in error than to
        // fail silently — submitting has already succeeded by this point.
        console.warn('[Export] Could not get a download token:', err);
      }
      window.open(url, '_blank');
      console.debug('[Export] Opened externally for native download');
      return 'external';
    }

    const response = await api.get(`/export/${id}/word`, {
      responseType: 'blob',
    });

    const disposition = response.headers?.['content-disposition'] as string | undefined;
    const named = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    if (named) filename = decodeURIComponent(named.trim());

    // The backend returns a correctly-typed Blob already. The previous version
    // did `new Blob([response.data])`, which re-wraps it and throws away the
    // MIME type, so the file arrived as application/octet-stream.
    const blob = response.data instanceof Blob
      ? response.data
      : new Blob([response.data], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

    // Let the user choose where it goes, when the browser allows it.
    // An `a[download]` always dumps to the Downloads folder with no prompt,
    // which is wrong for a document that belongs in a project work folder.
    // Chrome and Edge on desktop support the File System Access API; Firefox,
    // Safari and Android WebView do not, so the anchor remains the fallback.
    const picker = (window as unknown as {
      showSaveFilePicker?: (opts: unknown) => Promise<{
        createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
      }>;
    }).showSaveFilePicker;

    if (typeof picker === 'function') {
      try {
        const handle = await picker({
          suggestedName: filename,
          types: [{
            description: 'Word document',
            accept: {
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
            },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        console.debug('[Export] Saved via file picker:', filename, `${blob.size} bytes`);
        return 'saved-to-chosen-folder';
      } catch (err) {
        // Cancelling the dialog is a normal outcome, not a failure — swallow it
        // so the caller does not report an error for a deliberate cancel.
        if ((err as { name?: string })?.name === 'AbortError') {
          console.debug('[Export] Save cancelled by user');
          return 'cancelled';
        }
        // Anything else (permission, sandboxed iframe): fall through to the anchor.
        console.warn('[Export] File picker unavailable, falling back to download:', err);
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';

    // BOTH of these matter and neither was here:
    //  - the anchor must be IN the document or the click is a no-op in Firefox
    //  - revoking the object URL synchronously after click() cancels the
    //    download in Chrome before it has started, which leaves a stalled .tmp
    //    in the Downloads folder. Hence the timeout.
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 30_000);

    console.debug('[Export] Word download triggered:', filename, `${blob.size} bytes`);
    return 'downloaded';
  },

  /** Get PMWeb Combined rows (11 cols) for the preview panel */
  getPMWebCombined: async (id: string) => {
    const response = await api.get(`/export/${id}/pmweb`);
    return response.data;
  },

  /** Notify the Chrome extension which report is active */
  setExtensionContext: async (reportId: string) => {
    const response = await api.post('/extension/context', { report_id: reportId });
    return response.data;
  },

  /** Clear the Chrome extension context (e.g. when creating a new unsaved report) */
  clearExtensionContext: async () => {
    const response = await api.post('/extension/context', { report_id: null });
    return response.data;
  },

  /** Send PMWeb rows to the Chrome extension for auto-fill */
  launchPMWebAutomation: async (payload: Record<string, unknown>[]) => {
    const response = await api.post('/automation/pmweb', { data: payload });
    return response.data;
  },
};

// ============================================
// AUTH
// ============================================
//
// There is no authApi here. It lives in lib/authClient, which every caller
// already used — this was a leftover from when the auth endpoints were stubs,
// and a second export with the same name is only ever going to be imported by
// accident. It also routed login through the shared client, whose 401 handler
// ends the session: a mistyped password would have fired "you have been signed
// out" instead of "wrong password".

// ============================================
// SCANNING (Phase 4)
// ============================================

export const scanApi = {
  scanNotes: async (files: File[], merge: boolean = false) => {
    const formData = new FormData();
    files.forEach((file) => formData.append('images', file));
    formData.append('merge', String(merge));

    const response = await api.post('/ai/scan-notes', formData, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 180000,
    });
    return response.data;
  },

  /** Scan a single Extra Work Ticket image/PDF */
  scanExtraWork: async (file: File, targetDate?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (targetDate) formData.append('target_date', targetDate);

    const response = await api.post('/ai/scan-extra-work', formData, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 120000,
    });
    return response.data;
  },

  /** Scan a Consultant Site Visit Record */
  scanConsultant: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post('/ai/scan-consultant', formData, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 120000,
    });
    return response.data;
  },

  /** Transcribe base64 audio and extract structured activities */
  transcribe: async (
    audioData: string,
    mimeType: string = 'audio/webm',
    context: Record<string, string> = {},
  ) => {
    const response = await api.post('/ai/transcribe', {
      audio_data: audioData,
      mime_type: mimeType,
      context,
    });
    return response.data;
  },

  /** Smart Dictation — transcribe audio into structured JSON (summary + resources) */
  transcribeSmart: async (
    audioData: string,
    fieldType: string = 'summary',
    mimeType: string = 'audio/webm',
    context: Record<string, unknown> = {},
  ) => {
    const response = await api.post('/ai/transcribe-smart', {
      audio_data: audioData,
      field_type: fieldType,
      mime_type: mimeType,
      context,
    });
    return response.data;
  },

  /** Activity Manager Co-Pilot endpoint */
  activityManagerChat: async (
    message: string,
    activities: Record<string, unknown>[],
    chatHistory: Record<string, string>[] = []
  ) => {
    const response = await api.post('/ai/activity-manager', {
      message,
      activities,
      chat_history: chatHistory,
    });
    return response.data;
  },

  /** Report Chat — full report AI assistant with voice support */
  reportChat: async (payload: {
    message?: string;
    audio_data?: string;
    mime_type?: string;
    report: Record<string, unknown>;
    chat_history: Record<string, string>[];
  }) => {
    const response = await api.post('/ai/report-chat', payload);
    return response.data as {
      reply: string;
      transcription: string;
      modified_general: Record<string, unknown> | null;
      modified_activities: Record<string, unknown>[] | null;
      new_activities: Record<string, unknown>[] | null;
      deleted_activity_ids: string[] | null;
    };
  },

  /** Email Summary — combine all activity summaries into one flowing email narrative */
  emailSummary: async (activities: Record<string, unknown>[], projectName: string, reportDate: string) => {
    const response = await api.post('/ai/email-summary', {
      activities,
      project_name: projectName,
      report_date: reportDate,
    });
    return response.data as { status: string; text: string };
  },

  /** AI Rewrite — polish rough notes into professional bullets */
  rewrite: async (text: string, fieldType: string = 'summary') => {
    const response = await api.post('/ai/rewrite', { text, field_type: fieldType });
    return response.data;
  },

  /**
   * Proofread — read finished text and flag what reads wrong, without
   * changing anything. Every issue quotes text verbatim so the UI can find
   * and replace exactly that span.
   */
  proofread: async (text: string, fieldType: string = 'summary'): Promise<{
    issues: Array<{
      quote: string;
      issue_type: string;
      severity: 'high' | 'medium' | 'low';
      why: string;
      suggestion: string;
    }>;
    checked_chars: number;
  }> => {
    const response = await api.post('/ai/proofread', { text, field_type: fieldType }, { timeout: 120000 });
    return response.data;
  },

  /** AI Analyze Questions — WWWW check, returns targeted questions */
  analyzeQuestions: async (
    text: string,
    workArea: string = '',
    context: Record<string, unknown> = {},
    chatHistory: Record<string, string>[] = []
  ) => {
    const response = await api.post('/ai/analyze-questions', {
      text,
      work_area: workArea,
      context,
      chat_history: chatHistory,
    });
    return response.data;
  },

  /** AI Generate Report — produce polished text from notes + answers */
  generateReport: async (
    originalText: string,
    answers: Record<string, string> = {},
    workArea: string = '',
    context: Record<string, unknown> = {},
    chatHistory: Record<string, string>[] = []
  ) => {
    const response = await api.post('/ai/generate-report', {
      original_text: originalText,
      answers,
      work_area: workArea,
      context,
      chat_history: chatHistory,
    });
    return response.data;
  },

  /** Bulk Dictate — one recording → multiple activities by location */
  bulkDictate: async (audioData: string, mimeType: string = 'audio/webm') => {
    const response = await api.post('/ai/bulk-dictate-activities', {
      audio_data: audioData,
      mime_type: mimeType,
    }, { timeout: 180000 });
    return response.data;
  },

  /**
   * STEP 1 of dictation — transcribe only.
   * The transcript is shown to the user for confirmation before any activities
   * are built, so a bad recording surfaces as visibly wrong text instead of a
   * confidently fabricated report.
   */
  bulkTranscribe: async (
    audioData: string,
    mimeType: string = 'audio/webm',
    durationSeconds: number = 0,
  ): Promise<{
    status: 'ok' | 'suspect' | 'failed';
    transcription: string;
    reason: string;
    duration_seconds: number;
  }> => {
    const response = await api.post('/ai/bulk-transcribe', {
      audio_data: audioData,
      mime_type: mimeType,
      duration_seconds: durationSeconds,
    }, { timeout: 180000 });
    return response.data;
  },

  /** STEP 2 of dictation — build activities from a CONFIRMED transcript. */
  bulkParse: async (transcription: string) => {
    const response = await api.post('/ai/bulk-parse', {
      transcription,
    }, { timeout: 180000 });
    return response.data;
  },

  /** Update Activity from media (Smart Merge) */
  updateActivity: async (
    file: File | null,
    audioData: string | null,
    currentData: Record<string, unknown>,
    mergeMode: boolean = true
  ) => {
    const formData = new FormData();
    if (file) formData.append('file', file);
    if (audioData) formData.append('audio_data', audioData);
    formData.append('current_data', JSON.stringify(currentData));
    formData.append('merge_mode', String(mergeMode));

    const response = await api.post('/ai/update-activity', formData, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 180000,
    });
    return response.data;
  },

  /** Parse completed report (.docx / .pdf) → create draft */
  parseReport: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post('/ai/parse-report', formData, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 300000,
    });
    return response.data;
  },

  /** Parse dispatch PDF → structured job columns */
  parseDispatch: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post('/ai/parse-dispatch', formData, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 300000, // 5 minutes — dispatches are dense
    });
    return response.data;
  },
};

// ============================================
// HEALTH
// ============================================

export const healthApi = {
  check: async () => {
    const response = await api.get('/health');
    return response.data;
  },
};

// ============================================
// WEATHER
// ============================================

export interface WeatherData {
  status: string;
  temperature_high: string;
  temperature_low: string;
  humidity: number;
  wind_speed: number;
  wind_direction: string;
  wind_info: string;
  condition: string;
  emoji: string;
  sky_condition_id: string;
  weather_code: number;
  location: string;
  zip?: string;
}

export const weatherApi = {
  /** Fetch weather by GPS coordinates (optionally for a specific date YYYY-MM-DD) */
  fetchByCoords: async (lat: number, lon: number, date?: string): Promise<WeatherData> => {
    const response = await api.get('/weather', { params: { lat, lon, ...(date ? { date } : {}) } });
    return response.data;
  },

  /** Fetch weather by US ZIP code (optionally for a specific date YYYY-MM-DD) */
  fetchByZip: async (zip: string, date?: string): Promise<WeatherData> => {
    const response = await api.get('/weather/by-zip', { params: { zip, ...(date ? { date } : {}) } });
    return response.data;
  },
};

// ============================================
// PDF SEARCH
// ============================================

export interface PdfDocument {
  id: string;
  filename: string;
  page_count: number;
  upload_date: string;
  file_size: number;
}

export const pdfApi = {
  /** Upload PDF files */
  upload: async (files: File[]): Promise<{ status: string; files: { filename: string; id?: string; page_count?: number; error?: string }[] }> => {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    const response = await api.post('/pdf/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  /** Ask a question about uploaded PDFs */
  ask: async (
    question: string,
    docIds: string[],
    chatHistory: { role: string; content: string }[] = [],
  ): Promise<{ answer: string; sources: { doc: string; page: string; text: string }[] }> => {
    const formData = new FormData();
    formData.append('question', question);
    formData.append('doc_ids', docIds.join(','));
    formData.append('chat_history', JSON.stringify(chatHistory));
    const response = await api.post('/pdf/ask', formData, {
      headers: { 'Content-Type': null as unknown as string },
    });
    return response.data;
  },

  /** List all uploaded PDF documents */
  list: async (): Promise<{ documents: PdfDocument[]; count: number }> => {
    const response = await api.get('/pdf/documents');
    return response.data;
  },

  /** Delete a PDF document */
  delete: async (docId: string): Promise<{ status: string; message: string }> => {
    const response = await api.delete(`/pdf/${docId}`);
    return response.data;
  },
};

// ============================================
// SCHEDULE
// ============================================

export const scheduleApi = {
  /** Upload a schedule PDF — AI parses all shifts */
  upload: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post('/schedule/upload', formData, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 300000,
    });
    return response.data;
  },

  /** Get the most recently uploaded schedule */
  getActive: async () => {
    const response = await api.get('/schedule/active');
    return response.data;
  },

  /** Get a specific schedule by ID */
  getById: async (id: string) => {
    const response = await api.get(`/schedule/${id}`);
    return response.data;
  },

  /** List all uploaded schedules */
  list: async () => {
    const response = await api.get('/schedule/list');
    return response.data;
  },

  /** Delete a schedule */
  delete: async (id: string) => {
    const response = await api.delete(`/schedule/${id}`);
    return response.data;
  },
};

// ============================================
// DISPATCH LIBRARY
// ============================================

export const dispatchApi = {
  /** Upload a single dispatch PDF for a specific date */
  upload: async (file: File, date: string) => {
    console.debug('[API] dispatchApi.upload:', file.name, 'date:', date);
    const form = new FormData();
    form.append('file', file);
    form.append('date', date);
    const res = await api.post('/dispatches/upload', form, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 300_000, // 5 min — AI parsing
    });
    console.debug('[API] dispatchApi.upload result:', res.data);
    return res.data;
  },

  /** Batch upload multiple dispatch PDFs (auto-detect dates from filenames) */
  batchUpload: async (files: File[]) => {
    console.debug('[API] dispatchApi.batchUpload:', files.length, 'files');
    const form = new FormData();
    files.forEach(f => form.append('files', f));
    const res = await api.post('/dispatches/batch-upload', form, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 600_000, // 10 min — multiple files
    });
    console.debug('[API] dispatchApi.batchUpload result:', res.data);
    return res.data;
  },

  /** Get parsed dispatch data for a specific date */
  getByDate: async (date: string) => {
    console.debug('[API] dispatchApi.getByDate:', date);
    const res = await api.get(`/dispatches/${date}`);
    console.debug('[API] dispatchApi.getByDate result:', res.data);
    return res.data;
  },

  /** List all available dispatch dates */
  list: async () => {
    console.debug('[API] dispatchApi.list');
    const res = await api.get('/dispatches');
    console.debug('[API] dispatchApi.list result:', res.data);
    return res.data;
  },

  /** Delete dispatch for a date */
  delete: async (date: string) => {
    console.debug('[API] dispatchApi.delete:', date);
    const res = await api.delete(`/dispatches/${date}`);
    console.debug('[API] dispatchApi.delete result:', res.data);
    return res.data;
  },
};

// ============================================
// TRAFFIC CONTROL AI
// ============================================

export const tcApi = {
  /** Generate TC activity description from crew + location + TC plan */
  generate: async (params: {
    streets: string[];
    location: string;
    tc_crew: { name: string; time: string }[];
    sub_tc: { company: string; details: string; count?: number; time?: string } | null;
    work_description: string;
    schedule_shift: string;
    start_time: string;
    end_time: string;
  }) => {
    console.debug('[API] tcApi.generate:', params);
    const res = await api.post('/ai/generate-tc', params);
    console.debug('[API] tcApi.generate result:', res.data);
    return res.data;
  },
};

// ============================================
// BACKFILL (makeup reports from scanned timesheets)
// ============================================

export interface BackfillFile {
  file_id: string;
  filename: string;
  doc_type: string;
  work_date: string;
  confidence: number;
  date_source: string;
  weekday_check: string;
  page_count: number;
  size_bytes: number;
  note: string;
}

export interface BackfillDate {
  date: string;
  state: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  file_ids: string[];
  report_id: string;
  flag_count: number;
  flags: string[];
  excluded_sheets: { sheet: string; reason: string }[];
  activity_count: number;
  message: string;
}

export interface BackfillStatus {
  batch_id: string;
  created_at: string;
  updated_at: string;
  state: string;
  files: (BackfillFile & { stored_name: string })[];
  dates: BackfillDate[];
}

export const backfillApi = {
  /** Upload source documents — returns per-file doc type and work date */
  upload: async (files: File[]): Promise<{ batch_id: string; files: BackfillFile[] }> => {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    const res = await api.post('/backfill/upload', form, {
      headers: { 'Content-Type': null as unknown as string },
      timeout: 600_000, // classification of undated files costs an AI call each
    });
    return res.data;
  },

  /** Kick off generation. Returns immediately — poll status() for progress. */
  generate: async (params: {
    batch_id: string;
    groups: { date: string; file_ids: string[] }[];
    detail_level?: 'factual' | 'narrative';
    use_continuity?: boolean;
    fetch_weather?: boolean;
  }): Promise<{ batch_id: string; queued_dates: string[]; message: string }> => {
    const res = await api.post('/backfill/generate', params);
    return res.data;
  },

  status: async (batchId: string): Promise<BackfillStatus> => {
    const res = await api.get(`/backfill/${batchId}/status`);
    return res.data;
  },

  list: async (): Promise<{
    batches: {
      batch_id: string; created_at: string; updated_at: string;
      state: string; file_count: number; date_count: number; done_count: number;
    }[];
  }> => {
    const res = await api.get('/backfill');
    return res.data;
  },

  /** URL of a stored source file — used directly as an <iframe>/<img> src */
  fileUrl: (batchId: string, fileId: string): string =>
    `${BASE_URL}/api/backfill/${batchId}/file/${fileId}`,

  exportUrl: (batchId: string): string =>
    `${BASE_URL}/api/backfill/${batchId}/export.zip`,
};

export default api;

