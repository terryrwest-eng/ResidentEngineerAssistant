/**
 * Daily Reporter — People (admin only).
 *
 * The approval queue. New registrations land here unapproved and cannot sign in
 * until someone acts, so this is the screen that lets anyone else in at all.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Shield, Trash2, UserX, Users } from 'lucide-react';
import { authApi, authErrorMessage, type AuthUser } from '@/lib/authClient';
import { useAuth } from '@/lib/authContext';
import { useConfirm, useToast } from '@/components/ui/ConfirmProvider';

export function UsersPage() {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();

  const [users, setUsers] = useState<AuthUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  /** Re-fetch after an action. isLoading is already false by then. */
  const load = useCallback(
    () =>
      authApi.listUsers()
        .then(list => { setUsers(list); setError(''); })
        .catch(err => setError(authErrorMessage(err, 'Could not load the list of people'))),
    [],
  );

  // The first fetch is inline rather than a call to load(), so every setState
  // here happens in a promise callback. isLoading starts true, so there is
  // nothing to set on the way in.
  useEffect(() => {
    let cancelled = false;
    authApi.listUsers()
      .then(list => { if (!cancelled) { setUsers(list); setError(''); } })
      .catch(err => {
        if (!cancelled) setError(authErrorMessage(err, 'Could not load the list of people'));
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const act = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      toast(label);
      load();
    } catch (err) {
      toast(authErrorMessage(err, 'That did not work'), 'err');
    } finally {
      setBusyId('');
    }
  };

  if (me?.role !== 'admin') {
    return (
      <div className="empty-state" style={{ paddingTop: 'var(--space-2xl)' }}>
        <Shield size={40} style={{ color: 'var(--text-secondary)' }} />
        <h3 style={{ marginTop: 'var(--space-md)' }}>Administrators only</h3>
        <p>Ask an administrator if you need access to this.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="empty-state" style={{ paddingTop: 'var(--space-2xl)' }}>
        <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
        <p style={{ marginTop: 'var(--space-md)' }}>Loading…</p>
      </div>
    );
  }

  const waiting = users.filter(u => !u.is_approved);
  const active = users.filter(u => u.is_approved);

  return (
    <div style={{ padding: 'var(--space-md)' }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
        <Users size={20} /> People
      </h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        Everyone keeps their own reports, settings and trackers. Nobody can see
        anyone else's.
      </p>

      {error && (
        <p style={{ color: 'var(--color-danger, #ef4444)', fontSize: '0.85rem' }}>{error}</p>
      )}

      {waiting.length > 0 && (
        <section style={{ marginTop: 'var(--space-lg)' }}>
          <h3 style={{ fontSize: '0.95rem' }}>
            Waiting for approval ({waiting.length})
          </h3>
          {waiting.map(u => (
            <Row key={u.id} user={u} busy={busyId === u.id}>
              <button
                className="btn btn-primary" style={{ fontSize: '0.8rem' }}
                disabled={busyId === u.id}
                onClick={() => act(u.id, `${u.name} can now sign in`, () => authApi.approve(u.id))}
              >
                <Check size={14} /> Approve
              </button>
              <button
                className="btn btn-outline" style={{ fontSize: '0.8rem' }}
                disabled={busyId === u.id}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete ${u.name}'s account?`,
                    message: 'Their account is removed. Any data they created stays on the server.',
                    confirmLabel: 'Delete',
                    danger: true,
                  });
                  if (ok) act(u.id, 'Account deleted', () => authApi.remove(u.id));
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
            </Row>
          ))}
        </section>
      )}

      <section style={{ marginTop: 'var(--space-lg)' }}>
        <h3 style={{ fontSize: '0.95rem' }}>Active ({active.length})</h3>
        {active.map(u => (
          <Row key={u.id} user={u} busy={busyId === u.id} isMe={u.id === me?.id}>
            {u.id !== me?.id && (
              <>
                <button
                  className="btn btn-outline" style={{ fontSize: '0.8rem' }}
                  disabled={busyId === u.id}
                  onClick={() => act(
                    u.id,
                    u.role === 'admin' ? `${u.name} is no longer an administrator`
                                       : `${u.name} is now an administrator`,
                    () => authApi.setRole(u.id, u.role === 'admin' ? 'user' : 'admin'),
                  )}
                >
                  <Shield size={14} /> {u.role === 'admin' ? 'Remove admin' : 'Make admin'}
                </button>
                <button
                  className="btn btn-outline" style={{ fontSize: '0.8rem' }}
                  disabled={busyId === u.id}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Revoke ${u.name}'s access?`,
                      message: 'They are signed out immediately and cannot sign in again until approved. Their reports are kept.',
                      confirmLabel: 'Revoke',
                      danger: true,
                    });
                    if (ok) act(u.id, 'Access revoked', () => authApi.revoke(u.id));
                  }}
                >
                  <UserX size={14} /> Revoke
                </button>
              </>
            )}
          </Row>
        ))}
      </section>
    </div>
  );
}

function Row({ user, busy, isMe, children }: {
  user: AuthUser; busy: boolean; isMe?: boolean; children?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
      flexWrap: 'wrap', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      backgroundColor: 'var(--surface)',
    }}>
      <div style={{ flex: 1, minWidth: '160px' }}>
        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
          {user.name}
          {isMe && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>(you)</span>
          )}
          {user.role === 'admin' && (
            <span style={{
              fontSize: '0.65rem', padding: '1px 6px', borderRadius: '10px',
              backgroundColor: 'var(--color-accent)', color: 'white',
            }}>
              admin
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{user.email}</div>
      </div>
      {busy ? <Loader2 size={16} className="spin" /> : children}
    </div>
  );
}
