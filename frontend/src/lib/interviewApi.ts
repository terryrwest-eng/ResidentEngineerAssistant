/**
 * Daily Reporter V3 — Guided interview client
 *
 * One recording answers one question. The server transcribes it, pulls out the
 * single field that question asks for, and hands back both the transcript and
 * the cleaned answer — the transcript so a bad recording shows up as visibly
 * wrong text instead of quietly becoming wrong report content.
 */

import api from '@/lib/api';

export type QuestionKind =
  | 'time'
  | 'text'
  | 'narrative'
  | 'station_range'
  | 'segments'
  | 'crew'
  | 'equipment'
  | 'yesno'
  | 'list';

export interface InterviewQuestion {
  id: string;
  prompt: string;
  kind: QuestionKind;
  help: string;
  required: boolean;
  /** When in the shift it is asked: 'start' | 'during' | 'end'. Empty means
   *  the format has no phases and declaration order is used. */
  phase: string;
  /** How the answer reads in the printed report. Empty for narrative answers,
   *  which already read as sentences. */
  print_label: string;
  /** Only asked when this other question was answered yes. */
  gate: string;
  example: string;
}

export interface InterviewSection {
  id: string;
  number: number;
  title: string;
  empty_statement: string;
  /** Asked once per thing it describes — Morena runs several locations a day
   *  and each is its own activity with its own crew, stations and quantities. */
  repeats: boolean;
  /** Asked after each pass; yes runs the section again. */
  repeat_prompt: string;
  /** Question id whose list answer decides how many passes this section runs. */
  repeat_from: string;
  /** Field each item pre-fills, so the location is never typed twice. */
  repeat_label: string;
  questions: InterviewQuestion[];
}

export interface InterviewProfile {
  key: string;
  project_name: string;
  title: string;
  contractor: string;
  renderer: string;
  question_count: number;
  sections: InterviewSection[];
}

export interface ProfileSummary {
  key: string;
  project_name: string;
  title: string;
  contractor: string;
  question_count: number;
}

export interface AnswerResult {
  question_id: string;
  /** What the model heard. Always shown, never hidden. */
  transcript: string;
  value: string;
  rows: Record<string, unknown>[];
  /** What the question wanted that the recording did not contain. */
  missing: string[];
  status: 'ok' | 'empty' | 'suspect' | 'failed';
  reason: string;
}

export interface ComposedSection {
  id: string;
  number: number;
  title: string;
  /** The written section — prose, not the answers echoed back. */
  body: string;
}

export const interviewApi = {
  /** Every project's format — drives the picker that opens a new report. */
  profiles: async (): Promise<ProfileSummary[]> => {
    const res = await api.get('/interview/profiles');
    return res.data.profiles;
  },

  /** One format in full: sections, questions, prompts, empty statements. */
  profile: async (key: string): Promise<InterviewProfile> => {
    const res = await api.get(`/interview/profile/${key}`);
    return res.data;
  },

  /**
   * Write the report from the answers.
   *
   * The step between answering and having a document: the answers are notes,
   * this composes them into labelled sub-topics in the inspector's voice.
   */
  compose: async (params: {
    profile: string;
    answers: Record<string, string>;
    report_date?: string;
  }): Promise<{ sections: ComposedSection[]; status: string; reason: string }> => {
    const res = await api.post('/interview/compose', params, { timeout: 180000 });
    return res.data;
  },

  /** Answer one question by voice, or by typed text. */
  answer: async (params: {
    profile: string;
    section_id: string;
    question_id: string;
    audio_data?: string;
    mime_type?: string;
    duration_seconds?: number;
    text?: string;
    report_date?: string;
  }): Promise<AnswerResult> => {
    const res = await api.post('/interview/answer', params, { timeout: 180000 });
    return res.data;
  },
};
