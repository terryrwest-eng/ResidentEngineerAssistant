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
 * IT IS ALSO PARKED ON THE SERVER. The device copy is the one that has to
 * work - it is written synchronously, survives a dead signal, and is there
 * before the first frame renders. The server copy is what carries the
 * conversation between devices: started on the phone in the truck, finished on
 * the laptop at the desk, and still there if the phone is lost. Neither is a
 * report; nothing reaches the report history until the record is composed.
 *
 * WHICH ONE WINS: whichever was written last. Both carry the SERVER's
 * timestamp - the device copy is restamped with whatever the server returned -
 * so the comparison is one clock against itself rather than a phone's clock
 * against a laptop's.
 *
 * IT IS CHECKED AGAIN WHILE THE PAGE IS OPEN, not only when it opens. The
 * whole point is to answer on the phone, carry on at the laptop, shut the
 * laptop and pick the phone back up - and the phone was never closed, so a
 * check that only runs on mount would never run at all. See
 * checkForNewerConversation.
 */

import { getStoredUser } from '@/lib/authClient';
import { conversationApi, type DraftLookup, type ParkedDraft } from '@/lib/conversationApi';
import type { Conflict, Progress, SectionGap } from '@/lib/conversationApi';

export const CONVERSATION_DRAFT_KEY = 'conversationDraft.v1';
const DEVICE_KEY = 'conversationDevice.v1';

/**
 * A stable name for this device.
 *
 * Only so the resume banner can say a conversation was carried over from
 * somewhere else rather than picked up where it was left. Never sent anywhere
 * but this user's own draft.
 */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const minted = `${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, minted);
    return minted;
  } catch {
    return '';
  }
}

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
  /** Which device wrote it last. Only the banner reads this. */
  device?: string;
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
    device: typeof d.device === 'string' ? d.device : '',
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
    device: deviceId(),
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

// ── The server copy ─────────────────────────────────────────────────────────

/** A parked draft in the shape the page uses. */
function fromParked(parked: ParkedDraft): ConversationDraft | null {
  const history = (parked.history || []).filter(
    (h) => h && (h.role === 'assistant' || h.role === 'inspector') && typeof h.text === 'string',
  );
  if (!history.length) return null;

  return {
    version: 1,
    userId: getStoredUser()?.id || '',
    savedAt: parked.saved_at || '',
    reportDate: parked.report_date || '',
    profile: parked.profile || 'morena',
    history,
    record: parked.record ?? null,
    askedKeys: parked.asked_keys || [],
    progress: parked.progress || { total: 0, known: 0, suspect: 0, empty: 0 },
    gaps: parked.gaps || [],
    conflicts: parked.conflicts || [],
    ready: parked.ready === true,
    typed: parked.typed || '',
    device: parked.device || '',
  };
}

/**
 * Park it in both places.
 *
 * The device write happens first and synchronously, because it is the one that
 * has to survive the screen closing a moment later. The server write is sent
 * after and never awaited by the caller - it carries the conversation to the
 * other device, which matters, but not enough to make answering a question
 * wait on a signal.
 */
export function parkConversation(input: ConversationDraftInput): Promise<string | null> {
  saveConversationDraft(input);

  const said = input.history.some((h) => h.role === 'inspector' && h.text.trim());
  if (!said && !input.typed.trim()) {
    return conversationApi.deleteDraft().then(() => null);
  }

  return conversationApi.putDraft({
    report_date: input.reportDate,
    profile: input.profile,
    history: input.history,
    record: input.record,
    asked_keys: input.askedKeys,
    progress: input.progress,
    gaps: input.gaps,
    conflicts: input.conflicts,
    ready: input.ready,
    typed: input.typed,
    device: deviceId(),
  }).then((savedAt) => {
    // Restamp the device copy with the SERVER's clock, so that comparing the
    // two later compares one clock with itself. Without this, a phone running
    // a few minutes fast would always look newer than the laptop.
    if (!savedAt) return null;
    const local = loadConversationDraft();
    if (local) {
      try {
        localStorage.setItem(CONVERSATION_DRAFT_KEY, JSON.stringify({ ...local, savedAt }));
      } catch {
        /* the draft is already saved; only the timestamp missed */
      }
    }
    return savedAt;
  });
}

/** Release it everywhere — it became a report, or was deliberately dropped. */
export function releaseConversation(): void {
  clearConversationDraft();
  void conversationApi.deleteDraft();
}

/**
 * The conversation to open with: this device's, the server's, or neither.
 *
 * Returns whichever was written last. `carriedOver` says the winner came from
 * somewhere else, which is the difference between "picked up where you left
 * off" and "carried over from your other device".
 */
export async function newestConversation(
  local: ConversationDraft | null,
): Promise<{ draft: ConversationDraft | null; carriedOver: boolean }> {
  const found = await conversationApi.getDraft();
  const remote = found.status === 'found' ? fromParked(found.draft) : null;
  if (!remote) return { draft: local, carriedOver: false };
  if (!local) return { draft: remote, carriedOver: remote.device !== deviceId() };

  // Equal timestamps are the same conversation seen twice - keep the device
  // copy, which may carry a sentence typed since.
  if (remote.savedAt <= local.savedAt) return { draft: local, carriedOver: false };
  return { draft: remote, carriedOver: remote.device !== deviceId() };
}

/** What a re-check while the page is open found. */
export type ConversationUpdate =
  | { status: 'newer'; draft: ConversationDraft }
  | { status: 'unchanged' }
  | { status: 'gone' }
  | { status: 'unavailable' };

/**
 * Has this conversation moved on somewhere else since `since`?
 *
 * This is what makes a phone that has been sitting in a pocket catch up with
 * the laptop it was left on, without being reloaded. It answers 'unchanged'
 * for our own last write, which is why the caller has to keep the stamp the
 * server gave it rather than a local clock reading.
 *
 * 'gone' means the draft was released - written up as a report, or started
 * over, on the other device. That is a real event worth telling the inspector
 * about. A dead spot answers 'unavailable' and nothing happens, which is the
 * distinction the whole DraftLookup type exists to preserve.
 */
export async function checkForNewerConversation(since: string): Promise<ConversationUpdate> {
  const found: DraftLookup = await conversationApi.getDraft(true);
  if (found.status === 'unavailable') return { status: 'unavailable' };
  if (found.status === 'none') return since ? { status: 'gone' } : { status: 'unchanged' };

  const remote = fromParked(found.draft);
  if (!remote) return { status: 'unchanged' };
  if (since && remote.savedAt <= since) return { status: 'unchanged' };
  if (remote.device === deviceId() && remote.savedAt === since) return { status: 'unchanged' };
  return { status: 'newer', draft: remote };
}
