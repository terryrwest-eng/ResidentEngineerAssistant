/**
 * Daily Reporter — who is signed in, for the whole app.
 *
 * Holds the session, revalidates it on load, and exposes sign in / register /
 * sign out. Everything below <AuthGate> can assume there is a user.
 *
 * The context and useAuth live in authContext.ts — a module exporting both a
 * component and plain functions breaks Fast Refresh.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  authApi, clearSession, getStoredUser, getToken, onSessionEnded, storeSession,
  type AuthUser,
} from '@/lib/authClient';
import { AuthContext } from '@/lib/authContext';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Start from the stored user so a reload does not flash the sign-in screen at
  // somebody who is already signed in. It is revalidated below.
  const [user, setUser] = useState<AuthUser | null>(() => (getToken() ? getStoredUser() : null));
  // Only "loading" when there is actually a token to check. Deriving it here
  // rather than defaulting to true and clearing it in the effect avoids a
  // needless second render for the signed-out case.
  const [isLoading, setIsLoading] = useState(() => Boolean(getToken()));

  // The HTTP layer tells us when the server has rejected the session — an
  // expired token, or an account deleted while it was open.
  useEffect(() => onSessionEnded(() => setUser(null)), []);

  // Confirm the stored token is still good. Without this a revoked or expired
  // session would look signed-in until the first data request happened to fail.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;

    authApi.me()
      .then(fresh => {
        if (cancelled) return;
        setUser(fresh);
        const token = getToken();
        if (token) storeSession(token, fresh);
      })
      .catch(() => {
        if (cancelled) return;
        // 401 already cleared the session via the interceptor; a 403 (awaiting
        // approval) means signed in but not usable — either way, back to the
        // sign-in screen, which explains the pending case.
        clearSession();
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await authApi.login(email, password);
    if (!result.token) throw new Error('The server did not return a session token');
    storeSession(result.token, result.user);
    setUser(result.user);
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const result = await authApi.register(name, email, password);
    // Only the first account comes back with a token; everyone else waits for
    // approval, so there is no session to establish yet.
    if (result.token) {
      storeSession(result.token, result.user);
      setUser(result.user);
    }
    return result;
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, signIn, register, signOut }),
    [user, isLoading, signIn, register, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
