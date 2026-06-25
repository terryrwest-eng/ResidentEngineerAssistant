/**
 * Daily Reporter V3 — Parse Report Dialog
 *
 * Upload a completed .docx or .pdf daily report.
 * AI extracts all activities, manpower, equipment → creates a new draft report.
 *
 * Triggered from the Dashboard or New Report page.
 */

import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { scanApi } from '@/lib/api';
import {
  FileText,
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  ArrowRight,
} from 'lucide-react';

interface ParseReportDialogProps {
  onClose: () => void;
}

export function ParseReportDialog({ onClose }: ParseReportDialogProps) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    report_id: string;
    activity_count: number;
    project: string;
    original_date: string;
    message: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] || null;
    if (selected) {
      const ext = selected.name.split('.').pop()?.toLowerCase();
      if (ext !== 'pdf' && ext !== 'docx') {
        setError('Only .pdf and .docx files are supported.');
        return;
      }
      setFile(selected);
      setError(null);
      setResult(null);
    }
  }

  async function handleParse() {
    if (!file) return;

    setIsProcessing(true);
    setError(null);

    try {
      const data = await scanApi.parseReport(file);
      setResult(data);
      console.debug('[ParseReportDialog] Created report:', data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to parse report';
      setError(msg);
      console.error('[ParseReportDialog] Error:', err);
    } finally {
      setIsProcessing(false);
    }
  }

  function handleOpenReport() {
    if (result?.report_id) {
      onClose();
      navigate(`/report/${result.report_id}`);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'var(--color-surface)',
          borderRadius: 'var(--radius-lg)',
          width: '480px',
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 16px 48px rgba(0,0,0,0.15)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-lg)',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <FileText size={20} style={{ color: 'var(--color-accent)' }} />
            <h3 style={{ margin: 0 }}>Import Report</h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 'var(--space-lg)' }}>
          {!result ? (
            <>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--space-lg)' }}>
                Upload a completed daily report (.docx or .pdf). AI will extract all activities, manpower,
                and equipment into a new editable draft.
              </p>

              {/* Drop zone */}
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: '2px dashed var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-2xl)',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: file ? 'var(--color-accent-light)' : 'var(--color-bg)',
                  transition: 'all 0.12s ease',
                }}
              >
                {file ? (
                  <>
                    <FileText size={32} style={{ color: 'var(--color-accent)', marginBottom: 'var(--space-sm)' }} />
                    <p className="font-medium">{file.name}</p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                      {(file.size / 1024).toFixed(0)} KB — Click to change
                    </p>
                  </>
                ) : (
                  <>
                    <Upload size={32} style={{ color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-sm)' }} />
                    <p className="font-medium">Click to select a report file</p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                      .docx or .pdf files only
                    </p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                />
              </div>

              {/* Error */}
              {error && (
                <div style={{
                  marginTop: 'var(--space-md)',
                  padding: 'var(--space-sm) var(--space-md)',
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  color: '#DC2626',
                  fontSize: '0.875rem',
                }}>
                  <AlertCircle size={16} />
                  {error}
                </div>
              )}

              {/* Parse button */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-lg)' }}>
                <button
                  className="btn btn-primary"
                  onClick={handleParse}
                  disabled={!file || isProcessing}
                >
                  {isProcessing ? (
                    <><Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} /> Parsing Report...</>
                  ) : (
                    <><FileText size={16} /> Parse Report</>
                  )}
                </button>
              </div>
            </>
          ) : (
            /* Success state */
            <div style={{ textAlign: 'center', padding: 'var(--space-lg) 0' }}>
              <CheckCircle2 size={48} style={{ color: 'var(--color-success)', marginBottom: 'var(--space-md)' }} />
              <h3 style={{ margin: '0 0 var(--space-sm)' }}>Report Imported!</h3>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                {result.message}
              </p>
              {result.project && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-xs)' }}>
                  Project: {result.project}
                </p>
              )}
              {result.original_date && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
                  Original Date: {result.original_date}
                </p>
              )}
              <button
                className="btn btn-primary"
                onClick={handleOpenReport}
                style={{ marginTop: 'var(--space-lg)' }}
              >
                Open Report <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
