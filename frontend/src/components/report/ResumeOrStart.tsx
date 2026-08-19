/**
 * Daily Reporter V3 — Resume today's report, or start a new one
 *
 * Shown before the project picker whenever a report already exists for today.
 *
 * WHY: a report is written most days, so picking a project on a day already
 * started used to fire the first auto-save straight into the duplicate-date
 * guard. The guard was right — it refused to overwrite a finished day — but
 * being told "a report already exists" AFTER choosing a project is answering a
 * question the app could have asked first.
 *
 * Checking up front turns a refusal into an offer: carry on with what is
 * already there, or deliberately start another one.
 */

import { useEffect, useState } from 'react';
import { FileText, Plus, Loader2, Clock } from 'lucide-react';
import { reportApi } from '@/lib/api';

export interface ExistingReport {
  id: string;
  report_date: string;
  project_name: string;
  activity_count?: number;
  updated_at?: string;
}

interface ResumeOrStartProps {
  reportDate: string;
  onResume: (report: ExistingReport) => void;
  onStartNew: () => void;
}

/**
 * Look for reports already written for a date.
 *
 * Returns [] on failure rather than throwing: a lookup that cannot run must
 * not stop a new report being written, and the duplicate guard on the server
 * is still there as the real protection.
 */
export async function findReportsForDate(reportDate: string): Promise<ExistingReport[]> {
  if (!reportDate) return [];
  try {
    const data = await reportApi.list({ date_from: reportDate, date_to: reportDate, limit: 10 });
    return (data?.reports || []) as ExistingReport[];
  } catch (err) {
    console.warn('[ResumeOrStart] Could not check for existing reports:', err);
    return [];
  }
}

export function ResumeOrStart({ reportDate, onResume, onStartNew }: ResumeOrStartProps) {
  const [existing, setExisting] = useState<ExistingReport[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    findReportsForDate(reportDate).then((found) => {
      if (cancelled) return;
      // Nothing for today — go straight to the picker rather than showing a
      // screen whose only option is "start a new one".
      if (!found.length) { onStartNew(); return; }
      setExisting(found);
    });
    return () => { cancelled = true; };
  }, [reportDate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!existing) {
    return (
      <div style={wrap}>
        <Loader2 size={18} className="spin" /> Checking today…
      </div>
    );
  }

  return (
    <div style={wrap}>
      <h2 style={{ margin: '0 0 4px', fontSize: '1.375rem' }}>
        You already started {existing.length === 1 ? 'a report' : 'reports'} today
      </h2>
      <p style={{ margin: '0 0 var(--space-lg)', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
        Carry on with it and add to it, or start another one.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {existing.map((r) => (
          <button
            key={r.id}
            className="btn"
            onClick={() => onResume(r)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              padding: 'var(--space-md)', textAlign: 'left',
              border: '1px solid var(--color-success)',
              background: 'var(--color-success-light, #F0FDF4)',
            }}
          >
            <FileText size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600 }}>
                Continue {r.project_name || 'today’s report'}
              </span>
              <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                {typeof r.activity_count === 'number'
                  ? `${r.activity_count} ${r.activity_count === 1 ? 'activity' : 'activities'} so far`
                  : 'Open and keep going'}
              </span>
            </span>
            <Clock size={14} style={{ flexShrink: 0, marginTop: 3, opacity: 0.5 }} />
          </button>
        ))}

        <button
          className="btn btn-secondary"
          onClick={onStartNew}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: 'var(--space-md)', textAlign: 'left',
          }}
        >
          <Plus size={16} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontWeight: 600 }}>Start another report</span>
            <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
              A second report for today — a split shift, or the other project.
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  maxWidth: 520, margin: '0 auto', padding: 'var(--space-lg)',
};
