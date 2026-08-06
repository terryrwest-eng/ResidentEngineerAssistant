/**
 * The auth context and its hook, kept apart from the provider component.
 *
 * Split out because a module that exports both components and plain values
 * breaks React Fast Refresh — editing the provider would drop the app's state
 * instead of hot-reloading it.
 */

import { createContext, useContext } from 'react';
import type { AuthResult, AuthUser } from '@/lib/authClient';

export interface AuthState {
  user: AuthUser | null;
  /** True until the stored session has been checked against the server. */
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<AuthResult>;
  signOut: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
