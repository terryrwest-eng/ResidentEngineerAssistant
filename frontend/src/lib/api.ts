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
    const response = await api.post('/automation/set-context', { report_id: reportId });
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

export default api;
