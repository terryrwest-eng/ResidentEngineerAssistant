/**
 * Daily Reporter V3 — New/Edit Report Page
 *
 * Full report editor with Word/Excel save model:
 * - New reports: no auto-save until first explicit Save
 * - After save: auto-save on every change
 * - Navigation guard warns about unsaved changes
 *
 * Layout: General info section at top, activities below.
 * Everything is on ONE page — no modals, no disappearing windows.
 */

import { useEffect, useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useReportStore } from '@/stores/reportStore';
import { NavigationGuard } from '@/components/ui/NavigationGuard';
import { GeneralInfoForm } from '@/components/report/GeneralInfoForm';
import { ActivityList } from '@/components/report/ActivityList';
import { PMWebPreview } from '@/components/report/PMWebPreview';
import { reportApi } from '@/lib/api';
import {
  Save,
  SaveAll,
  FileDown,
  Send,
  ClipboardList,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
} from 'lucide-react';

export function NewReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const {
    report,
    isSaved,
    isDirty,
    isSaving,
    lastSavedAt,
    saveError,
    isLoading,
    loadError,
    newReport,
    loadReport,
    saveReport,
    saveReportAs,
    submitReport,
  } = useReportStore();

  const [showPMWeb, setShowPMWeb] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Load existing report or create new
  useEffect(() => {
    if (id) {
      loadReport(id);
    } else if (!report) {
      newReport();
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    const savedId = await saveReport();
    if (savedId && !id) {
      navigate(`/report/${savedId}`, { replace: true });
    }
  }, [saveReport, id, navigate]);

  const handleSaveAs = useCallback(async () => {
    const savedId = await saveReportAs();
    if (savedId) {
      navigate(`/report/${savedId}`, { replace: true });
    }
  }, [saveReportAs, navigate]);

  const handleSubmit = useCallback(async () => {
    await submitReport();
  }, [submitReport]);

  const handleDownloadWord = useCallback(async () => {
    if (!report?.id) return;
    setIsDownloading(true);
    try {
      const date = report.general?.report_date || 'unknown';
      await reportApi.downloadWord(report.id, `DailyReport_${date}.docx`);
    } catch (err) {
      console.error('[Export] Word download failed:', err);
    } finally {
      setIsDownloading(false);
    }
  }, [report]);

  // Loading state
  if (isLoading) {
    return (
      <div className="empty-state" style={{ paddingTop: 'var(--space-2xl)' }}>
        <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
        <p style={{ marginTop: 'var(--space-md)' }}>Loading report...</p>
      </div>
    );
  }

  // Load error
  if (loadError) {
    return (
      <div className="empty-state" style={{ paddingTop: 'var(--space-2xl)' }}>
        <AlertCircle size={48} style={{ color: 'var(--color-danger)' }} />
        <h3 style={{ marginTop: 'var(--space-md)' }}>Failed to Load Report</h3>
        <p>{loadError}</p>
        <button className="btn btn-primary" onClick={() => navigate('/')} style={{ marginTop: 'var(--space-md)' }}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  // No report loaded
  if (!report) return null;

  return (
    <div>
      <NavigationGuard />

      {/* PMWeb Combined Preview panel */}
      {report?.id && (
        <PMWebPreview
          reportId={report.id}
          isOpen={showPMWeb}
          onClose={() => setShowPMWeb(false)}
        />
      )}

      {/* --- Top Bar: Save status + action buttons --- */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 'var(--space-lg)',
        flexWrap: 'wrap',
        gap: 'var(--space-sm)',
      }}>
        {/* Left: Save status indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          fontSize: '0.8125rem',
        }}>
          {isSaving ? (
            <>
              <Loader2 size={14} className="spinner" style={{ border: 'none', animation: 'spin 0.6s linear infinite' }} />
              <span style={{ color: 'var(--color-text-tertiary)' }}>Saving...</span>
            </>
          ) : saveError ? (
            <>
              <AlertCircle size={14} style={{ color: 'var(--color-danger)' }} />
              <span style={{ color: 'var(--color-danger)' }}>Save failed</span>
            </>
          ) : isSaved && !isDirty ? (
            <>
              <CheckCircle2 size={14} style={{ color: 'var(--color-success)' }} />
              <span style={{ color: 'var(--color-text-tertiary)' }}>
                Saved {lastSavedAt ? formatTimeAgo(lastSavedAt) : ''}
              </span>
            </>
          ) : isSaved && isDirty ? (
            <>
              <Clock size={14} style={{ color: 'var(--color-warning)' }} />
              <span style={{ color: 'var(--color-text-tertiary)' }}>Unsaved changes</span>
            </>
          ) : (
            <>
              <AlertCircle size={14} style={{ color: 'var(--color-text-tertiary)' }} />
              <span style={{ color: 'var(--color-text-tertiary)' }}>New report — not saved yet</span>
            </>
          )}
        </div>

        {/* Right: Action buttons */}
        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={isSaving || (!isDirty && isSaved)}
          >
            <Save size={16} />
            {isSaved ? 'Save' : 'Save Report'}
          </button>

          {isSaved && (
            <>
              <button className="btn btn-secondary" onClick={handleSaveAs}>
                <SaveAll size={16} />
                Save As
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleDownloadWord}
                disabled={isDownloading}
              >
                <FileDown size={16} />
                {isDownloading ? 'Generating...' : 'Export Word'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowPMWeb(true)}
              >
                <ClipboardList size={16} />
                PMWeb
              </button>
              <button className="btn btn-primary" onClick={handleSubmit} disabled={isSaving}>
                <Send size={16} />
                Submit
              </button>
            </>
          )}
        </div>
      </div>

      {/* --- General Info Form --- */}
      <GeneralInfoForm />

      {/* --- Activities --- */}
      <div style={{ marginTop: 'var(--space-xl)' }}>
        <ActivityList />
      </div>
    </div>
  );
}

/** Format a timestamp as "X minutes ago" / "just now" */
function formatTimeAgo(isoString: string): string {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 10) return '';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}
