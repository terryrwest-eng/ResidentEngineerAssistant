/**
 * Daily Reporter V3 — API Client
 *
 * Type-safe HTTP client connecting to the FastAPI backend.
 * Used by web, desktop (Electron), and mobile (Capacitor) builds.
 */

import axios, { type AxiosInstance } from 'axios';

// In development, Vite's proxy handles /api → localhost:8000
// In production, the backend serves the frontend (same origin)
const BASE_URL = import.meta.env.VITE_API_URL || '';

const api: AxiosInstance = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 120000, // 2 minutes default
  headers: {
    'Content-Type': 'application/json',
  },
});

// --- Request interceptor: attach auth token ---
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// --- Response interceptor: handle errors ---
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.error('[API] 401 Unauthorized:', error.config?.url);
      // Future: redirect to login
    }
    return Promise.reject(error);
  }
);

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

  get: async (id: string) => {
    const response = await api.get(`/reports/${id}`);
    return response.data;
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
  downloadWord: async (id: string, filename: string) => {
    const response = await api.get(`/export/${id}/word`, {
      responseType: 'blob',
    });
    // Trigger browser download
    const url = URL.createObjectURL(new Blob([response.data]));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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

  /** Send PMWeb rows to the Chrome extension for auto-fill */
  launchPMWebAutomation: async (payload: Record<string, unknown>[]) => {
    const response = await api.post('/automation/pmweb', { data: payload });
    return response.data;
  },
};

// ============================================
// AUTH
// ============================================

export const authApi = {
  login: async (email: string, password: string) => {
    const response = await api.post('/auth/login', { email, password });
    return response.data;
  },

  register: async (name: string, email: string, password: string) => {
    const response = await api.post('/auth/register', { name, email, password });
    return response.data;
  },

  me: async () => {
    const response = await api.get('/auth/me');
    return response.data;
  },
};

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
    };
  },

  /** AI Rewrite — polish rough notes into professional bullets */
  rewrite: async (text: string, fieldType: string = 'summary') => {
    const response = await api.post('/ai/rewrite', { text, field_type: fieldType });
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

export default api;

