/**
 * Daily Reporter V3 — Activity Gap Chips
 *
 * Shows the details an activity is missing.
 *
 * These are always advisory — they never block saving or submitting. A site can
 * genuinely have no equipment on it, and arguing with the app about that is
 * worse than the omission it is trying to prevent.
 */

import { findActivityGaps } from '@/lib/activityGaps';
import type { Activity } from '@/types';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

interface Props {
  activity: Activity;
  /** 'full' shows what to say for each gap; 'compact' is a single line of chips. */
  variant?: 'full' | 'compact';
  /** Show a green "nothing missing" state instead of rendering nothing. */
  showWhenComplete?: boolean;
}

export function ActivityGapChips({ activity, variant = 'compact', showWhenComplete = false }: Props) {
  const gaps = findActivityGaps(activity);

  if (gaps.length === 0) {
    if (!showWhenComplete) return null;
    return (
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '0.75rem',
        color: 'var(--color-success, #16a34a)',
      }}>
        <CheckCircle2 size={13} />
        Nothing missing
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        fontSize: '0.75rem',
        color: 'var(--color-warning, #b45309)',
      }}>
        <AlertTriangle size={13} style={{ flexShrink: 0 }} />
        <span>Didn't mention:</span>
        {gaps.map(g => (
          <span
            key={g.key}
            title={g.hint}
            style={{
              background: 'var(--color-warning-bg, #FFFBEB)',
              border: '1px solid var(--color-warning, #f59e0b)',
              borderRadius: '10px',
              padding: '0 7px',
              whiteSpace: 'nowrap',
            }}
          >
            {g.label}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div style={{
      border: '1px solid var(--color-warning, #f59e0b)',
      background: 'var(--color-warning-bg, #FFFBEB)',
      borderRadius: 'var(--radius-md)',
      padding: 'var(--space-sm) var(--space-md)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '0.8125rem',
        fontWeight: 600,
        color: 'var(--color-warning, #b45309)',
      }}>
        <AlertTriangle size={14} />
        {gaps.length} detail{gaps.length === 1 ? '' : 's'} not mentioned
      </div>
      <ul style={{
        margin: 'var(--space-xs) 0 0',
        paddingLeft: '1.15rem',
        fontSize: '0.8125rem',
        color: 'var(--color-text-secondary)',
      }}>
        {gaps.map(g => (
          <li key={g.key} style={{ marginTop: 2 }}>
            <strong>{g.label}</strong> — {g.hint}
          </li>
        ))}
      </ul>
    </div>
  );
}
