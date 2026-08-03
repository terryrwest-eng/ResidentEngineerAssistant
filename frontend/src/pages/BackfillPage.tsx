/**
 * Daily Reporter V3 — Backfill Page (makeup reports)
 *
 * Three steps in one page, no modal wizard:
 * 1. Upload — drop in scanned timesheets and subcontractor email PDFs
 * 2. Group — confirm which day each file belongs to, fix any bad reads
 * 3. Generate — watch each date build, then review it beside the original scan
 *
 * WHY SIDE-BY-SIDE: the source documents are photographs of handwriting. When
 * the extraction gets a name or an hour wrong, the only way to fix it quickly is
 * to see the scan and the extracted rows at the same time — so the review step
 * puts the original page next to what came out of it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { backfillApi, reportApi } from '@/lib/api';
import type { BackfillFile, BackfillStatus, BackfillDate } from '@/lib/api';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Upload,
  X,
} from 'lucide-react';

type Step = 'upload' | 'group' | 'generate';

/** A file plus the edits made to it in the Group step. */
interface EditableFile extends BackfillFile {
  editedDate: string;
  editedType: string;
}

const DOC_TYPES = ['timesheet', 'sub_email', 'dispatch', 'schedule', 'other'];

const POLL_MS = 2000;

export function BackfillPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('upload');
  const [batchId, setBatchId] = useState('');
  const [files, setFiles] = useState<EditableFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');

  // Generation options
  const [detailLevel, setDetailLevel] = useState<'factual' | 'narrative'>('factual');
  const [useContinuity, setUseContinuity] = useState(true);
  const [fetchWeather, setFetchWeather] = useState(true);

  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const pollRef = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Upload ────────────────────────────────────────────────────────────────

  const handleFiles = async (picked: File[]) => {
    if (picked.length === 0) return;
    setIsUploading(true);
    setError('');
    try {
      const result = await backfillApi.upload(picked);
      setBatchId(result.batch_id);
      setFiles(result.files.map((f) => ({
        ...f,
        editedDate: f.work_date,
        editedType: f.doc_type,
      })));
      setStep('group');
    } catch (err) {
      console.error('[Backfill] Upload failed:', err);
      setError('Upload failed. Check that the backend is running and try again.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Group ─────────────────────────────────────────────────────────────────

  const groups = useMemo(() => {
    const byDate = new Map<string, EditableFile[]>();
    files.forEach((file) => {
      const key = file.editedDate || '';
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(file);
    });
    return Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const undated = groups.find(([date]) => !date)?.[1] ?? [];
  const datedGroups = groups.filter(([date]) => date);

  const updateFile = (fileId: string, patch: Partial<EditableFile>) => {
    setFiles((prev) => prev.map((f) => (f.file_id === fileId ? { ...f, ...patch } : f)));
  };

  // ── Generate ──────────────────────────────────────────────────────────────

  const poll = useCallback(async (id: string) => {
    try {
      const next = await backfillApi.status(id);
      setStatus(next);
      if (next.state === 'complete' && pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      console.error('[Backfill] Status poll failed:', err);
    }
  }, []);

  const startGeneration = async () => {
    setError('');
    try {
      await backfillApi.generate({
        batch_id: batchId,
        groups: datedGroups.map(([date, groupFiles]) => ({
          date,
          file_ids: groupFiles.map((f) => f.file_id),
        })),
        detail_level: detailLevel,
        use_continuity: useContinuity,
        fetch_weather: fetchWeather,
      });
      setStep('generate');
      poll(batchId);
      pollRef.current = window.setInterval(() => poll(batchId), POLL_MS);
    } catch (err) {
      // Show what the server actually said. "Try again" hid real, actionable
      // causes — no dates to group, a batch already generating — behind advice
      // that could not work, because retrying an unchanged request fails
      // identically every time.
      console.error('[Backfill] Generate failed:', err);
      const httpErr = err as { response?: { data?: { detail?: string } } };
      setError(
        httpErr?.response?.data?.detail
        || (err instanceof Error ? err.message : 'Could not start generation.')
      );
    }
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const doneCount = status?.dates.filter((d) => d.state === 'done').length ?? 0;
  const isRunning = status?.state === 'generating';

  return (
    <div>
      <div className="page-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <CalendarClock size={24} style={{ color: 'var(--color-accent)' }} />
          Backfill Reports
        </h1>
        <p>Rebuild missed daily reports from scanned contractor timesheets</p>
      </div>

      <StepBar step={step} />

      {error && (
        <div style={{
          padding: 'var(--space-md)',
          marginBottom: 'var(--space-lg)',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-danger)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-danger)',
          fontSize: '0.875rem',
        }}>
          {error}
        </div>
      )}

      {/* ── STEP 1: UPLOAD ─────────────────────────────────────────────── */}
      {step === 'upload' && (
        <div className="card">
          <div className="card-header">
            <h3 style={{ margin: 0 }}>Upload source documents</h3>
            <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
              Timesheet scans (PDF or photo) and subcontractor emails saved as PDF
            </span>
          </div>
          <div className="card-body">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              multiple
              onChange={(e) => handleFiles(Array.from(e.target.files || []))}
              style={{ display: 'none' }}
            />

            <div
              onClick={() => !isUploading && fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!isUploading) handleFiles(Array.from(e.dataTransfer.files || []));
              }}
              style={{
                padding: 'var(--space-xl)',
                border: '2px dashed var(--color-border)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'center',
                cursor: isUploading ? 'wait' : 'pointer',
                background: 'var(--color-bg)',
              }}
            >
              {isUploading ? (
                <>
                  <Loader2 size={36} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--color-accent)' }} />
                  <p style={{ margin: 'var(--space-sm) 0 0', fontWeight: 600 }}>
                    Reading files...
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                    Files without a date in the filename are checked by AI — that part takes a moment.
                  </p>
                </>
              ) : (
                <>
                  <Upload size={36} style={{ opacity: 0.35 }} />
                  <p style={{ margin: 'var(--space-sm) 0 0', fontWeight: 600 }}>
                    Drop timesheets here, or click to choose
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                    You can drop a whole month at once — each file is matched to its own day.
                  </p>
                </>
              )}
            </div>

            <p style={{
              marginTop: 'var(--space-md)', marginBottom: 0,
              fontSize: '0.75rem', color: 'var(--color-text-tertiary)',
            }}>
              The date in the filename is used when there is one (and the weekday in the name is
              checked against it, which catches the year typos). Anything undated is read by AI and
              can be corrected in the next step.
            </p>
          </div>
        </div>
      )}

      {/* ── STEP 2: GROUP ──────────────────────────────────────────────── */}
      {step === 'group' && (
        <>
          {undated.length > 0 && (
            <Banner tone="warning">
              {undated.length} file{undated.length > 1 ? 's have' : ' has'} no date yet. Set the date
              below — undated files are not generated.
            </Banner>
          )}

          <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
            <div className="card-header">
              <h3 style={{ margin: 0 }}>
                {datedGroups.length} day{datedGroups.length === 1 ? '' : 's'} · {files.length} file{files.length === 1 ? '' : 's'}
              </h3>
              <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
                Confirm the day and document type for each file
              </span>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
              {groups.map(([date, groupFiles]) => {
                const hasTimesheet = groupFiles.some((f) => f.editedType === 'timesheet');
                return (
                  <div key={date || 'undated'}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                      marginBottom: 'var(--space-sm)',
                    }}>
                      <strong style={{ fontSize: '0.9375rem' }}>
                        {date ? formatDate(date) : 'No date yet'}
                      </strong>
                      <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                        {groupFiles.length} file{groupFiles.length === 1 ? '' : 's'}
                      </span>
                      {date && !hasTimesheet && (
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 600,
                          color: 'var(--color-warning)',
                          display: 'flex', alignItems: 'center', gap: '4px',
                        }}>
                          <AlertTriangle size={12} /> no timesheet for this day
                        </span>
                      )}
                    </div>

                    <div style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      overflow: 'hidden',
                    }}>
                      {groupFiles.map((file) => (
                        <div
                          key={file.file_id}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1fr) 150px 140px',
                            gap: 'var(--space-sm)',
                            alignItems: 'center',
                            padding: 'var(--space-sm) var(--space-md)',
                            borderBottom: '1px solid var(--color-border)',
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{
                              fontSize: '0.8125rem', fontWeight: 500,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {file.filename}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--color-text-tertiary)' }}>
                              {file.page_count > 0 && `${file.page_count} page${file.page_count === 1 ? '' : 's'} · `}
                              {describeSource(file)}
                            </div>
                            {file.note && (
                              <div style={{
                                fontSize: '0.7rem',
                                color: file.weekday_check === 'mismatch'
                                  ? 'var(--color-warning)'
                                  : 'var(--color-text-tertiary)',
                                marginTop: '2px',
                              }}>
                                {file.note}
                              </div>
                            )}
                          </div>

                          <input
                            className="input"
                            type="date"
                            value={file.editedDate}
                            onChange={(e) => updateFile(file.file_id, { editedDate: e.target.value })}
                            style={{ fontSize: '0.8125rem' }}
                          />

                          <select
                            className="input"
                            value={file.editedType}
                            onChange={(e) => updateFile(file.file_id, { editedType: e.target.value })}
                            style={{ fontSize: '0.8125rem' }}
                          >
                            {DOC_TYPES.map((t) => (
                              <option key={t} value={t}>{t.replace('_', ' ')}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
            <div className="card-header">
              <h3 style={{ margin: 0 }}>How much should the AI write?</h3>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
                <button
                  className={`btn btn-sm ${detailLevel === 'factual' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setDetailLevel('factual')}
                >
                  Strictly factual
                </button>
                <button
                  className={`btn btn-sm ${detailLevel === 'narrative' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setDetailLevel('narrative')}
                >
                  Narrative
                </button>
              </div>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                {detailLevel === 'factual'
                  ? 'Only what is written on the sheet. Station ranges, quantities and percent complete are listed as "missing info" for you to fill in — nothing is invented.'
                  : 'The sheet\'s facts written up as a short narrative like your finished reports. Still nothing invented — gaps are still listed as missing info.'}
              </p>

              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontSize: '0.8125rem' }}>
                <input type="checkbox" checked={useContinuity} onChange={(e) => setUseContinuity(e.target.checked)} />
                Use the previous days to interpret a blank summary box
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontSize: '0.8125rem' }}>
                <input type="checkbox" checked={fetchWeather} onChange={(e) => setFetchWeather(e.target.checked)} />
                Look up historical weather (needs a default ZIP code in Settings)
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <button className="btn btn-secondary" onClick={() => setStep('upload')}>
              <ArrowLeft size={16} /> Back
            </button>
            <button
              className="btn btn-primary"
              onClick={startGeneration}
              disabled={datedGroups.length === 0}
            >
              Generate {datedGroups.length} report{datedGroups.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}

      {/* ── STEP 3: GENERATE & REVIEW ──────────────────────────────────── */}
      {step === 'generate' && status && (
        <>
          <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
            <div className="card-header">
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                {isRunning && <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--color-accent)' }} />}
                {isRunning ? 'Generating...' : 'Finished'}
              </h3>
              <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
                {doneCount} of {status.dates.length} date{status.dates.length === 1 ? '' : 's'} built
              </span>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {status.dates.map((day) => (
                <DateCard
                  key={day.date}
                  day={day}
                  batchId={status.batch_id}
                  files={status.files}
                  onOpen={(reportId) => navigate(`/report/${reportId}`)}
                />
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => setStep('group')}>
              <ArrowLeft size={16} /> Back to grouping
            </button>
            <a
              className="btn btn-primary"
              href={backfillApi.exportUrl(status.batch_id)}
              style={{ pointerEvents: doneCount > 0 ? 'auto' : 'none', opacity: doneCount > 0 ? 1 : 0.5 }}
            >
              <Download size={16} /> Export all Word docs
            </a>
          </div>
        </>
      )}
    </div>
  );
}


// ============================================
// Per-date review card
// ============================================

interface ReviewActivity {
  id: string;
  work_area: string;
  summary: string;
  manpower: { id: string; name: string; trade: string; hours: number; ot_hours?: number }[];
  equipment: { id: string; name: string; description: string; hours: number }[];
}

function DateCard({
  day, batchId, files, onOpen,
}: {
  day: BackfillDate;
  batchId: string;
  files: BackfillStatus['files'];
  onOpen: (reportId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [activities, setActivities] = useState<ReviewActivity[] | null>(null);
  const [activeFileId, setActiveFileId] = useState('');

  const sourceFiles = files.filter((f) => day.file_ids.includes(f.file_id));

  useEffect(() => {
    if (!expanded || activities || !day.report_id) return;
    reportApi.get(day.report_id)
      .then((report: { activities?: ReviewActivity[] }) => setActivities(report.activities || []))
      .catch((err: unknown) => console.error('[Backfill] Could not load report:', err));
  }, [expanded, activities, day.report_id]);

  useEffect(() => {
    if (expanded && !activeFileId && sourceFiles.length > 0) {
      setActiveFileId(sourceFiles[0].file_id);
    }
  }, [expanded, activeFileId, sourceFiles]);

  const tone = STATE_TONE[day.state];

  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderLeft: `3px solid ${tone.color}`,
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      <div
        onClick={() => day.state === 'done' && setExpanded((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
          padding: 'var(--space-sm) var(--space-md)',
          cursor: day.state === 'done' ? 'pointer' : 'default',
        }}
      >
        {day.state === 'done'
          ? (expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />)
          : <span style={{ width: 16 }} />}

        <StateIcon state={day.state} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{formatDate(day.date)}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
            {day.message || tone.label}
            {day.flag_count > 0 && ` · ${day.flag_count} item${day.flag_count === 1 ? '' : 's'} to check`}
          </div>
        </div>

        {day.report_id && (
          <button
            className="btn btn-sm btn-outline"
            onClick={(e) => { e.stopPropagation(); onOpen(day.report_id); }}
          >
            <ExternalLink size={14} /> Open
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: 'var(--space-md)' }}>
          {(day.flags.length > 0 || day.excluded_sheets.length > 0) && (
            <div style={{ marginBottom: 'var(--space-md)' }}>
              {day.excluded_sheets.map((sheet, i) => (
                <div key={`x-${i}`} style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                  <strong>Excluded:</strong> {sheet.sheet} — {sheet.reason}
                </div>
              ))}
              {day.flags.map((flag, i) => (
                <div key={`f-${i}`} style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                  • {flag}
                </div>
              ))}
            </div>
          )}

          {/* Source scan next to what came out of it */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 'var(--space-md)',
          }}>
            <div>
              <div style={{ display: 'flex', gap: '4px', marginBottom: 'var(--space-xs)', flexWrap: 'wrap' }}>
                {sourceFiles.map((file) => (
                  <button
                    key={file.file_id}
                    className={`btn btn-sm ${activeFileId === file.file_id ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setActiveFileId(file.file_id)}
                    style={{ fontSize: '0.7rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    <FileText size={12} /> {file.filename}
                  </button>
                ))}
              </div>
              {activeFileId && (
                <iframe
                  title="Source document"
                  src={backfillApi.fileUrl(batchId, activeFileId)}
                  style={{
                    width: '100%', height: 460,
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    background: '#fff',
                  }}
                />
              )}
            </div>

            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              {activities === null ? (
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
                  Loading extracted activities...
                </div>
              ) : activities.length === 0 ? (
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
                  No activities on this report.
                </div>
              ) : (
                activities.map((act) => (
                  <div key={act.id} style={{
                    marginBottom: 'var(--space-md)',
                    padding: 'var(--space-sm)',
                    background: 'var(--color-bg)',
                    borderRadius: 'var(--radius-md)',
                  }}>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '4px' }}>
                      {act.work_area}
                    </div>
                    <div style={{
                      fontSize: '0.75rem', whiteSpace: 'pre-wrap',
                      color: 'var(--color-text-secondary)', marginBottom: 'var(--space-xs)',
                    }}>
                      {act.summary}
                    </div>
                    {act.manpower.map((row) => (
                      <div key={row.id} style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                        {row.trade} · {row.name || '—'} · {row.hours}h
                        {row.ot_hours ? ` +${row.ot_hours} OT` : ''}
                      </div>
                    ))}
                    {act.equipment.map((row) => (
                      <div key={row.id} style={{
                        fontSize: '0.7rem', fontFamily: 'var(--font-mono)',
                        color: 'var(--color-text-tertiary)',
                      }}>
                        {row.name} {row.description && `(${row.description})`} · {row.hours}h
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ============================================
// Small pieces
// ============================================

const STATE_TONE: Record<BackfillDate['state'], { color: string; label: string }> = {
  pending: { color: 'var(--color-border)', label: 'Waiting' },
  running: { color: 'var(--color-accent)', label: 'Working' },
  done: { color: 'var(--color-success)', label: 'Report created' },
  skipped: { color: 'var(--color-warning)', label: 'Skipped' },
  failed: { color: 'var(--color-danger)', label: 'Failed' },
};

function StateIcon({ state }: { state: BackfillDate['state'] }) {
  if (state === 'running') {
    return <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--color-accent)' }} />;
  }
  if (state === 'done') return <Check size={16} style={{ color: STATE_TONE.done.color }} />;
  if (state === 'skipped') return <AlertTriangle size={16} style={{ color: STATE_TONE.skipped.color }} />;
  if (state === 'failed') return <X size={16} style={{ color: STATE_TONE.failed.color }} />;
  return <span style={{ width: 16, display: 'inline-block' }} />;
}

function StepBar({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'upload', label: '1 · Upload' },
    { id: 'group', label: '2 · Group by day' },
    { id: 'generate', label: '3 · Generate & review' },
  ];
  return (
    <div style={{ display: 'flex', gap: 'var(--space-xs)', marginBottom: 'var(--space-lg)', flexWrap: 'wrap' }}>
      {steps.map((s) => (
        <div
          key={s.id}
          style={{
            padding: '6px 14px',
            borderRadius: 'var(--radius-full)',
            fontSize: '0.8125rem',
            fontWeight: step === s.id ? 600 : 400,
            background: step === s.id ? 'var(--color-accent)' : 'var(--color-surface)',
            color: step === s.id ? '#fff' : 'var(--color-text-tertiary)',
            border: '1px solid var(--color-border)',
          }}
        >
          {s.label}
        </div>
      ))}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'warning'; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--space-sm)',
      padding: 'var(--space-md)',
      marginBottom: 'var(--space-lg)',
      background: 'var(--color-bg)',
      border: `1px solid ${tone === 'warning' ? 'var(--color-warning)' : 'var(--color-border)'}`,
      borderRadius: 'var(--radius-md)',
      fontSize: '0.8125rem',
    }}>
      <AlertTriangle size={16} style={{ color: 'var(--color-warning)', flexShrink: 0, marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );
}

function describeSource(file: BackfillFile): string {
  if (file.date_source === 'filename') return 'date from filename';
  if (file.date_source === 'filename_corrected') return 'date corrected by weekday';
  if (file.date_source === 'ai') return `read by AI (${Math.round(file.confidence * 100)}% sure)`;
  return 'no date found';
}

function formatDate(date: string): string {
  if (!date) return 'No date';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}
