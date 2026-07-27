/**
 * Daily Reporter V3 — Settings API client
 *
 * All settings calls go to /api/settings/*.
 * The Gemini API key is write-only from the frontend — status only is returned.
 */

import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${BASE_URL}/api/settings`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MasterLists {
  manpower: string[];
  equipment: string[];
}

export interface UserTemplate {
  id: string;
  name: string;
  body: string;
}

export interface CustomResourceCodes {
  labor: string[];
  equipment: string[];
}

export interface AppSettings {
  default_project: string;
  default_resident_engineer: string;
  projects: string[];
  default_start_time: string;
  default_stop_time: string;
  companies: string[];
  master_lists: MasterLists;
  custom_resource_codes: CustomResourceCodes;
  user_templates: UserTemplate[];
  /** Used for weather lookup when GPS is unavailable, and by the Backfill wizard. */
  default_zip_code: string;
  default_company: string;
  project_number: string;
  project_location: string;
  updated_at?: string;
}

export interface GeminiKeyStatus {
  has_key: boolean;
  source: 'environment' | 'settings' | 'none';
}

// ── API methods ────────────────────────────────────────────────────────────────

export const settingsApi = {
  /** Load all settings (API key is excluded) */
  get: async (): Promise<AppSettings> => {
    const res = await api.get('');
    return res.data as AppSettings;
  },

  /** Full settings update */
  update: async (payload: AppSettings): Promise<{ status: string; settings: AppSettings }> => {
    const res = await api.put('', payload);
    return res.data;
  },

  /** Update only master lists (manpower trades + equipment types) */
  updateMasterLists: async (lists: MasterLists): Promise<{ status: string; master_lists: MasterLists }> => {
    const res = await api.put('/master-lists', lists);
    return res.data;
  },

  /** Add a custom activity template */
  addTemplate: async (template: Omit<UserTemplate, 'id'> & { id?: string }): Promise<{ status: string; template: UserTemplate }> => {
    const res = await api.post('/templates', template);
    return res.data;
  },

  /** Delete a custom activity template by ID */
  deleteTemplate: async (templateId: string): Promise<{ status: string }> => {
    const res = await api.delete(`/templates/${templateId}`);
    return res.data;
  },

  /** Get built-in (non-editable) activity templates */
  getBuiltinTemplates: async (): Promise<{ templates: UserTemplate[] }> => {
    const res = await api.get('/templates/builtin');
    return res.data;
  },

  /** Save Gemini API key (write-only — key is never returned) */
  saveGeminiKey: async (apiKey: string): Promise<{ status: string; has_key: boolean }> => {
    const res = await api.post('/gemini-key', { api_key: apiKey });
    return res.data;
  },

  /** Check if a Gemini API key is stored (does not return the key) */
  getKeyStatus: async (): Promise<GeminiKeyStatus> => {
    const res = await api.get('/gemini-key/status');
    return res.data as GeminiKeyStatus;
  },

  /** Save resource alias mappings (merges into existing) */
  saveResourceAliases: async (
    aliases: { equipment?: Record<string, string>; manpower?: Record<string, string> }
  ): Promise<{ status: string; resource_aliases: { equipment: Record<string, string>; manpower: Record<string, string> } }> => {
    const res = await api.put('/resource-aliases', aliases);
    return res.data;
  },
};
