/**
 * Daily Reporter — the signed-in HTTP client, and where the session lives.
 *
 * WHY EVERY CALLER SHARES THIS
 *
 * There were four separate axios instances (api, settingsApi, trackerApi and
 * the AI client) and only one of them attached the auth token. That was
 * harmless while nothing checked, but now that every data route requires a
 * signed-in user, three of the four would have failed with 401 — settings and
 * trackers among them.
 *
 * createAuthedClient is the single place a request learns who is making it, so
 * a new API module cannot forget.
 */

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  is_approved: boolean;
  created_at?: string;
}

// ── Session storage ──────────────────────────────────────────────────────────

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function storeSession(token: string, user: AuthUser): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch (e) {
    console.warn('[auth] Could not persist the session', e);
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* nothing useful to do */
  }
  // Chat history is the one other thing keyed to a person rather than a report.
  // Leaving it behind would show the next person to sign in on this device the
  // previous one's conversation.
  try {
    localStorage.removeItem('reportAssistantChatHistory');
  } catch {
    /* nothing useful to do */
  }
}

// ── Reacting to the session ending ───────────────────────────────────────────

type SessionEndedHandler = () => void;
const sessionEndedHandlers = new Set<SessionEndedHandler>();

/**
 * Register a callback for "the server says this session is over".
 *
 * The app uses this to drop back to the sign-in screen. It is a subscription
 * rather than a hard-coded redirect because the HTTP layer should not know
 * about routing.
 */
export function onSessionEnded(handler: SessionEndedHandler): () => void {
  sessionEndedHandlers.add(handler);
  return () => sessionEndedHandlers.delete(handler);
}

function sessionEnded(): void {
  clearSession();
  sessionEndedHandlers.forEach(h => {
    try {
      h();
    } catch (e) {
      console.warn('[auth] A session-ended handler threw', e);
    }
  });
}

export const BASE_URL = import.meta.env.VITE_API_URL || '';

/**
 * An axios instance that signs its requests and reacts to being signed out.
 *
 * A 401 means the token is gone or expired — the session is over, so it is
 * cleared and the app returns to sign-in. A 403 is deliberately NOT treated
 * that way: it means "you are signed in but not allowed", which covers an
 * account awaiting approval and a non-admin opening an admin screen. Signing
 * those users out would be wrong and, for the pending-approval case, would make
 * the app impossible to sit and wait in.
 */
export function createAuthedClient(config: AxiosRequestConfig): AxiosInstance {
  const instance = axios.create({
    headers: { 'Content-Type': 'application/json' },
    ...config,
  });

  instance.interceptors.request.use(cfg => {
    const token = getToken();
    if (token) {
      cfg.headers.Authorization = `Bearer ${token}`;
    }
    return cfg;
  });

  instance.interceptors.response.use(
    response => response,
    error => {
      if (error.response?.status === 401) {
        console.warn('[auth] Session rejected by the server:', error.config?.url);
        sessionEnded();
      }
      return Promise.reject(error);
    },
  );

  return instance;
}

// ── The auth endpoints themselves ────────────────────────────────────────────

// Its own client: these calls are what establish a session, so a 401 from
// /auth/login is "wrong password", not "your session ended". Routing it through
// the shared client would fire the signed-out handler on every failed attempt.
const authHttp = axios.create({
  baseURL: `${BASE_URL}/api/auth`,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

export interface AuthResult {
  user: AuthUser;
  token: string | null;
  message?: string;
  migrated?: string[];
  migration_skipped?: string[];
}

export const authApi = {
  /** Whether anybody has registered yet — decides which screen to show. */
  setupState: async (): Promise<{ needs_first_user: boolean }> =>
    (await authHttp.get('/setup-state')).data,

  login: async (email: string, password: string): Promise<AuthResult> =>
    (await authHttp.post('/login', { email, password })).data,

  register: async (name: string, email: string, password: string): Promise<AuthResult> =>
    (await authHttp.post('/register', { name, email, password })).data,

  /**
   * A short-lived token for a download that cannot send headers.
   *
   * Android hands the export URL to the system browser — a separate app with
   * no access to this session — so the credential has to ride in the URL.
   */
  downloadToken: async (): Promise<string> => {
    const token = getToken();
    const res = await authHttp.get('/download-token', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data.token as string;
  },

  me: async (): Promise<AuthUser> => {
    const token = getToken();
    return (
      await authHttp.get('/me', { headers: { Authorization: `Bearer ${token}` } })
    ).data;
  },

  changePassword: async (currentPassword: string, newPassword: string): Promise<void> => {
    const token = getToken();
    await authHttp.post(
      '/change-password',
      { current_password: currentPassword, new_password: newPassword },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  },

  // ── Admin ──
  listUsers: async (): Promise<AuthUser[]> => {
    const token = getToken();
    return (await authHttp.get('/users', { headers: { Authorization: `Bearer ${token}` } })).data;
  },

  approve: async (userId: string): Promise<AuthUser> => {
    const token = getToken();
    return (
      await authHttp.post(`/users/${userId}/approve`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).data;
  },

  revoke: async (userId: string): Promise<AuthUser> => {
    const token = getToken();
    return (
      await authHttp.post(`/users/${userId}/revoke`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).data;
  },

  setRole: async (userId: string, role: 'user' | 'admin'): Promise<AuthUser> => {
    const token = getToken();
    return (
      await authHttp.post(`/users/${userId}/role`, { role }, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).data;
  },

  remove: async (userId: string): Promise<void> => {
    const token = getToken();
    await authHttp.delete(`/users/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  },
};

/** Pull a readable message out of an axios error. */
export function authErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: string };
    if (first?.msg) return first.msg;
  }
  return fallback;
}
