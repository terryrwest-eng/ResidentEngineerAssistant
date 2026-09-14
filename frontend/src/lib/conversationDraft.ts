/**
 * Daily Reporter — the in-progress conversation, parked on the device.
 *
 * WHY THIS EXISTS
 *
 * The conversation deliberately keeps no state on the server: every turn sends
 * the whole record and gets it back, so a dropped connection costs one question
 * instead of a shift. The price of that design was that the record lived ONLY
 * in React state — so the screen closing threw the whole day away, with nothing
 * written anywhere to go back to. That happened twice in the field, both times
 * on the last question, which is the most expensive moment it could happen.
 *
 * This is the missing half. After every turn the record is written here, and
 * the page picks it up again when it reopens. It is not a backup and not a sync
 * mechanism — it is the same record, parked somewhere a killed WebView cannot
 * take it with it.
 *
 * WHY NOT THE SERVER: a half-finished conversation must not leave a
 * half-finished report in the history, which is the rule the whole feature is
 * built on. The device is the right home for something that is not a report
 * yet.
 */

import { getStoredUser } from '@/lib/authClient';
import type { Conflict, Progress, SectionGap } from '@/lib/conversationApi';

export const CONVERSATION_DRAFT_KEY = 'conversationDraft.v1';

export interface DraftExchange {
  role: 'assistant' | 'inspector';
  text: string;
}

/** What the page needs to carry on exactly where it stopped. */
export interface ConversationDraft {
  version: 1;
  /** Whose conversation this is — a shared device must never hand it over. */
  userId: string;
  savedAt: string;
  reportDate: string;
  profile: string;
  history: DraftExchange[];
  record: Record<string, unknown> | null;
  askedKeys: string[];
  progress: Progress;
  gaps: SectionGap[];
  conflicts: Conflict[];
  ready: boolean;
  /** Typed but not yet sent. One sentence, but it is the one being written. */
  typed: string;
}

/** Everything except the bookkeeping this module fills in itself. */
export type ConversationDraftInput = Omit<ConversationDraft, 'version' | 'userId' | 'savedAt'>;

const EMPTY_PROGRESS: Progress = { total: 0, known: 0, suspect: 0, empty: 0 };

/**
 * A draft from stored text, or null.
 *
 * Parses rather than trusts: this is JSON written by an older build of the app
 * and read by a newer one, so every field is checked before it becomes state.
 * Anything unrecognisable is treated as absent — a restore that half works is
 * worse than a clean start, because it looks like the answers survived.
 */
function parseDraft(raw: string): ConversationDraft | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const d = parsed as Partial<ConversationDraft>;
  if (d.version !== 1) return null;
  if (!Array.isArray(d.history)) return null;

  const history: DraftExchange[] = d.history
    .filter((h): h is DraftExchange =>
      !!h && typeof h === 'object'
      && (h.role === 'assistant' || h.role === 'inspector')
      && typeof h.text === 'string')
    .map((h) => ({ role: h.role, text: h.text }));

  if (!history.length) return null;

  return {
    version: 1,
    userId: typeof d.userId === 'string' ? d.userId : '',
    savedAt: typeof d.savedAt === 'string' ? d.savedAt : '',
    reportDate: typeof d.reportDate === 'string' ? d.reportDate : '',
    profile: typeof d.profile === 'string' && d.profile ? d.profile : 'morena',
    history,
    record: d.record && typeof d.record === 'object' ? (d.record as Record<string, unknown>) : null,
    askedKeys: Array.isArray(d.askedKeys) ? d.askedKeys.filter((k): k is string => typeof k === 'string') : [],
    progress: d.progress && typeof d.progress === 'object' ? { ...EMPTY_PROGRESS, ...d.progress } : EMPTY_PROGRESS,
    gaps: Array.isArray(d.gaps) ? (d.gaps as SectionGap[]) : [],
    conflicts: Array.isArray(d.conflicts) ? (d.conflicts as Conflict[]) : [],
    ready: d.ready === true,
    typed: typeof d.typed === 'string' ? d.typed : '',
  };
}

/** Stored text, or null — a private window and blocked site data both throw. */
function read(): string | null {
  try {
    return localStorage.getItem(CONVERSATION_DRAFT_KEY);
  } catch {
    return null;
  }
}

/**
 * The conversation left unfinished on this device, if there is one.
 *
 * Deliberately NOT age-limited. A conversation abandoned yesterday is still an
 * hour of somebody's evening, and quietly binning it is the exact failure this
 * module exists to stop — the page shows which day it belongs to and offers to
 * start over instead.
 */
export function loadConversationDraft(): ConversationDraft | null {
  const raw = read();
  if (!raw) return null;

  let draft: ConversationDraft | null;
  try {
    draft = parseDraft(raw);
  } catch (err) {
    console.warn('[conversation] Could not read the saved conversation:', err);
    return null;
  }
  if (!draft) return null;

  // Whoever is signed in now has to be whoever left it. An unsigned draft
  // (written before this check existed) is allowed through once.
  const user = getStoredUser();
  if (draft.userId && user?.id && draft.userId !== user.id) return null;

  return draft;
}

/**
 * Park the conversation.
 *
 * Saves nothing until the inspector has actually said something: a page that
 * was opened and closed again leaves no draft, so the resume banner only ever
 * appears when there is real work behind it.
 */
export function saveConversationDraft(input: ConversationDraftInput): void {
  const said = input.history.some((h) => h.role === 'inspector' && h.text.trim());
  if (!said && !input.typed.trim()) {
    clearConversationDraft();
    return;
  }

  const draft: ConversationDraft = {
    version: 1,
    userId: getStoredUser()?.id || '',
    savedAt: new Date().toISOString(),
    ...input,
  };

  try {
    localStorage.setItem(CONVERSATION_DRAFT_KEY, JSON.stringify(draft));
  } catch (err) {
    // Out of quota, or storage refused. Nothing useful to do except say so —
    // the conversation itself still works, it just is not parked any more.
    console.warn('[conversation] Could not park the conversation on this device:', err);
  }
}

export function clearConversationDraft(): void {
  try {
    localStorage.removeItem(CONVERSATION_DRAFT_KEY);
  } catch {
    /* nothing useful to do */
  }
}

/** How many answers are actually in a draft — what the resume banner counts. */
export function draftAnswerCount(draft: ConversationDraft): number {
  return draft.history.filter((h) => h.role === 'inspector' && h.text.trim()).length;
}
