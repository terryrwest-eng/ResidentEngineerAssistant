/**
 * Daily Reporter V3 — Email Summary Dialog
 *
 * Generates a unified narrative summary from all activity summaries.
 * The output is paragraph-form text ready to paste into an email.
 *
 * Features:
 * - One-click generation from all activities
 * - Copy to clipboard
 * - Regenerate if not satisfied
 */

import { useState } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { scanApi } from '@/lib/api';
import { X, Copy, Check, RefreshCw, Mail, Sparkles } from 'lucide-react';

export function EmailSummaryDialog({ onClose }: { onClose: () => void }) {
  const { report } = useReportStore();
  const [summaryText, setSummaryText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState('');

  const activities = report?.activities || [];
  const projectName = report?.general?.project_name || '';
  const reportDate = report?.general?.report_date || '';

  const handleGenerate = async () => {
    if (activities.length === 0) return;

    setIsLoading(true);
    setError('');
    setSummaryText('');

    try {
      console.debug('[EmailSummary] Generating from', activities.length, 'activities');
      const result = await scanApi.emailSummary(
        activities as unknown as Record<string, unknown>[],
        projectName,
        reportDate,
      );
      setSummaryText(result.text);
      console.debug('[EmailSummary] Generated', result.text.length, 'chars');
    } catch (err) {
      console.error('[EmailSummary] Generation failed:', err);
      setError('Failed to generate summary. Check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
      console.debug('[EmailSummary] Copied to clipboard');
    } catch (err) {
      console.warn('[EmailSummary] Clipboard failed, using fallback:', err);
      // Fallback for mobile / insecure contexts
      const textarea = document.createElement('textarea');
      textarea.value = summaryText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  // Auto-generate on mount
  useState(() => {
    handleGenerate();
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.4)', backdropFilter: 'blur(4px)',
    }}>
      <div className="card" style={{
        width: '92%', maxWidth: '700px', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}>

        {/* ─── Header ─── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-sm) var(--space-md)',
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--surface)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <Mail style={{ color: 'var(--color-accent)' }} size={22} />
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', lineHeight: 1.2 }}>Email Summary</h3>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                All activities → one flowing narrative
              </span>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close email summary">
            <X size={20} />
          </button>
        </div>

        {/* ─── Content ─── */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: 'var(--space-md)',
          backgroundColor: 'var(--background)',
        }}>

          {/* Loading state */}
          {isLoading && (
            <div style={{
              textAlign: 'center', padding: 'var(--space-xl)',
              color: 'var(--text-secondary)',
            }}>
              <Sparkles
                size={32}
                style={{
                  color: 'var(--color-accent)', margin: '0 auto var(--space-md)',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
              <p style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                Generating email summary...
              </p>
              <p className="text-sm">
                Combining {activities.length} activit{activities.length === 1 ? 'y' : 'ies'} into one narrative
              </p>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div style={{
              padding: 'var(--space-md)',
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: 'var(--radius)',
              color: 'var(--color-danger)',
              fontSize: '0.9rem',
              marginBottom: 'var(--space-md)',
            }}>
              {error}
            </div>
          )}

          {/* Generated summary */}
          {summaryText && (
            <div style={{
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: 'var(--space-md)',
              fontSize: '0.9rem',
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
              color: 'var(--text)',
            }}>
              {summaryText}
            </div>
          )}
        </div>

        {/* ─── Footer ─── */}
        <div style={{
          padding: 'var(--space-sm) var(--space-md)',
          borderTop: '1px solid var(--border)',
          backgroundColor: 'var(--surface)',
          display: 'flex', gap: 'var(--space-sm)', justifyContent: 'flex-end',
        }}>
          <button
            className="btn btn-outline"
            onClick={handleGenerate}
            disabled={isLoading || activities.length === 0}
            style={{ fontSize: '0.85rem' }}
          >
            <RefreshCw size={16} style={isLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Regenerate
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCopy}
            disabled={!summaryText || isLoading}
            style={{ fontSize: '0.85rem' }}
          >
            {isCopied ? <Check size={16} /> : <Copy size={16} />}
            {isCopied ? 'Copied!' : 'Copy to Clipboard'}
          </button>
        </div>
      </div>
    </div>
  );
}
