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
import { ChevronRight, Mic, FileText } from 'lucide-react';
import { interviewApi, type InterviewProfile } from '@/lib/interviewApi';

interface InterviewSummaryProps {
  profileKey: string;
  answers: Record<string, string>;
  /** Opens the interview at a specific question. */
  onEdit: (questionId: string) => void;
}

export function InterviewSummary({ profileKey, answers, onEdit }: InterviewSummaryProps) {
  const [profile, setProfile] = useState<InterviewProfile | null>(null);

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
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', background: 'var(--color-surface-active)',
        fontSize: '0.8125rem', fontWeight: 600,
      }}>
        <FileText size={14} />
        <span style={{ flex: 1 }}>{profile.title}</span>
        <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)', fontSize: '0.75rem' }}>
          {answeredCount} answered
        </span>
      </div>

      {profile.sections.map((section) => {
        const rows = section.questions
          .filter((q) => q.kind !== 'yesno')
          .map((q) => ({ q, value: (answers[q.id] || '').trim() }))
          .filter((r) => r.value);

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
            ) : rows.map(({ q, value }) => (
              <button
                key={q.id}
                onClick={() => onEdit(q.id)}
                title="Answer this one again"
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                  padding: '5px 12px 7px', textAlign: 'left', border: 'none',
                  background: 'transparent', cursor: 'pointer', fontSize: '0.8125rem',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  {q.print_label && (
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {q.print_label}:{' '}
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
