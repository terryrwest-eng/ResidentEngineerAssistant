/**
 * Daily Reporter V4 — the conversation API
 *
 * `turn` is the loop: what was said goes in, the next question comes back, and
 * the whole record travels with it in both directions — the server decides
 * nothing between turns, so a dropped connection or a reloaded page loses a
 * question, not a shift.
 *
 * `draft` is the exception, and only a parking space. The unfinished
 * conversation is stored so it can be picked up on a different device, or
 * after the one it was started on was closed. It is never a report: nothing
 * reaches the report history until the record is complete and composed.
 */

import { createAuthedClient, BASE_URL } from '@/lib/authClient';
import type { Report } from '@/types';

const api = createAuthedClient({
  baseURL: `${BASE_URL}/api/conversation`,
  // A turn is three model calls run at full thinking level, deliberately. The
  // default two minutes is not enough and a timeout here loses the answer the
  // inspector just gave.
  timeout: 300000,
});

/** One thing the record still needs, or is not sure about. */
export interface Blocking {
  key: string;
  question_id: string;
  label: string;
  instance: string;
  reason?: string;
  heard?: string;
  required?: string;
}

export interface SectionGap {
  section_id: string;
  number: number;
  title: string;
  writable: boolean;
  missing: Blocking[];
  suspect: Blocking[];
}

export interface Conflict {
  key: string;
  known: string;
  heard: string;
  note: string;
}

export interface Progress {
  total: number;
  known: number;
  suspect: number;
  empty: number;
}

export interface TurnResult {
  transcript: string;
  reply: string;
  /** Opaque to the UI — hand it straight back on the next turn. */
  record: Record<string, unknown>;
  updated: { key: string; state: string; value: string; instance: string; reason: string }[];
  asked_keys: string[];
  conflicts: Conflict[];
  progress: Progress;
  gaps: SectionGap[];
  ready_to_write: boolean;
  /** ok — carry on · repeat — it could not hear, say it again · done */
  status: 'ok' | 'repeat' | 'done';
  reason: string;
}

export interface TurnInput {
  profile: string;
  report_date: string;
  record: Record<string, unknown> | null;
  history: { role: 'assistant' | 'inspector'; text: string }[];
  audio_data?: string;
  mime_type?: string;
  duration_seconds?: number;
  text?: string;
  asked_keys?: string[];
}

/** The unfinished conversation as the server stores it. */
export interface ParkedDraft {
  report_date: string;
  profile: string;
  history: { role: 'assistant' | 'inspector'; text: string }[];
  record: Record<string, unknown> | null;
  asked_keys: string[];
  progress: Progress;
  gaps: SectionGap[];
  conflicts: Conflict[];
  ready: boolean;
  typed: string;
  saved_at: string;
  device: string;
}

/**
 * What a lookup found.
 *
 * 'none' and 'unavailable' are NOT the same answer and must never collapse
 * into one. 'none' means the conversation was written up or dropped somewhere
 * else, which is worth acting on. 'unavailable' means a lift went through a
 * dead spot, which is worth ignoring - and treating that as 'none' would wipe
 * a live conversation off the screen every time the signal dipped.
 */
export type DraftLookup =
  | { status: 'found'; draft: ParkedDraft }
  | { status: 'none' }
  | { status: 'unavailable' };

// Parking is a file write, not a model call, so it must not inherit the five
// minute turn timeout - a save that hangs on a bad signal would hold the
// pagehide handler open and still not land.
const DRAFT_TIMEOUT_MS = 12000;

// The check that runs while the page is open is quieter still: it is a
// courtesy, and one that must never queue up behind itself on a bad signal.
const DRAFT_POLL_TIMEOUT_MS = 6000;

export const conversationApi = {
  /** One exchange. Send nothing on the first call to get the opening question. */
  turn: async (input: TurnInput): Promise<TurnResult> => {
    const response = await api.post('/turn', input);
    return response.data as TurnResult;
  },

  /**
   * The conversation parked on the server.
   *
   * Never throws: the device's own copy is the one that has to work, and a
   * lookup that cannot run must not stop a conversation starting. Pass
   * `quiet` for the repeating check while the page is open, which gets a
   * shorter timeout and does not complain to the console each time.
   */
  getDraft: async (quiet = false): Promise<DraftLookup> => {
    try {
      const response = await api.get('/draft', {
        timeout: quiet ? DRAFT_POLL_TIMEOUT_MS : DRAFT_TIMEOUT_MS,
      });
      const draft = (response.data?.draft ?? null) as ParkedDraft | null;
      return draft ? { status: 'found', draft } : { status: 'none' };
    } catch (err) {
      if (!quiet) console.warn('[conversation] Could not read the parked conversation:', err);
      return { status: 'unavailable' };
    }
  },

  /** Park it. Returns the server's timestamp, which is what decides newest. */
  putDraft: async (draft: Omit<ParkedDraft, 'saved_at'>): Promise<string | null> => {
    try {
      const response = await api.put('/draft', draft, { timeout: DRAFT_TIMEOUT_MS });
      return (response.data?.saved_at ?? null) as string | null;
    } catch (err) {
      console.warn('[conversation] Could not park the conversation:', err);
      return null;
    }
  },

  /** Release it — the conversation became a report, or was started over. */
  deleteDraft: async (): Promise<void> => {
    try {
      await api.delete('/draft', { timeout: DRAFT_TIMEOUT_MS });
    } catch (err) {
      console.warn('[conversation] Could not release the parked conversation:', err);
    }
  },

  /** What is still unknown, without spending a turn. No model call. */
  gaps: async (input: Pick<TurnInput, 'profile' | 'report_date' | 'record'>) => {
    const response = await api.post('/gaps', input);
    return response.data as {
      progress: Progress;
      gaps: SectionGap[];
      blocking: Blocking[];
      conflicts: Conflict[];
      ready_to_write: boolean;
    };
  },

  /**
   * Write the report from the record.
   *
   * Throws with status 409 while anything is missing, unclear or contested —
   * the caller is a conversation that can still go and ask, so the refusal
   * carries the list rather than a half-written report.
   */
  compose: async (
    input: Pick<TurnInput, 'profile' | 'report_date' | 'record'>,
  ): Promise<{ report: Report; progress: Progress }> => {
    const response = await api.post('/compose', input);
    return response.data as { report: Report; progress: Progress };
  },
};
