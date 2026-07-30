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
import { DuplicateDateWarning } from '@/components/report/DuplicateDateWarning';
import { GeneralInfoForm } from '@/components/report/GeneralInfoForm';
import { ActivityList } from '@/components/report/ActivityList';
import { PMWebPreview } from '@/components/report/PMWebPreview';
import { ReportChat } from '@/components/report/ReportChat';
import { ScheduleSection } from '@/components/report/ScheduleSection';
import { reportApi } from '@/lib/api';
import { settingsApi } from '@/lib/settingsApi';

/**
 * Convert 12-hour time string ("6:30 AM", "3:00 PM") to 24-hour format ("06:30", "15:00").
 * HTML <input type="time"> requires HH:mm format.
 * Passes through values already in 24h format unchanged.
 */
function to24h(time12: string): string {
  if (!time12) return '';
  // Already in HH:mm format?
  const match24 = time12.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) return time12;
  // Parse 12h: "6:30 AM", "3:00 PM", "12:00 PM"
  const match12 = time12.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match12) {
    console.warn('[NewReportPage] Could not parse time for 24h conversion:', time12);
    return time12;
  }
  let hrs = parseInt(match12[1]);
  const mins = match12[2];
  const period = match12[3].toUpperCase();
  if (period === 'PM' && hrs !== 12) hrs += 12;
  if (period === 'AM' && hrs === 12) hrs = 0;
  return `${hrs.toString().padStart(2, '0')}:${mins}`;
}
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
  Sparkles,
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
    revision,
    newReport,
    loadReport,
    closeReport,
    saveReport,
    saveReportAs,
    submitReport,
  } = useReportStore();

  const [showPMWeb, setShowPMWeb] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Load existing report or create new
  useEffect(() => {
    if (id) {
      loadReport(id);
      // Auto-set Chrome extension context so PMWeb Auto-Fill knows which report is active
      reportApi.setExtensionContext(id).catch(() => {
        console.debug('[NewReportPage] Extension context set failed (non-critical)');
      });
    } else {
      // Save current work before starting fresh
      if (isSaved && isDirty) {
        saveReport().then(() => console.debug('[NewReportPage] Auto-saved before new report'));
      }
      // Always start fresh when navigating to /report/new
      closeReport();
      // Clear stale extension context so Chrome extension doesn't serve previous report
      reportApi.clearExtensionContext().catch(() => {
        console.debug('[NewReportPage] Extension context clear failed (non-critical)');
      });
      // Fetch settings defaults for new reports
      settingsApi.get().then((s) => {
        console.debug('[NewReportPage] Settings loaded, applying defaults:', {
          project: s.default_project,
          re: s.default_resident_engineer,
          start: s.default_start_time,
          stop: s.default_stop_time,
        });
        newReport({
          project_name: s.default_project || '',
          resident_engineer: s.default_resident_engineer || '',
          start_time: to24h(s.default_start_time || ''),
          end_time: to24h(s.default_stop_time || ''),
        });
      }).catch((err) => {
        console.warn('[NewReportPage] Settings fetch failed, creating blank report:', err);
        newReport();
      });
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    const savedId = await saveReport();
    if (savedId && !id) {
      navigate(`/report/${savedId}`, { replace: true });
    }
    // Keep extension context in sync after every save
    if (savedId) {
      reportApi.setExtensionContext(savedId).catch(() => {});
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

      {/* Shown only when a report already exists for this date — nothing has
          been saved or overwritten; the user chooses what happens. */}
      <DuplicateDateWarning />

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
      <GeneralInfoForm key={`gen-${revision}`} />

      {/* --- Schedule (collapsible, above activities) --- */}
      <div style={{ marginTop: 'var(--space-lg)' }}>
        <ScheduleSection />
      </div>

      {/* --- Activities --- */}
      <div style={{ marginTop: 'var(--space-lg)' }}>
        <ActivityList key={`act-${revision}`} />
      </div>

      {/* --- Floating AI Chat Button --- */}
      <button
        onClick={() => setShowChat(true)}
        aria-label="Open AI Report Assistant"
        style={{
          position: 'fixed',
          bottom: '80px',
          right: '20px',
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          backgroundColor: 'var(--color-accent)',
          color: 'var(--color-accent-text)',
          border: 'none',
          boxShadow: '0 4px 14px rgba(59, 111, 224, 0.4)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.08)';
          e.currentTarget.style.boxShadow = '0 6px 20px rgba(59, 111, 224, 0.5)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.boxShadow = '0 4px 14px rgba(59, 111, 224, 0.4)';
        }}
      >
        <Sparkles size={24} />
      </button>

      {/* --- AI Report Chat Overlay --- */}
      {showChat && <ReportChat onClose={() => setShowChat(false)} />}
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
