/**
 * Daily Reporter V3 — Duplicate Date Warning
 *
 * Shown when the server refused to create this report because one already
 * exists for the same date and project.
 *
 * Nothing has been written at this point and nothing is thrown away. The report
 * you are looking at is still here, in memory, exactly as you left it — the
 * only thing that has stopped is auto-saving. You choose what happens next.
 *
 * The app must never pick for you: silently updating the existing report would
 * replace a finished day's work with whatever is on screen.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReportStore } from '@/stores/reportStore';
import { AlertTriangle, FolderOpen, Copy, Loader2 } from 'lucide-react';

function formatDate(d: string): string {
  if (!d) return 'this date';
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[parseInt(parts[1]) - 1]} ${parseInt(parts[2])}, ${parts[0]}`;
}

export function DuplicateDateWarning() {
  const navigate = useNavigate();
  const { duplicateConflict, openConflictingReport, keepBothReports } = useReportStore();
  const [busy, setBusy] = useState<'open' | 'both' | null>(null);

  if (!duplicateConflict) return null;

  const { existingId, reportDate, projectName } = duplicateConflict;

  async function handleOpen() {
    setBusy('open');
    await openConflictingReport();
    navigate(`/report/${existingId}`, { replace: true });
    setBusy(null);
  }

  async function handleKeepBoth() {
    setBusy('both');
    const newId = await keepBothReports();
    if (newId) navigate(`/report/${newId}`, { replace: true });
    setBusy(null);
  }

  return (
    <div
      id="duplicate-date-warning"
      style={{
        border: '2px solid var(--color-warning, #f59e0b)',
        background: 'var(--color-warning-bg, #FFFBEB)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-md) var(--space-lg)',
        marginBottom: 'var(--space-lg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-sm)' }}>
        <AlertTriangle
          size={20}
          style={{ color: 'var(--color-warning, #f59e0b)', flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>
            A report already exists for {formatDate(reportDate)}
          </h3>
          <p style={{
            margin: 'var(--space-xs) 0 0',
            fontSize: '0.875rem',
            color: 'var(--color-text-secondary)',
          }}>
            {projectName
              ? <>There is already a saved report for {formatDate(reportDate)} on <strong>{projectName}</strong>.</>
              : <>There is already a saved report for {formatDate(reportDate)}.</>}
            {' '}This report has <strong>not</strong> been saved, and the existing
            one has <strong>not</strong> been changed. Auto-save is paused until
            you choose.
          </p>

          <div style={{
            display: 'flex',
            gap: 'var(--space-sm)',
            marginTop: 'var(--space-md)',
            flexWrap: 'wrap',
          }}>
            <button
              id="duplicate-open-existing"
              className="btn btn-primary btn-sm"
              onClick={handleOpen}
              disabled={busy !== null}
            >
              {busy === 'open'
                ? <><Loader2 size={14} className="spin" /> Opening...</>
                : <><FolderOpen size={14} /> Open the existing report</>}
            </button>
            <button
              id="duplicate-keep-both"
              className="btn btn-outline btn-sm"
              onClick={handleKeepBoth}
              disabled={busy !== null}
            >
              {busy === 'both'
                ? <><Loader2 size={14} className="spin" /> Saving...</>
                : <><Copy size={14} /> Keep both — save this separately</>}
            </button>
          </div>

          <p style={{
            margin: 'var(--space-sm) 0 0',
            fontSize: '0.75rem',
            color: 'var(--color-text-tertiary)',
          }}>
            Opening the existing report discards what you have typed here — it
            does not touch the saved report. Keeping both leaves two reports for
            this date.
          </p>
        </div>
      </div>
    </div>
  );
}
