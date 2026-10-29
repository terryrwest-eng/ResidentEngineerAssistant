/**
 * Daily Reporter V3 — what the interview captured
 *
 * WHY THIS EXISTS: on a format with no repeating section — Tecolote — the
 * answers are the report. They were saved correctly and printed correctly in
 * the Word export, but the editor shows activities, and Tecolote produces none.
 * So finishing the interview landed on an empty screen. The data was fine and
 * the app gave no sign of it, which from the outside is identical to losing it.
 *
 * Everything answered is shown here under the section it prints in, with the
 * empty ones stated plainly rather than left out — the same rule the export
 * follows, so this screen and the document say the same thing.
 */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Mic, FileText } from 'lucide-react';
import { interviewApi, type InterviewProfile } from '@/lib/interviewApi';

interface InterviewSummaryProps {
  profileKey: string;
  answers: Record<string, string>;
  /** Opens the interview at a specific question. */
  onEdit: (questionId: string) => void;
}

export function InterviewSummary({ profileKey, answers, onEdit }: InterviewSummaryProps) {
  const [profile, setProfile] = useState<InterviewProfile | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    interviewApi.profile(profileKey)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch((err) => console.error('[InterviewSummary] Could not load the format:', err));
    return () => { cancelled = true; };
  }, [profileKey]);

  if (!profile) return null;

  const answeredCount = Object.values(answers).filter((v) => (v || '').trim()).length;
  if (!answeredCount) return null;

  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      marginBottom: 'var(--space-md)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '8px 12px', background: 'var(--color-surface-active)',
          fontSize: '0.8125rem', fontWeight: 600, border: 'none',
          cursor: 'pointer', textAlign: 'left', color: 'inherit',
        }}
      >
        <FileText size={14} />
        <span style={{ flex: 1 }}>
          Interview answers ({answeredCount} answered)
        </span>
        <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)', fontSize: '0.75rem' }}>
          {expanded ? 'Hide raw answers' : 'Review or edit answers'}
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {expanded && profile.sections.filter((s) => s.number > 0).map((section) => {
        const rows = section.questions
          .filter((q) => q.kind !== 'yesno')
          .flatMap((q) => {
            const entries: { key: string; q: typeof q; value: string; passLabel?: string }[] = [];
            const v1 = (answers[q.id] || '').trim();
            if (v1) entries.push({ key: q.id, q, value: v1 });
            if (section.repeats) {
              for (let p = 2; p <= 30; p++) {
                const k = `${q.id}#${p}`;
                const vp = (answers[k] || '').trim();
                if (vp) entries.push({ key: k, q, value: vp, passLabel: `#${p}` });
              }
            }
            return entries;
          });

        return (
          <div key={section.id} style={{ borderTop: '1px solid var(--color-border)' }}>
            <div style={{
              padding: '6px 12px', fontSize: '0.6875rem', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.03em',
              color: 'var(--color-text-tertiary)',
            }}>
              {section.number}. {section.title}
            </div>

            {rows.length === 0 ? (
              <div style={{
                padding: '0 12px 8px', fontSize: '0.75rem',
                color: 'var(--color-text-tertiary)', fontStyle: 'italic',
              }}>
                {section.empty_statement}
              </div>
            ) : rows.map(({ key, q, value, passLabel }) => (
              <button
                key={key}
                onClick={() => onEdit(key)}
                title="Answer this one again"
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                  padding: '5px 12px 7px', textAlign: 'left', border: 'none',
                  background: 'transparent', cursor: 'pointer', fontSize: '0.8125rem',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  {(q.print_label || passLabel) && (
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {q.print_label || q.id}{passLabel ? ` (${passLabel})` : ''}:{' '}
                    </span>
                  )}
                  <span style={{ whiteSpace: 'pre-wrap' }}>{value}</span>
                </span>
                <Mic size={11} style={{ flexShrink: 0, marginTop: 4, opacity: 0.35 }} />
                <ChevronRight size={12} style={{ flexShrink: 0, marginTop: 3, opacity: 0.35 }} />
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
