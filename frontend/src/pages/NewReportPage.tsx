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
import { SectionNav, type NavSection } from '@/components/report/SectionNav';
import { ProjectPicker, type WeatherSnapshot } from '@/components/report/ProjectPicker';
import { ResumeOrStart, type ExistingReport } from '@/components/report/ResumeOrStart';
import { interviewApi } from '@/lib/interviewApi';
import { GuidedInterview } from '@/components/report/GuidedInterview';
import { getProfileKey, buildInterviewState, materializeActivities } from '@/lib/reportFlow';
import { Doc, DocHeader, DocStatus } from '@/components/ui/Doc';
import { useToast } from '@/components/ui/ConfirmProvider';
import { formatReportDate, formatQty } from '@/lib/formatters';

const REPORT_SECTIONS: NavSection[] = [
  { id: 'section-details', label: 'Details' },
  { id: 'section-schedule', label: 'Schedule' },
  { id: 'section-activities', label: 'Activities' },
];
import { reportApi } from '@/lib/api';
import { settingsApi } from '@/lib/settingsApi';
import { buildReportDefaults } from '@/lib/reportDefaults';

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
  Mic,
} from 'lucide-react';

export function NewReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const {
    report,
    isSaved,
    isDirty,
    isSaving,
    lastSavedAt,
    saveError,
    isLoading,
    loadError,
    duplicateConflict,
    revision,
    newReport,
    loadReport,
    replaceActivities,
    updateGeneral,
    setInterview,
    setWeather,
    closeReport,
    saveReport,
    saveReportAs,
    submitReport,
  } = useReportStore();

  // Guided flow. A NEW report starts at the project picker; an existing one
  // opens straight in the editor, because a quick fix should never mean
  // walking the whole format again.
  const [flowStage, setFlowStage] = useState<'checking' | 'picking' | 'interview' | 'editor'>(
    id ? 'editor' : 'checking'
  );
  const [profileKey, setProfileKey] = useState('');
  // Only used when the device refuses coordinates, which happens indoors
  // and on a phone that has denied location to the browser.
  const [fallbackZip, setFallbackZip] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answerRows, setAnswerRows] = useState<Record<string, Record<string, unknown>[]>>({});

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
        setFallbackZip((s as unknown as { default_zip_code?: string }).default_zip_code || '');
        newReport(buildReportDefaults(s));
      }).catch((err) => {
        console.warn('[NewReportPage] Settings fetch failed, creating blank report:', err);
        newReport();
      });
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring saved interview answers back into state when a report loads. Without
  // this, walking the questions again on an existing report would start from a
  // blank sheet and re-ask everything already answered.
  useEffect(() => {
    if (!report) return;
    const saved = report.interview;
    if (saved) {
      setAnswers((prev) => (Object.keys(prev).length ? prev : saved.answers || {}));
      setAnswerRows((prev) => (Object.keys(prev).length ? prev : saved.rows || {}));
      if (saved.profile) setProfileKey((prev) => prev || saved.profile);
      return;
    }

    // A report written before the interview existed, or filled in by dictation
    // or Quick Create. Seed the locations question from the activities already
    // on it, so walking the questions shows what is there and adds to it -
    // rather than starting blank and asking for locations the report covers.
    const covered = (report.activities || [])
      .map((a) => String(a.work_area || '').trim())
      .filter(Boolean);
    if (!covered.length) return;
    setAnswers((prev) => (Object.keys(prev).length ? prev : { locations: covered.join('\n') }));
    setAnswerRows((prev) => (
      Object.keys(prev).length ? prev : { locations: covered.map((item) => ({ item })) }
    ));
  }, [report?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    toast('Report submitted — a Word copy has been saved');
  }, [submitReport, toast]);

  const handleDownloadWord = useCallback(async () => {
    if (!report?.id) return;
    setIsDownloading(true);
    try {
      const date = report.general?.report_date || 'unknown';
      const outcome = await reportApi.downloadWord(report.id, `DailyReport_${date}.docx`);
      // Say what actually happened. On the phone the file goes to the browser's
      // downloads, not the app, and "downloaded" would leave you looking in the
      // wrong place.
      if (outcome === 'cancelled') {
        // Deliberate cancel — nothing to report.
      } else if (outcome === 'external') {
        toast('Opened in your browser — check Downloads');
      } else if (outcome === 'saved-to-chosen-folder') {
        toast('Word document saved');
      } else {
        toast('Word document downloaded');
      }
    } catch (err) {
      // This used to log to the console and nothing else, so a failed export
      // was indistinguishable from a successful one.
      console.error('[Export] Word download failed:', err);
      toast('Word export failed — check your connection and try again', 'err');
    } finally {
      setIsDownloading(false);
    }
  }, [report, toast]);

  // ── Guided flow ──────────────────────────────────────────────────────────
  // Runs BEFORE the loading guard on purpose: a brand-new report has nothing
  // to load, and showing a spinner ahead of the first question would be a
  // blank screen for no reason.
  // Ask BEFORE choosing a project, not after the save is refused. A report is
  // written most days, so on a day already started the old flow picked a
  // project, auto-saved, hit the duplicate guard and only then said "one
  // already exists" — answering a question it could have asked first.
  if (!id && flowStage === 'checking') {
    return (
      <ResumeOrStart
        reportDate={report?.general?.report_date || new Date().toISOString().slice(0, 10)}
        onResume={(existing: ExistingReport) => navigate(`/report/${existing.id}`, { replace: true })}
        onStartNew={() => setFlowStage('picking')}
      />
    );
  }

  // A report already exists for this date and project, so nothing was written
  // and auto-save has stopped. This decision has to be reachable from wherever
  // the user is standing: the picker and the interview return early, so before
  // this guard existed the warning rendered underneath them and could never be
  // answered - the app simply stopped on the first question with a 409 in the
  // console and no way forward.
  if (!id && duplicateConflict) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--space-lg)' }}>
        <DuplicateDateWarning />

      </div>
    );
  }

  if (!id && flowStage === 'picking') {
    return (
      <ProjectPicker
        reportDate={report?.general?.report_date || new Date().toISOString().slice(0, 10)}
        fallbackZip={fallbackZip}
        onPicked={(profile, weather: WeatherSnapshot | null) => {
          setProfileKey(profile.key);
          updateGeneral({ project_name: profile.project_name });
          if (weather) setWeather(weather);
          setFlowStage('interview');
        }}
      />
    );
  }

  if (flowStage === 'interview') {
    return (
      <GuidedInterview
        profileKey={profileKey || getProfileKey(report)}
        reportDate={report?.general?.report_date || ''}
        answers={answers}
        rows={answerRows}
        onAnswer={(qid, value, rows) => {
          // Committed on every answer rather than at the end. The interview is
          // filled in on a phone in the field; a dropped connection or a locked
          // screen must never cost the answers already given.
          const nextAnswers = { ...answers, [qid]: value };
          const nextRows = rows?.length ? { ...answerRows, [qid]: rows } : answerRows;
          setAnswers(nextAnswers);
          setAnswerRows(nextRows);
          setInterview(buildInterviewState(
            profileKey || getProfileKey(report), nextAnswers, nextRows, false,
          ));
        }}
        onExit={() => setFlowStage('editor')}
        onComplete={async () => {
          const key = profileKey || getProfileKey(report);
          setInterview(buildInterviewState(key, answers, answerRows, true));
          // Turn the answers into real activities so the Word export, PMWeb
          // sync and the resource tables all read the data they always have.
          // The interview is a better way to fill the report in, not a second
          // parallel copy of it.
          try {
            const profile = await interviewApi.profile(key);
            replaceActivities(materializeActivities(
              profile.sections, answers, answerRows, report?.activities || [],
            ));
          } catch (err) {
            // The answers are already saved on the report, so nothing is lost —
            // they just have not been laid out as activities yet.
            console.error('[NewReportPage] Could not build activities from answers:', err);
          }
          setFlowStage('editor');
        }}
      />
    );
  }

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

  // The figures that define the day. These already existed as rows buried in
  // five collapsed tables; the page never said them out loud.
  const acts = report.activities || [];
  const allManpower = acts.flatMap((a) => [
    ...(a.manpower || []), ...(a.extra_work_manpower || []), ...(a.consultant_manpower || []),
  ]);
  const allEquipment = acts.flatMap((a) => [
    ...(a.equipment || []), ...(a.extra_work_equipment || []),
  ]);
  const crewCount = allManpower.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
  const totalHours = allManpower.reduce(
    (sum, r) => sum + (Number(r.hours) || 0) * (Number(r.qty) || 1), 0,
  );
  const equipCount = allEquipment.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);

  return (
    <Doc>
      <NavigationGuard />

      {/* Shown only when a report already exists for this date — nothing has
          been saved or overwritten; the user chooses what happens. */}
      <DuplicateDateWarning />

      {/* Walk the format again on a report already started - the usual reason
          is another location turning up after the first pass. Saved answers are
          restored, so it continues rather than re-asking. */}
      {report && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-sm)' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setFlowStage('interview')}
            title="Answer the report's questions - add another location, or fill a gap"
          >
            <Mic size={14} /> Walk me through it
          </button>
        </div>
      )}


      {/* PMWeb Combined Preview panel */}
      {report?.id && (
        <PMWebPreview
          reportId={report.id}
          isOpen={showPMWeb}
          onClose={() => setShowPMWeb(false)}
        />
      )}

      {/* --- Document header: what this report IS, then how to act on it --- */}
      <DocHeader
        title={report?.general?.project_name || 'Untitled Report'}
        meta={[
          report?.general?.project_number ? `No. ${report.general.project_number}` : null,
          report?.general?.report_date ? formatReportDate(report.general.report_date) : 'No date set',
          report?.general?.project_location || null,
        ].filter(Boolean) as React.ReactNode[]}
        status={
          isSaving ? (
            <DocStatus tone="muted"><Loader2 size={11} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving</DocStatus>
          ) : saveError ? (
            <DocStatus tone="err"><AlertCircle size={11} /> Save failed</DocStatus>
          ) : isSaved && !isDirty ? (
            <DocStatus tone="ok"><CheckCircle2 size={11} /> Saved {lastSavedAt ? formatTimeAgo(lastSavedAt) : ''}</DocStatus>
          ) : isSaved && isDirty ? (
            <DocStatus tone="warn"><Clock size={11} /> Unsaved changes</DocStatus>
          ) : (
            <DocStatus tone="muted">Draft</DocStatus>
          )
        }
        figures={[
          { value: acts.length, label: 'Activities' },
          { value: crewCount, label: 'Crew on site', accent: true },
          { value: formatQty(totalHours), label: 'Labor hours', accent: true },
          { value: equipCount, label: 'Equipment' },
        ]}
        actions={
          <>
            {/* Secondary actions are demoted to icon buttons — the old bar had
                five buttons of near-equal weight and no clear next step. */}
            {isSaved && (
              <>
                <button className="btn btn-ghost btn-icon" onClick={handleSaveAs} title="Save as a copy" aria-label="Save as a copy">
                  <SaveAll size={17} />
                </button>
                <button className="btn btn-ghost btn-icon" onClick={handleDownloadWord} disabled={isDownloading} title="Export to Word" aria-label="Export to Word">
                  <FileDown size={17} />
                </button>
                <button className="btn btn-ghost btn-icon" onClick={() => setShowPMWeb(true)} title="PMWeb resource table" aria-label="PMWeb resource table">
                  <ClipboardList size={17} />
                </button>
                <span style={{ width: 1, height: 22, background: 'var(--color-border)' }} aria-hidden />
              </>
            )}
            <button
              className="btn btn-secondary"
              onClick={handleSave}
              disabled={isSaving || (!isDirty && isSaved)}
            >
              <Save size={16} /> Save
            </button>
            {isSaved && (
              <button className="btn btn-primary" onClick={handleSubmit} disabled={isSaving}>
                <Send size={16} /> Submit
              </button>
            )}
          </>
        }
      />

      {/* --- Jump nav: this page is a long scroll --- */}
      <SectionNav sections={REPORT_SECTIONS} />

      {/* --- General Info Form --- */}
      <div id="section-details">
        <GeneralInfoForm key={`gen-${revision}`} />
      </div>

      {/* --- Schedule (collapsible, above activities) --- */}
      <div id="section-schedule" style={{ marginTop: 'var(--space-lg)' }}>
        <ScheduleSection />
      </div>

      {/* --- Activities --- */}
      <div id="section-activities" style={{ marginTop: 'var(--space-lg)' }}>
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
    </Doc>
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
