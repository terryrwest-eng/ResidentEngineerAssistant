import { BASE_URL, createAuthedClient } from '@/lib/authClient';

const api = createAuthedClient({
  baseURL: `${BASE_URL}/api`,
  timeout: 30000,
});

export const trackerApi = {
  // Excavation
  listExcavation: async () => (await api.get('/trackers/excavation')).data,
  createExcavation: async (row: Record<string, unknown>) => (await api.post('/trackers/excavation', row)).data,
  updateExcavation: async (id: string, row: Record<string, unknown>) => (await api.put(`/trackers/excavation/${id}`, row)).data,
  deleteExcavation: async (id: string) => (await api.delete(`/trackers/excavation/${id}`)).data,

  // Pay Items
  listPayItems: async () => (await api.get('/trackers/pay-items')).data,
  createPayItem: async (row: Record<string, unknown>) => (await api.post('/trackers/pay-items', row)).data,
  updatePayItem: async (id: string, row: Record<string, unknown>) => (await api.put(`/trackers/pay-items/${id}`, row)).data,
  deletePayItem: async (id: string) => (await api.delete(`/trackers/pay-items/${id}`)).data,

  // Punch List
  listPunchList: async () => (await api.get('/trackers/punch-list')).data,
  createPunchItem: async (row: Record<string, unknown>) => (await api.post('/trackers/punch-list', row)).data,
  updatePunchItem: async (id: string, row: Record<string, unknown>) => (await api.put(`/trackers/punch-list/${id}`, row)).data,
  deletePunchItem: async (id: string) => (await api.delete(`/trackers/punch-list/${id}`)).data,

  // Redlines
  listRedlines: async () => (await api.get('/trackers/redlines')).data,
  createRedline: async (row: Record<string, unknown>) => (await api.post('/trackers/redlines', row)).data,
  updateRedline: async (id: string, row: Record<string, unknown>) => (await api.put(`/trackers/redlines/${id}`, row)).data,
  deleteRedline: async (id: string) => (await api.delete(`/trackers/redlines/${id}`)).data,
};

// ─── AI Feature API ───────────────────────────────────────────────────────────

const aiApi = createAuthedClient({
  baseURL: `${BASE_URL}/api/ai`,
  timeout: 120000, // 2 min — Gemini vision calls can be slow
});

/** Scan timesheets/notes. merge=true → one activity; merge=false → one per file */
export async function scanNotes(files: File[], merge: boolean): Promise<{ activities: unknown[] }> {
  const form = new FormData();
  files.forEach((f) => form.append('images', f));
  form.append('merge', String(merge));
  const res = await aiApi.post('/scan-notes', form, { headers: { 'Content-Type': 'multipart/form-data' } });
  return res.data;
}

/** Bulk plain-text dictation → formatted sections (Dictate All Activities button) */
export async function transcribeAudio(audioBase64: string, mimeType: string, context: Record<string, unknown> = {}): Promise<{ activities: unknown[]; raw_transcription: string }> {
  const res = await aiApi.post('/transcribe', { audio_data: audioBase64, mime_type: mimeType, context });
  return res.data;
}

/** Per-activity structured dictation → summary_html + manpower/equipment JSON (Dictate button) */
export async function transcribeSmart(audioBase64: string, mimeType: string, context: Record<string, unknown> = {}): Promise<{ summary_html: string; work_area: string; manpower: unknown[]; equipment: unknown[] }> {
  const res = await aiApi.post('/transcribe-smart', { audio_data: audioBase64, mime_type: mimeType, context });
  return res.data;
}

/** AI Assistant step 1 — identify missing elements and return questions */
export async function analyzeQuestions(text: string, workArea: string, context: Record<string, unknown> = {}): Promise<{ questions: unknown[]; missing_elements: string[]; analysis_summary: string }> {
  const res = await aiApi.post('/analyze-questions', { text, work_area: workArea, context });
  return res.data;
}

/** AI Assistant step 2 — generate polished bullet-point report text */
export async function generateReport(originalText: string, answers: Record<string, string>, workArea: string, context: Record<string, unknown> = {}): Promise<{ report_text: string }> {
  const res = await aiApi.post('/generate-report', { original_text: originalText, answers, work_area: workArea, context });
  return res.data;
}

