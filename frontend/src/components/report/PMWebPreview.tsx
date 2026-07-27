/**
 * Daily Reporter V3 — PMWeb Combined Preview Panel
 *
 * Shows the full 11-column PMWeb resource table that feeds the Chrome extension.
 * Title: "Combined Resource Table" (NOT "Consolidated" — user confirmed this naming).
 *
 * Columns: Resource | Pay Type | Classification | Specialist | Remarks |
 * Subcontractor | Qty | Company | Hours | Start | Finish
 *
 * Actions:
 * - Copy Table → clipboard (tab-delimited, paste into PMWeb manually)
 * - Auto-Fill PMWeb → sends to Chrome extension for Telerik grid injection
 */

import { useState, useEffect } from 'react';
import {
  ClipboardList,
  X,
  Copy,
  Rocket,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { reportApi } from '@/lib/api';

interface PMWebRow {
  resource: string;
  pay_type: string;
  classification: string;
  specialist: boolean;
  remarks: string;
  subcontractor: boolean;
  qty: number;
  company: string;
  total_hours: number;
  start_time: string;
  finish_time: string;
}

interface PMWebPreviewProps {
  reportId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function PMWebPreview({ reportId, isOpen, onClose }: PMWebPreviewProps) {
  const [rows, setRows] = useState<PMWebRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Load PMWeb data when panel opens
  useEffect(() => {
    if (!isOpen || !reportId) return;

    setIsLoading(true);
    setLoadError(null);

    reportApi.getPMWebCombined(reportId)
      .then((data) => {
        setRows(data.rows || []);
        setIsLoading(false);
        console.debug(`[PMWebPreview] Loaded ${data.rows?.length ?? 0} rows`);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : 'Failed to load PMWeb data';
        setLoadError(msg);
        setIsLoading(false);
        console.error('[PMWebPreview] Load error:', err);
      });
  }, [isOpen, reportId]);

  // Also notify the Chrome extension of the active report
  useEffect(() => {
    if (!isOpen || !reportId) return;
    reportApi.setExtensionContext(reportId).catch(() => {
      // Extension may not be installed — silent fail
    });
  }, [isOpen, reportId]);

  if (!isOpen) return null;

  const totalRows = rows.length;

  function handleCopyTable() {
    const header = [
      'Resource', 'Pay Type', 'Classification', 'Specialist', 'Remarks',
      'Subcontractor', 'Qty', 'Company', 'Hours', 'Start', 'Finish'
    ].join('\t');

    const body = rows.map((r) => [
      r.resource,
      r.pay_type,
      r.classification,
      r.specialist ? 'Yes' : 'No',
      r.remarks || '',
      r.subcontractor ? 'Yes' : 'No',
      r.qty,
      r.company,
      r.total_hours,
      r.start_time || '7:00 AM',
      r.finish_time || '3:30 PM',
    ].join('\t')).join('\n');

    navigator.clipboard.writeText(`${header}\n${body}`).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2500);
    });
  }

  async function handleAutoFill() {
    setIsLaunching(true);
    setLaunchError(null);

    const payload = rows.map((r) => ({
      'Resource': r.resource,
      'Pay Type': r.pay_type,
      'Classification': r.classification,
      'Specialist': r.specialist ? 'Yes' : 'No',
      'Remarks': r.remarks || '',
      'Subcontractor': r.subcontractor ? 'Yes' : 'No',
      'Qty': r.qty,
      'Company': r.company,
      'Hours': r.total_hours,
      'Start Time': r.start_time || '7:00 AM',
      'Finish Time': r.finish_time || '3:30 PM',
    }));

    try {
      await reportApi.launchPMWebAutomation(payload);
    } catch {
      setLaunchError('Auto-fill failed. Make sure the app is running locally.');
    } finally {
      setIsLaunching(false);
    }
  }

  return (
    <div className="dialog-overlay">
      <div
        className="dialog"
        style={{ maxWidth: '1000px', width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <div style={{
              width: '36px', height: '36px',
              background: 'var(--color-accent-light)',
              borderRadius: 'var(--radius-md)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ClipboardList size={20} style={{ color: 'var(--color-accent)' }} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1rem' }}>Combined Resource Table</h2>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                {totalRows} row{totalRows !== 1 ? 's' : ''} — ready for PMWeb injection
              </p>
            </div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Row count warning */}
        {totalRows > 0 && (
          <div style={{
            margin: 'var(--space-md) var(--space-lg) 0',
            padding: 'var(--space-sm) var(--space-md)',
            background: 'var(--color-warning-light)',
            border: '1px solid var(--color-warning)',
            borderRadius: 'var(--radius-md)',
            display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
            fontSize: '0.8125rem', color: 'var(--color-warning)',
          }}>
            <AlertTriangle size={14} />
            You need <strong style={{ margin: '0 4px' }}>{totalRows}</strong> empty rows in PMWeb before auto-filling.
          </div>
        )}

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-md) 0' }}>
          {isLoading ? (
            <div className="empty-state">
              <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
              <p style={{ marginTop: 'var(--space-md)' }}>Loading resource data...</p>
            </div>
          ) : loadError ? (
            <div className="empty-state">
              <AlertTriangle size={32} style={{ color: 'var(--color-danger)' }} />
              <p style={{ color: 'var(--color-danger)', marginTop: 'var(--space-sm)' }}>{loadError}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="empty-state">
              <ClipboardList size={32} />
              <p>No resources found. Add manpower or equipment to activities first.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: '900px', fontSize: '0.8125rem' }}>
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Pay Type</th>
                    <th>Classification</th>
                    <th style={{ textAlign: 'center' }}>Spec.</th>
                    <th>Remarks</th>
                    <th style={{ textAlign: 'center' }}>Sub.</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th>Company</th>
                    <th style={{ textAlign: 'right' }}>Hours</th>
                    <th>Start</th>
                    <th>Finish</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const isOT = row.classification === 'LO - Labor Overtime';
                    const isEW = row.pay_type === 'EW - Extra Work';
                    return (
                      <tr key={idx} style={{ fontWeight: isEW ? 600 : 400 }}>
                        <td style={{ fontWeight: 500 }}>{row.resource}</td>
                        <td>
                          {isEW ? (
                            <span style={{ color: 'var(--color-danger)' }}>EW - Extra Work</span>
                          ) : (
                            <span style={{ color: 'var(--color-success)' }}>CS - Cost</span>
                          )}
                        </td>
                        <td>
                          {isOT ? (
                            <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>LO - Labor Overtime</span>
                          ) : (
                            'LR - Labor Regular Time'
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {row.specialist && <CheckCircle2 size={14} style={{ color: 'var(--color-accent)' }} />}
                        </td>
                        <td style={{ fontStyle: row.remarks ? 'normal' : 'italic', color: row.remarks ? 'inherit' : 'var(--color-text-tertiary)' }}>
                          {row.remarks || '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {row.subcontractor && <CheckCircle2 size={14} style={{ color: 'var(--color-ai)' }} />}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.qty}</td>
                        <td>{row.company}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.total_hours}</td>
                        <td style={{ color: 'var(--color-text-secondary)' }}>{row.start_time || '7:00 AM'}</td>
                        <td style={{ color: 'var(--color-text-secondary)' }}>{row.finish_time || '3:30 PM'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="dialog-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <div style={{ display: 'flex', gap: 'var(--space-sm)', marginLeft: 'auto' }}>
            {/* Copy to clipboard */}
            <button
              className="btn btn-secondary"
              onClick={handleCopyTable}
              disabled={rows.length === 0}
            >
              {isCopied
                ? <><CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} /> Copied!</>
                : <><Copy size={16} /> Copy Table</>
              }
            </button>

            {/* Auto-fill Chrome extension */}
            <button
              className="btn btn-primary"
              onClick={handleAutoFill}
              disabled={rows.length === 0 || isLaunching}
              style={{ background: 'var(--color-success)', borderColor: 'var(--color-success)' }}
            >
              {isLaunching
                ? <><Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} /> Launching...</>
                : <><Rocket size={16} /> Auto-Fill PMWeb</>
              }
            </button>
          </div>
        </div>

        {launchError && (
          <div style={{
            padding: 'var(--space-sm) var(--space-lg)',
            fontSize: '0.8125rem',
            color: 'var(--color-danger)',
            background: 'var(--color-danger-light)',
            borderTop: '1px solid var(--color-danger-border)',
            display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
          }}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} /> {launchError}
          </div>
        )}
      </div>
    </div>
  );
}
