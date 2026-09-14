/**
 * Daily Reporter V3 — Dashboard Page
 *
 * Landing page showing:
 * - Quick-action buttons (New Report, Scan, Dictate)
 * - Recent reports
 * - Project stats
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FilePlus,
  History,
  Camera,
  Mic,
  FileText,
  TrendingUp,
  Zap,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ArrowRight,
  MessagesSquare,
} from 'lucide-react';
import { reportApi } from '@/lib/api';
import { localDateString, formatReportDate } from '@/lib/formatters';
import { AutoCreateDialog } from '@/components/report/AutoCreateDialog';

interface ReportSummary {
  id: string;
  project_name: string;
  report_date: string;
  status: string;
  activity_count: number;
  updated_at: string;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [recentReports, setRecentReports] = useState<ReportSummary[]>([]);
  const [totalReports, setTotalReports] = useState(0);
  const [thisWeek, setThisWeek] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAutoCreate, setShowAutoCreate] = useState(false);
  const [todayReport, setTodayReport] = useState<ReportSummary | null>(null);

  useEffect(() => {
    loadDashboard();
  }, []);

  async function loadDashboard() {
    try {
      setLoading(true);
      setError(null);
      // Fetch up to 200 so "this week" count is accurate across a reasonable range
      const data = await reportApi.list({ limit: 200 });
      setRecentReports((data.reports || []).slice(0, 5));
      setTotalReports(data.total || 0);
      // Compute this-week count from the fetched index
      const monday = getThisWeekMonday();
      const weekCount = (data.reports || []).filter((r: { report_date: string }) => {
        if (!r.report_date) return false;
        return r.report_date >= monday;
      }).length;
      setThisWeek(weekCount);
      // Is today's report already started? This is the first question the
      // dashboard should answer, and it previously took a trip to History.
      const today = localDateString();
      setTodayReport(
        (data.reports || []).find((r: ReportSummary) => r.report_date === today) || null,
      );
    } catch (err) {
      console.error('[Dashboard] Failed to load:', err);
      setError('Unable to connect to server. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <h1>Daily Reporter</h1>
        <p>Construction Field Reporting Platform</p>
      </div>

      {/* Today — the question you actually open this app to answer */}
      {!loading && !error && (
        <div
          className="card"
          style={{
            marginBottom: 'var(--space-lg)',
            borderLeft: `3px solid ${todayReport ? 'var(--color-success)' : 'var(--color-warning)'}`,
          }}
        >
          <div
            className="card-body"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-md)',
              flexWrap: 'wrap',
            }}
          >
            {todayReport
              ? <CheckCircle2 size={22} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
              : <CalendarDays size={22} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />}

            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontWeight: 600 }}>
                {todayReport ? "Today's report is started" : "No report for today yet"}
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
                {formatReportDate(localDateString())}
                {todayReport && ` · ${todayReport.activity_count} `}
                {todayReport && (todayReport.activity_count === 1 ? 'activity' : 'activities')}
                {todayReport?.status === 'draft' && ' · draft'}
              </div>
            </div>

            <button
              className="btn btn-primary"
              onClick={() => navigate(todayReport ? `/report/${todayReport.id}` : '/report/new')}
            >
              {todayReport ? <><ArrowRight size={16} /> Resume</> : <><FilePlus size={16} /> Start today</>}
            </button>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 'var(--space-md)',
        marginBottom: 'var(--space-xl)',
      }}>
        <QuickAction
          icon={<Zap size={24} />}
          label="Quick Create"
          /*
            Was "Auto-create report from dispatch", which is what made this feel
            like the dispatch button. Dispatches exist for paving work with one
            company — nine days in ten there is none, and on those days this
            still does the useful thing: seeds the header from Settings and
            fills in the weather, which New Report leaves you to do by hand.
            The description now names that, not the rare case.
          */
          description="Start today's report with weather filled in"
          onClick={() => setShowAutoCreate(true)}
          accent
        />
        <QuickAction
          icon={<FilePlus size={24} />}
          label="New Report"
          description="Start a new daily field report"
          onClick={() => navigate('/report/new')}
        />
        <QuickAction
          icon={<Camera size={24} />}
          label="Scan Document"
          description="Scan a timesheet or ticket"
          onClick={() => navigate('/report/new?action=scan')}
        />
        <QuickAction
          icon={<Mic size={24} />}
          label="Voice Dictation"
          description="Dictate today's activities"
          onClick={() => navigate('/report/new?action=dictate')}
        />
        <QuickAction
          icon={<MessagesSquare size={24} />}
          label="Talk It Through"
          description="Answer questions until the report is complete"
          onClick={() => navigate('/report/talk')}
        />
        <QuickAction
          icon={<CalendarClock size={24} />}
          label="Backfill Reports"
          description="Rebuild missed days from timesheets"
          onClick={() => navigate('/backfill')}
        />
        <QuickAction
          icon={<History size={24} />}
          label="View History"
          description="Browse past reports"
          onClick={() => navigate('/history')}
        />
      </div>

      {/* Stats */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 'var(--space-md)',
        marginBottom: 'var(--space-xl)',
      }}>
        <StatCard icon={<FileText size={20} />} label="Total Reports" value={totalReports} />
        <StatCard icon={<TrendingUp size={20} />} label="This Week" value={thisWeek} />
      </div>

      {/* Recent Reports */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Recent Reports</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/history')}>
            View All
          </button>
        </div>
        <div className="card-body">
          {loading && (
            <div className="empty-state">
              <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
              <p style={{ marginTop: 'var(--space-md)' }}>Loading...</p>
            </div>
          )}

          {error && (
            <div style={{
              padding: 'var(--space-md)',
              background: 'var(--color-warning-light)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-warning)',
              fontSize: '0.875rem',
            }}>
              {error}
            </div>
          )}

          {!loading && !error && recentReports.length === 0 && (
            <div className="empty-state">
              <FileText size={48} />
              <p style={{ fontWeight: 600, marginTop: 'var(--space-sm)' }}>No reports yet</p>
              <p style={{ fontSize: '0.875rem', color: 'var(--color-text-tertiary)' }}>
                Start today's report, or rebuild missed days from your timesheets.
              </p>
              <div style={{
                display: 'flex', gap: 'var(--space-sm)', justifyContent: 'center',
                marginTop: 'var(--space-md)', flexWrap: 'wrap',
              }}>
                <button className="btn btn-primary" onClick={() => navigate('/report/new')}>
                  <FilePlus size={16} /> New Report
                </button>
                <button className="btn btn-secondary" onClick={() => navigate('/backfill')}>
                  <CalendarClock size={16} /> Backfill Reports
                </button>
              </div>
            </div>
          )}

          {!loading && !error && recentReports.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project</th>
                  <th>Activities</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentReports.map((report) => (
                  <tr
                    key={report.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/report/${report.id}`)}
                  >
                    <td className="mono" style={{ fontSize: '0.8125rem' }}>
                      {report.report_date || '—'}
                    </td>
                    <td>{report.project_name || 'Untitled'}</td>
                    <td>{report.activity_count}</td>
                    <td>
                      <span className={`badge badge-${report.status === 'submitted' ? 'success' : report.status === 'draft' ? 'info' : 'warning'}`}>
                        {report.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Auto-Create Dialog */}
      {showAutoCreate && (
        <AutoCreateDialog onClose={() => setShowAutoCreate(false)} />
      )}
    </div>
  );
}


// --- Sub-components ---

function QuickAction({
  icon,
  label,
  description,
  onClick,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      className="card"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 'var(--space-sm)',
        padding: 'var(--space-lg)',
        cursor: 'pointer',
        border: accent ? '2px solid var(--color-accent)' : undefined,
        background: accent ? 'var(--color-accent-light)' : undefined,
        textAlign: 'left',
        width: '100%',
      }}
    >
      <div style={{ color: accent ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
        {icon}
      </div>
      <div>
        <div style={{
          fontWeight: 600,
          fontSize: '0.9375rem',
          color: 'var(--color-text-primary)',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: '0.8125rem',
          color: 'var(--color-text-tertiary)',
          marginTop: '2px',
        }}>
          {description}
        </div>
      </div>
    </button>
  );
}


function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="card" style={{ padding: 'var(--space-lg)' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        marginBottom: 'var(--space-sm)',
      }}>
        <div style={{ color: 'var(--color-text-tertiary)' }}>{icon}</div>
        <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
      </div>
      <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
        {value}
      </div>
    </div>
  );
}

/** Returns YYYY-MM-DD for this week's Monday (ISO week start). */
function getThisWeekMonday(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // days back to Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return localDateString(monday);
}
