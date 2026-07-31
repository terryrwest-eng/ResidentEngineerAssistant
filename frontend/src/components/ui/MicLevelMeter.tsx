/**
 * Daily Reporter V3 — microphone level meter
 *
 * The visual half of useMicLevel. Green bar that moves with your voice, red and
 * flat when nothing is reaching the mic, plus a line of text that says which of
 * those is happening — the bar alone reads as "quiet" rather than "broken".
 *
 * Usage:
 *   const mic = useMicLevel('report-chat');
 *   ...
 *   {isRecording && <MicLevelMeter {...mic} />}
 */

import type { CSSProperties } from 'react';
import { MIC_SILENCE_THRESHOLD } from '@/hooks/useMicLevel';

interface MicLevelMeterProps {
  /** Live level 0..1 from useMicLevel. */
  micLevel: number;
  /** Peak level from useMicLevel — decides the wording. */
  peakLevel: number;
  /** Compact drops the caption, for tight rows next to a record button. */
  compact?: boolean;
  style?: CSSProperties;
}

export function MicLevelMeter({ micLevel, peakLevel, compact = false, style }: MicLevelMeterProps) {
  const silent = peakLevel < MIC_SILENCE_THRESHOLD;

  return (
    <div style={{ width: '100%', maxWidth: '260px', ...style }}>
      <div
        role="meter"
        aria-label="Microphone input level"
        aria-valuenow={Math.round(micLevel * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: compact ? '6px' : '8px',
          background: 'var(--color-surface-active)',
          borderRadius: 'var(--radius-full)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.round(micLevel * 100)}%`,
            // Live level drives the colour so a mic that dies mid-take shows it.
            background: micLevel > MIC_SILENCE_THRESHOLD
              ? 'var(--color-success)'
              : 'var(--color-danger)',
            borderRadius: 'var(--radius-full)',
            transition: 'width 80ms linear',
          }}
        />
      </div>
      {!compact && (
        <p
          style={{
            marginTop: '6px',
            marginBottom: 0,
            fontSize: '0.6875rem',
            color: silent ? 'var(--color-danger)' : 'var(--color-text-tertiary)',
            fontWeight: silent ? 600 : 400,
          }}
        >
          {silent ? 'No sound detected — check your mic' : 'Mic is picking up sound'}
        </p>
      )}
    </div>
  );
}
