/**
 * Daily Reporter V3 — read the report before it becomes a Word file
 *
 * Shows exactly what the document will say, built by the same code that builds
 * the document. A preview rendered separately drifts from the real output the
 * first time either changes, and the drift stays invisible until someone
 * compares a printed report against the screen it was approved on.
 *
 * The point is to read the writing — the wording, the order, what is missing —
 * while it can still be fixed by answering a question again.
 */

import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, AlertCircle, FileText, RefreshCw } from 'lucide-react';
import api from '@/lib/api';

interface PreviewSection {
  number: number;
  title: string;
  lines: string[];
  /** Nothing was reported here — shown greyed so it is not mistaken for
   *  content, and not mistaken for a section nobody filled in either. */
  is_empty: boolean;
}

interface PreviewData {
  title: string;
  header: { label: string; value: string }[];
  sections: PreviewSection[];
}

interface ReportPreviewProps {
  reportId: string;
  /** Saves first, so the preview reflects what was just typed rather than the
   *  last thing written to disk. */
  onBeforeOpen?: () => Promise<unknown>;
  onClose: () => void;
}

export function ReportPreview({ reportId, onBeforeOpen, onClose }: ReportPreviewProps) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (onBeforeOpen) await onBeforeOpen();
      const res = await api.get(`/export/${reportId}/preview`);
      setData(res.data);
    } catch (err) {
      console.error('[ReportPreview] Could not build the preview:', err);
      const httpErr = err as { response?: { data?: { detail?: string } } };
      setError(httpErr?.response?.data?.detail
        || (err instanceof Error ? err.message : 'Could not build the preview.'));
    } finally {
      setBusy(false);
    }
  }, [reportId, onBeforeOpen]);

  useEffect(() => { load(); }, [load]);

  const emptyCount = (data?.sections || []).filter((s) => s.is_empty).length;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 'var(--space-md)', overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)', borderRadius: 'var(--radius-md)',
          maxWidth: 760, width: '100%', margin: '0 auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', borderBottom: '1px solid var(--color-border)',
          position: 'sticky', top: 0, background: 'var(--color-surface)',
          borderTopLeftRadius: 'var(--radius-md)', borderTopRightRadius: 'var(--radius-md)',
        }}>
          <FileText size={16} />
          <strong style={{ flex: 1, fontSize: '0.9375rem' }}>
            {data?.title || 'Report preview'}
          </strong>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={busy} title="Rebuild from the latest saved report">
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div style={{ padding: 'var(--space-lg)' }}>
          {busy && !data && (
            <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              <Loader2 size={16} className="spin" /> Building the report…
            </p>
          )}

          {error && (
            <div style={{
              display: 'flex', gap: 8, padding: '10px 12px',
              background: 'var(--color-danger-bg, #FEF2F2)', color: 'var(--color-danger)',
              borderRadius: 'var(--radius-sm)', fontSize: '0.8125rem',
            }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}

          {data && (
            <>
              {data.header.map((h) => (
                <p key={h.label} style={{ margin: '0 0 2px', fontSize: '0.875rem' }}>
                  <strong>{h.label}:</strong> {h.value || <em style={{ opacity: 0.5 }}>not set</em>}
                </p>
              ))}

              {data.sections.map((s) => (
                <div key={`${s.number}-${s.title}`} style={{ marginTop: 'var(--space-lg)' }}>
                  <h3 style={{ margin: '0 0 6px', fontSize: '0.9375rem' }}>
                    {s.number ? `${s.number}. ` : ''}{s.title}
                  </h3>
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {s.lines.map((line, i) => (
                      <li
                        key={i}
                        style={{
                          fontSize: '0.875rem', lineHeight: 1.5, marginBottom: 3,
                          // Greyed when the section had nothing: it is a
                          // statement that nothing happened, not content.
                          color: s.is_empty ? 'var(--color-text-tertiary)' : 'inherit',
                          fontStyle: s.is_empty ? 'italic' : 'normal',
                        }}
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              {emptyCount > 0 && (
                <p style={{
                  marginTop: 'var(--space-lg)', paddingTop: 'var(--space-sm)',
                  borderTop: '1px solid var(--color-border)',
                  fontSize: '0.75rem', color: 'var(--color-text-tertiary)',
                }}>
                  {emptyCount} {emptyCount === 1 ? 'section has' : 'sections have'} nothing
                  reported. They print with the sentence shown, so the reader can
                  see the topic was considered.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
