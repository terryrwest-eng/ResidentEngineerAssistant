/**
 * Daily Reporter — Sign in / create an account.
 *
 * Shown whenever there is no session. Three states:
 *   - nobody has registered yet → "set up this app", and that account becomes
 *     the administrator
 *   - signing in
 *   - registering, which ends in "waiting for approval" rather than a session
 */

import { useEffect, useState } from 'react';
import { HardHat, Loader2, LogIn, UserPlus, Clock } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { authApi, authErrorMessage } from '@/lib/authClient';

type Mode = 'signin' | 'register';

export function SignInPage() {
  const { signIn, register } = useAuth();

  const [mode, setMode] = useState<Mode>('signin');
  const [needsFirstUser, setNeedsFirstUser] = useState<boolean | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Set when a registration succeeded but still needs an administrator. */
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [adopted, setAdopted] = useState<number | null>(null);

  // An unclaimed app opens straight into "create the first account" — there is
  // nothing to sign in to yet, and offering a sign-in form would be a dead end.
  useEffect(() => {
    authApi.setupState()
      .then(state => {
        setNeedsFirstUser(state.needs_first_user);
        if (state.needs_first_user) setMode('register');
      })
      .catch(() => setNeedsFirstUser(false));
  }, []);

  const isFirstUser = needsFirstUser === true;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const result = await register(name.trim(), email.trim(), password);
        if (result.token) {
          // First account — signed in already. Say what was adopted, so a
          // migration that moved existing reports is visible rather than silent.
          setAdopted(result.migrated?.length ?? 0);
        } else {
          setAwaitingApproval(true);
        }
      }
    } catch (err) {
      setError(authErrorMessage(
        err,
        mode === 'signin'
          ? 'Could not sign in — check your connection and try again'
          : 'Could not create the account — check your connection and try again',
      ));
    } finally {
      setBusy(false);
    }
  };

  if (awaitingApproval) {
    return (
      <Shell>
        <div style={{ textAlign: 'center' }}>
          <Clock size={40} style={{ color: 'var(--color-accent)' }} />
          <h2 style={{ margin: 'var(--space-sm) 0' }}>Account created</h2>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            An administrator needs to approve it before you can sign in. You will
            not be able to get in until they do.
          </p>
          <button
            className="btn btn-outline"
            style={{ marginTop: 'var(--space-md)' }}
            onClick={() => { setAwaitingApproval(false); setMode('signin'); setPassword(''); }}
          >
            Back to sign in
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ textAlign: 'center', marginBottom: 'var(--space-lg)' }}>
        <HardHat size={40} style={{ color: 'var(--color-accent)' }} />
        <h1 style={{ fontSize: '1.4rem', margin: 'var(--space-xs) 0 0' }}>
          RE Report Assistant
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
          {isFirstUser
            ? 'Set up this app — your account becomes the administrator'
            : mode === 'signin' ? 'Sign in to your reports' : 'Create an account'}
        </p>
      </div>

      {adopted !== null && adopted > 0 && (
        <p style={{
          fontSize: '0.8rem', color: 'var(--color-success, #16a34a)',
          marginBottom: 'var(--space-sm)',
        }}>
          Adopted {adopted} existing item{adopted === 1 ? '' : 's'} into your account.
        </p>
      )}

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        {mode === 'register' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Name</span>
            <input
              className="input" type="text" value={name} autoComplete="name"
              onChange={e => setName(e.target.value)} required disabled={busy}
            />
          </label>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Email</span>
          <input
            className="input" type="email" value={email} autoComplete="email"
            onChange={e => setEmail(e.target.value)} required disabled={busy}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Password</span>
          <input
            className="input" type="password" value={password}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            onChange={e => setPassword(e.target.value)} required disabled={busy}
          />
          {mode === 'register' && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              At least 8 characters.
            </span>
          )}
        </label>

        {error && (
          <p style={{ color: 'var(--color-danger, #ef4444)', fontSize: '0.8rem', margin: 0 }}>
            {error}
          </p>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy}
                style={{ marginTop: 'var(--space-xs)' }}>
          {busy ? <Loader2 size={16} className="spin" />
                : mode === 'signin' ? <LogIn size={16} /> : <UserPlus size={16} />}
          {busy ? 'Working…'
                : mode === 'signin' ? 'Sign in'
                : isFirstUser ? 'Create administrator account' : 'Create account'}
        </button>
      </form>

      {/* An unclaimed app has nothing to sign in to, so the toggle is hidden. */}
      {!isFirstUser && (
        <button
          className="btn btn-ghost"
          style={{ marginTop: 'var(--space-sm)', width: '100%', fontSize: '0.85rem' }}
          onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setError(''); }}
          disabled={busy}
        >
          {mode === 'signin'
            ? 'Need an account? Create one'
            : 'Already have an account? Sign in'}
        </button>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 'var(--space-md)',
      backgroundColor: 'var(--background)',
    }}>
      <div style={{
        width: '100%', maxWidth: '380px', padding: 'var(--space-lg)',
        backgroundColor: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
      }}>
        {children}
      </div>
    </div>
  );
}
