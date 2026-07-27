/**
 * Daily Reporter V3 — Theme switch
 *
 * Light / Dark / Auto, in the header rather than buried in Settings: the moment
 * you want it is the moment the sun goes down mid-shift, and that is not a
 * moment to go hunting through a settings page with one gloved hand.
 */

import { useEffect, useRef, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { getThemeMode, onThemeChange, setThemeMode, type ThemeMode } from '@/lib/theme';

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
  { mode: 'auto', label: 'Auto', icon: Monitor },
];

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => onThemeChange((next) => setMode(next)), []);

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = OPTIONS.find((o) => o.mode === mode) ?? OPTIONS[0];
  const CurrentIcon = current.icon;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Theme: ${current.label}`}
        aria-label={`Theme: ${current.label}. Change theme.`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          border: '1px solid transparent',
          borderRadius: 'var(--radius-md)',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
          transition: 'background 0.15s ease, color 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-surface-hover)';
          e.currentTarget.style.color = 'var(--color-text-primary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--color-text-secondary)';
        }}
      >
        <CurrentIcon size={17} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 148,
            padding: 'var(--space-xs)',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 200,
          }}
        >
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = option.mode === mode;
            return (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { setThemeMode(option.mode); setOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  width: '100%',
                  minHeight: 40,
                  padding: '0 var(--space-sm)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  background: active ? 'var(--color-accent-light)' : 'transparent',
                  color: active ? 'var(--color-accent)' : 'var(--color-text-primary)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '0.875rem',
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Icon size={16} />
                {option.label}
                {option.mode === 'auto' && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: '0.6875rem',
                    color: 'var(--color-text-tertiary)',
                  }}>
                    system
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
