/**
 * Daily Reporter V3 — Confirm & Toast
 *
 * Replaces the last of the raw browser dialogs.
 *
 * WHY IT MATTERS BEYOND LOOKS: window.confirm and window.prompt are blocking,
 * unstyled, and on Android WebView they render as a bare system dialog with the
 * page's hostname in it — which is exactly what makes an app feel like a web
 * page in a wrapper. They also cannot be themed, so in dark mode they flash a
 * white box.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (!await confirm({ title: 'Delete 3 rows?', danger: true })) return;
 *
 *   const toast = useToast();
 *   toast('Settings saved');
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { Sheet } from '@/components/ui/Sheet';

// ── Confirm ──────────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

// ── Toast ────────────────────────────────────────────────────────────────────

export type ToastKind = 'ok' | 'err' | 'info';
type ToastFn = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const TOAST_ICON: Record<ToastKind, typeof Check> = {
  ok: Check,
  err: AlertTriangle,
  info: Info,
};

const TOAST_COLOR: Record<ToastKind, string> = {
  ok: 'var(--color-success)',
  err: 'var(--color-danger)',
  info: 'var(--color-accent)',
};

// ── Provider ─────────────────────────────────────────────────────────────────

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const confirm = useCallback<ConfirmFn>((options) => {
    setRequest(options);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = useCallback((value: boolean) => {
    setRequest(null);
    resolver.current?.(value);
    resolver.current = null;
  }, []);

  const toast = useCallback<ToastFn>((message, kind = 'ok') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  }, []);

  const confirmValue = useMemo(() => confirm, [confirm]);
  const toastValue = useMemo(() => toast, [toast]);

  return (
    <ConfirmContext.Provider value={confirmValue}>
      <ToastContext.Provider value={toastValue}>
        {children}

        <Sheet
          open={request !== null}
          onClose={() => settle(false)}
          title={request?.title ?? ''}
          icon={<AlertTriangle size={18} />}
          closeOnEscape
          maxWidth={460}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => settle(false)}>
                {request?.cancelLabel ?? 'Cancel'}
              </button>
              <button
                className={`btn ${request?.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => settle(true)}
                style={request?.danger
                  ? { background: 'var(--color-danger)', borderColor: 'var(--color-danger)', color: '#fff' }
                  : undefined}
              >
                {request?.confirmLabel ?? 'Confirm'}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: '0.9375rem', color: 'var(--color-text-secondary)' }}>
            {request?.message ?? 'This cannot be undone.'}
          </p>
        </Sheet>

        {/* Toast stack — above the bottom nav, out of the thumb's way */}
        <div style={{
          position: 'fixed',
          bottom: 84,
          right: 'max(16px, env(safe-area-inset-right))',
          left: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-sm)',
          zIndex: 120,
          pointerEvents: 'none',
        }}>
          {toasts.map((item) => {
            const Icon = TOAST_ICON[item.kind];
            return (
              <div
                key={item.id}
                role="status"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  maxWidth: 380,
                  padding: '12px 16px',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderLeft: `3px solid ${TOAST_COLOR[item.kind]}`,
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-lg)',
                  fontSize: '0.875rem',
                  color: 'var(--color-text-primary)',
                  animation: 'toast-in 0.2s ease-out',
                  pointerEvents: 'auto',
                }}
              >
                <Icon size={16} style={{ color: TOAST_COLOR[item.kind], flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{item.message}</span>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => setToasts((prev) => prev.filter((t) => t.id !== item.id))}
                  aria-label="Dismiss"
                  style={{ flexShrink: 0, width: 24, height: 24 }}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}
