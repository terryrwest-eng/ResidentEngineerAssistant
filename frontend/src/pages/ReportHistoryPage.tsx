/**
 * Daily Reporter V3 — Report History Page
 *
 * Full history browser backed by GET /api/reports.
 * Features:
 * - Live search by project name
 * - Date range (from / to) filters
 * - Status filter (all / draft / submitted)
 * - Sortable columns (date, project, activities, status)
 * - Click row → open report editor
 * - Delete row with confirmation
 * - Pagination (20 per page)
 *
 * WHY no backend changes: GET /api/reports already supports all
 * of these query params (status, project, date_from, date_to, limit, offset).
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { reportApi } from '@/lib/api';
import {
  Search,
  CalendarRange,
  Filter,
  FilePlus,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Loader2,
  AlertCircle,
  FileText,
  RefreshCw,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReportSummary {
  id: string;
  project_name: string;
  report_date: string;
  status: string;
  activity_count: number;
  updated_at: string;
  created_at: string;
}

type SortField = 'report_date' | 'project_name' | 'activity_count' | 'status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;

// ─── Component ───────────────────────────────────────────────────────────────

export function ReportHistoryPage() {
  const navigate = useNavigate();

  // --- Filter state ---
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // --- Sort state ---
  const [sortField, setSortField] = useState<SortField>('report_date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // --- Pagination ---
  const [page, setPage] = useState(0); // 0-indexed

  // --- Data ---
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Delete state ---
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Debounce ref for search
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Load reports ──────────────────────────────────────────────────────────

  const load = useCallback(async (params: {
    search: string;
    dateFrom: string;
    dateTo: string;
    status: string;
    page: number;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const data = await reportApi.list({
        limit: PAGE_SIZE,
        offset: params.page * PAGE_SIZE,
        status: params.status || undefined,
        project: params.search || undefined,
        date_from: params.dateFrom || undefined,
        date_to: params.dateTo || undefined,
      });
      setReports(data.reports || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('[ReportHistory] Load failed:', err);
      setError('Failed to load reports. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + filter-driven reload
  useEffect(() => {
    setPage(0);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      load({ search, dateFrom, dateTo, status: statusFilter, page: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [search, dateFrom, dateTo, statusFilter, load]);

  // Page change
  useEffect(() => {
    load({ search, dateFrom, dateTo, status: statusFilter, page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // ─── Sort (client-side on loaded page) ────────────────────────────────────

  const sortedReports = [...reports].sort((a, b) => {
    let av: string | number = a[sortField] ?? '';
    let bv: string | number = b[sortField] ?? '';
    if (sortField === 'activity_count') {
      av = Number(av);
      bv = Number(bv);
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'report_date' ? 'desc' : 'asc');
    }
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    setDeletingId(id);
    setConfirmDeleteId(null);
    try {
      await reportApi.delete(id);
      setReports((prev) => prev.filter((r) => r.id !== id));
      setTotal((t) => t - 1);
    } catch (err) {
      console.error('[ReportHistory] Delete failed:', err);
      setError('Failed to delete report.');
    } finally {
      setDeletingId(null);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function clearFilters() {
    setSearch('');
    setDateFrom('');
    setDateTo('');
    setStatusFilter('');
    setPage(0);
  }

  const hasFilters = search || dateFrom || dateTo || statusFilter;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Page Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Report History</h1>
          <p>{loading ? 'Loading...' : `${total} report${total !== 1 ? 's' : ''} total`}</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/report/new')}>
          <FilePlus size={16} />
          New Report
        </button>
      </div>

      {/* ── Filter Bar ── */}
      <div className="card" style={{ marginBottom: 'var(--space-lg)', padding: 'var(--space-md) var(--space-lg)' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto auto auto',
          gap: 'var(--space-sm)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}>
          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Search size={15} style={{
              position: 'absolute', left: '10px', top: '50%',
              transform: 'translateY(-50%)', color: 'var(--color-text-placeholder)',
              pointerEvents: 'none',
            }} />
            <input
              id="history-search"
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by project name..."
              style={{ paddingLeft: '32px' }}
            />
          </div>

          {/* Date From */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
            <CalendarRange size={15} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
            <input
              id="history-date-from"
              className="input"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{ width: '140px' }}
              title="From date"
            />
          </div>

          {/* Date To */}
          <input
            id="history-date-to"
            className="input"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={{ width: '140px' }}
            title="To date"
          />

          {/* Status Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
            <Filter size={15} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
            <select
              id="history-status-filter"
              className="input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ width: '130px' }}
            >
              <option value="">All Status</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
            </select>
          </div>

          {/* Clear / Refresh */}
          <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
            {hasFilters && (
              <button className="btn btn-ghost btn-sm" onClick={clearFilters} title="Clear filters">
                Clear
              </button>
            )}
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => load({ search, dateFrom, dateTo, status: statusFilter, page })}
              title="Refresh"
              style={{ width: '36px', height: '36px' }}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Error Banner ── */}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
          padding: 'var(--space-md)', marginBottom: 'var(--space-md)',
          background: 'var(--color-danger-light)', borderRadius: 'var(--radius-sm)',
          color: 'var(--color-danger)', fontSize: '0.875rem',
        }}>
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {/* ── Report Table ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div className="empty-state" style={{ padding: 'var(--space-2xl) 0' }}>
            <Loader2 size={32} style={{ animation: 'spin 0.7s linear infinite', opacity: 0.4 }} />
            <p style={{ marginTop: 'var(--space-md)', color: 'var(--color-text-tertiary)' }}>Loading reports...</p>
          </div>
        ) : sortedReports.length === 0 ? (
          <div className="empty-state" style={{ padding: 'var(--space-2xl) 0' }}>
            <FileText size={48} style={{ opacity: 0.2 }} />
            <h3 style={{ marginTop: 'var(--space-md)' }}>
              {hasFilters ? 'No reports match your filters' : 'No reports yet'}
            </h3>
            <p style={{ color: 'var(--color-text-tertiary)', marginTop: 'var(--space-xs)' }}>
              {hasFilters ? (
                <button className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear filters</button>
              ) : (
                'Start by creating your first daily report.'
              )}
            </p>
            {!hasFilters && (
              <button className="btn btn-primary" style={{ marginTop: 'var(--space-md)' }} onClick={() => navigate('/report/new')}>
                <FilePlus size={16} />
                New Report
              </button>
            )}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: '600px' }}>
              <thead>
                <tr>
                  <SortHeader label="Date" field="report_date" current={sortField} dir={sortDir} onClick={handleSort} />
                  <SortHeader label="Project" field="project_name" current={sortField} dir={sortDir} onClick={handleSort} />
                  <SortHeader label="Activities" field="activity_count" current={sortField} dir={sortDir} onClick={handleSort} />
                  <SortHeader label="Status" field="status" current={sortField} dir={sortDir} onClick={handleSort} />
                  <th style={{ fontSize: '0.75rem', fontWeight: 600, padding: '10px 12px', width: '60px' }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedReports.map((report) => (
                  <tr
                    key={report.id}
                    onClick={() => navigate(`/report/${report.id}`)}
                    style={{
                      cursor: 'pointer',
                      opacity: deletingId === report.id ? 0.4 : 1,
                      transition: 'opacity 0.15s ease',
                    }}
                  >
                    <td className="mono" style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                      {formatDate(report.report_date)}
                    </td>
                    <td style={{ fontWeight: 500 }}>
                      {report.project_name || <span style={{ color: 'var(--color-text-placeholder)' }}>Untitled</span>}
                    </td>
                    <td style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                      {report.activity_count ?? 0}
                    </td>
                    <td>
                      <StatusBadge status={report.status} />
                    </td>
                    <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
                      {confirmDeleteId === report.id ? (
                        <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDelete(report.id)}
                            disabled={!!deletingId}
                            style={{ fontSize: '0.6875rem', padding: '2px 8px' }}
                          >
                            Delete
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setConfirmDeleteId(null)}
                            style={{ fontSize: '0.6875rem', padding: '2px 6px' }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() => setConfirmDeleteId(report.id)}
                          disabled={!!deletingId}
                          title="Delete report"
                          style={{ width: '28px', height: '28px', padding: '4px' }}
                        >
                          <Trash2 size={14} style={{ color: 'var(--color-text-placeholder)' }} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && !loading && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 'var(--space-md)',
          fontSize: '0.8125rem',
          color: 'var(--color-text-tertiary)',
        }}>
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              ← Prev
            </button>
            {Array.from({ length: totalPages }, (_, i) => i)
              .filter((i) => Math.abs(i - page) <= 2)
              .map((i) => (
                <button
                  key={i}
                  className={`btn btn-sm ${i === page ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setPage(i)}
                  style={{ minWidth: '32px' }}
                >
                  {i + 1}
                </button>
              ))}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SortHeader({
  label,
  field,
  current,
  dir,
  onClick,
}: {
  label: string;
  field: SortField;
  current: SortField;
  dir: SortDir;
  onClick: (f: SortField) => void;
}) {
  const active = field === current;
  return (
    <th
      onClick={() => onClick(field)}
      style={{
        fontSize: '0.75rem',
        fontWeight: 600,
        padding: '10px 12px',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        color: active ? 'var(--color-accent)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        {label}
        {active ? (
          dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />
        ) : (
          <ChevronsUpDown size={13} style={{ opacity: 0.35 }} />
        )}
      </div>
    </th>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    submitted: { bg: 'var(--color-success-light)', color: 'var(--color-success)', label: 'Submitted' },
    draft: { bg: 'var(--color-info-light)', color: 'var(--color-info)', label: 'Draft' },
  };
  const s = map[status] || { bg: 'var(--color-surface-hover)', color: 'var(--color-text-tertiary)', label: status || 'Unknown' };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '999px',
      fontSize: '0.6875rem',
      fontWeight: 600,
      background: s.bg,
      color: s.color,
    }}>
      {s.label}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '—';
  // YYYY-MM-DD → May 14, 2026
  try {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return iso;
  }
}
