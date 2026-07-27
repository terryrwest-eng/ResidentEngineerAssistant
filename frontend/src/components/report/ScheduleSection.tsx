/**
 * Daily Reporter V3 — Schedule Section (Report Page)
 *
 * Collapsible section on the report page for uploading and viewing schedules.
 * Supports both paving/digout schedules AND 3-week construction lookahead.
 * AI parses the PDF → shifts, locations, tonnage extracted.
 *
 * This is the primary schedule management UI, placed above Activities.
 */

import { useState, useRef, useEffect } from 'react';
import { scheduleApi } from '@/lib/api';
import type { Schedule } from '@/types';
import {
  CalendarDays, Upload, Loader2, Trash2,
  ChevronDown, ChevronRight, AlertCircle,
} from 'lucide-react';

// ============================================
// Types
// ============================================

interface ScheduleListItem {
  id: string;
  filename: string;
  uploaded_at: string;
  total_shifts: number;
  schedule_type?: string;
}

// ============================================
// Component
// ============================================

export function ScheduleSection() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleListItem[]>([]);
  const [activeSchedule, setActiveSchedule] = useState<Schedule | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedShift, setExpandedShift] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load schedules on mount
  useEffect(() => {
    loadSchedules();
  }, []);

  async function loadSchedules() {
    setIsLoading(true);
    try {
      const result = await scheduleApi.list();
      setSchedules(result.schedules || []);
      console.debug('[ScheduleSection] Loaded', result.count, 'schedules');

      if ((result.schedules || []).length > 0) {
        try {
          const active = await scheduleApi.getActive();
          setActiveSchedule(active);
          const keys = Object.keys(active.shifts || {}).sort();
          if (keys.length > 0) setExpandedShift(keys[0]);
        } catch {
          console.debug('[ScheduleSection] No active schedule');
        }
      }
    } catch (err) {
      console.error('[ScheduleSection] Failed to load:', err);
      setError('Failed to load schedules.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf') {
      setError('Only PDF files are supported.');
      return;
    }

    setIsUploading(true);
    setError(null);
    try {
      console.debug('[ScheduleSection] Uploading:', file.name);
      const result = await scheduleApi.upload(file);
      console.debug('[ScheduleSection] Upload complete:', result.id, result.total_shifts, 'shifts');
      setActiveSchedule(result);
      const keys = Object.keys(result.shifts || {}).sort();
      if (keys.length > 0) setExpandedShift(keys[0]);
      await loadSchedules();
      setIsExpanded(true); // Auto-expand after upload
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setError(msg);
      console.error('[ScheduleSection] Upload failed:', err);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this schedule?')) return;
    try {
      await scheduleApi.delete(id);
      console.debug('[ScheduleSection] Deleted:', id);
      if (activeSchedule?.id === id) {
        setActiveSchedule(null);
        setExpandedShift(null);
      }
      await loadSchedules();
    } catch (err) {
      console.error('[ScheduleSection] Delete failed:', err);
    }
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return iso; }
  }

  const scheduleCount = schedules.length;
  const activeShiftCount = activeSchedule ? Object.keys(activeSchedule.shifts || {}).length : 0;

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {/* Collapsible Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: 'var(--space-md) var(--space-lg)',
          border: 'none',
          background: isExpanded ? 'var(--color-accent-light)' : 'var(--color-surface)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
          transition: 'background 0.12s ease',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <CalendarDays size={18} style={{ color: 'var(--color-accent)' }} />
          <span className="font-semibold" style={{ fontSize: '0.9375rem' }}>
            Schedule
          </span>
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-md)',
          fontSize: '0.75rem',
          color: 'var(--color-text-tertiary)',
        }}>
          {activeSchedule && (
            <span style={{
              background: 'var(--color-accent)',
              color: '#fff',
              padding: '1px 8px',
              borderRadius: '10px',
              fontWeight: 600,
              fontSize: '0.7rem',
            }}>
              {activeShiftCount} shift{activeShiftCount !== 1 ? 's' : ''}
            </span>
          )}
          {scheduleCount > 0 && !activeSchedule && (
            <span>{scheduleCount} uploaded</span>
          )}
          {scheduleCount === 0 && (
            <span>None uploaded</span>
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="card-body" style={{ borderTop: '1px solid var(--color-border)' }}>

          {/* Upload button */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 'var(--space-md)',
          }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
              Upload schedule PDFs — AI extracts shifts, locations, and tonnage
            </span>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                onChange={handleUpload}
                style={{ display: 'none' }}
              />
              <button
                className="btn btn-outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                style={{ fontSize: '0.8rem', padding: '4px 12px' }}
              >
                {isUploading ? (
                  <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Parsing...</>
                ) : (
                  <><Upload size={14} /> Upload PDF</>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div style={{
              marginBottom: 'var(--space-md)',
              padding: 'var(--space-sm) var(--space-md)',
              background: 'var(--color-danger-light)', border: '1px solid var(--color-danger-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-danger)', fontSize: '0.875rem',
              display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
            }}>
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          {/* Loading state */}
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: 'var(--space-lg)' }}>
              <Loader2 size={24} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--color-accent)' }} />
            </div>
          ) : schedules.length === 0 ? (
            /* Empty state */
            <div style={{
              padding: 'var(--space-lg)',
              textAlign: 'center',
              color: 'var(--color-text-tertiary)',
              fontSize: '0.875rem',
              background: 'var(--color-bg)',
              borderRadius: 'var(--radius-md)',
              border: '1px dashed var(--color-border)',
            }}>
              <CalendarDays size={28} style={{ opacity: 0.3, marginBottom: 'var(--space-xs)' }} />
              <p style={{ margin: 0 }}>No schedules uploaded</p>
              <p style={{ margin: '4px 0 0', fontSize: '0.75rem' }}>
                Upload a paving, digout, or 3-week lookahead schedule
              </p>
            </div>
          ) : (
            /* Schedule list */
            <div style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-md)',
            }}>
              {schedules.map((s, i) => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                    padding: 'var(--space-sm) var(--space-md)',
                    borderBottom: i < schedules.length - 1 ? '1px solid var(--color-border)' : 'none',
                    background: activeSchedule?.id === s.id ? 'var(--color-accent-light)' : 'transparent',
                  }}
                >
                  <CalendarDays size={16} style={{
                    color: activeSchedule?.id === s.id ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '0.8125rem', fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {s.filename}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--color-text-tertiary)' }}>
                      {s.total_shifts} shift{s.total_shifts !== 1 ? 's' : ''} • {formatDate(s.uploaded_at)}
                    </div>
                  </div>
                  {activeSchedule?.id === s.id && (
                    <span className="badge badge-info" style={{ fontSize: '0.65rem', flexShrink: 0 }}>Active</span>
                  )}
                  <button
                    className="btn-icon"
                    onClick={() => handleDelete(s.id)}
                    title="Delete schedule"
                    style={{ flexShrink: 0 }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Active schedule detail view — shift list */}
          {activeSchedule && activeSchedule.shifts && Object.keys(activeSchedule.shifts).length > 0 && (
            <div>
              <label className="label" style={{ marginBottom: 'var(--space-sm)' }}>
                Active: {activeSchedule.filename} — {activeShiftCount} Shift{activeShiftCount !== 1 ? 's' : ''}
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                {Object.keys(activeSchedule.shifts).sort().map(shiftKey => {
                  const shift = activeSchedule.shifts[shiftKey];
                  const isShiftExpanded = expandedShift === shiftKey;
                  return (
                    <div key={shiftKey} style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      overflow: 'hidden',
                    }}>
                      {/* Shift header */}
                      <div
                        onClick={() => setExpandedShift(isShiftExpanded ? null : shiftKey)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: 'var(--space-sm) var(--space-md)',
                          background: isShiftExpanded ? 'var(--color-accent-light)' : 'var(--color-bg)',
                          cursor: 'pointer',
                          transition: 'background 0.12s ease',
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                          Shift {shiftKey}
                          {activeSchedule?.schedule_type === 'grind_overlay' && (
                            <span style={{ marginLeft: 8, fontSize: '0.65rem', padding: '1px 6px', borderRadius: 4, background: 'var(--color-info-light)', color: 'var(--color-info)', fontWeight: 500 }}>G&O</span>
                          )}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                          {shift.rows?.length || 0} rows • {(shift.total_sf || 0).toLocaleString()} SF • {(shift.total_tons || 0).toLocaleString()} Tons
                        </span>
                      </div>

                      {/* Expanded: rows table */}
                      {isShiftExpanded && shift.rows && shift.rows.length > 0 && (
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}>
                                <th style={TH_STYLE}>Direction</th>
                                <th style={TH_STYLE}>DO#</th>
                                <th style={TH_STYLE}>Depth</th>
                                {activeSchedule?.schedule_type !== 'grind_overlay' && <th style={TH_STYLE}>W</th>}
                                {activeSchedule?.schedule_type !== 'grind_overlay' && <th style={TH_STYLE}>L</th>}
                                <th style={TH_STYLE}>SF</th>
                                <th style={TH_STYLE}>Tons</th>
                              </tr>
                            </thead>
                            <tbody>
                              {shift.rows.map((row: { direction: string; do_number: string; depth: number; width: number; length: number; sf: number; tons: number; added?: boolean }, ri: number) => (
                                <tr key={ri} style={{ borderBottom: '1px solid var(--color-border)' }}>
                                  <td style={TD_STYLE}>{row.direction}</td>
                                  <td style={TD_STYLE}>{row.do_number}{row.added ? ' ⊕' : ''}</td>
                                  <td style={TD_STYLE}>{row.depth}&apos;</td>
                                  {activeSchedule?.schedule_type !== 'grind_overlay' && <td style={TD_STYLE}>{row.width}</td>}
                                  {activeSchedule?.schedule_type !== 'grind_overlay' && <td style={TD_STYLE}>{row.length}</td>}
                                  <td style={TD_STYLE}>{row.sf.toLocaleString()}</td>
                                  <td style={TD_STYLE}>{row.tons}</td>
                                </tr>
                              ))}
                              <tr style={{ background: 'var(--color-bg)', fontWeight: 600 }}>
                                <td style={TD_STYLE} colSpan={activeSchedule?.schedule_type === 'grind_overlay' ? 3 : 5}>Total</td>
                                <td style={TD_STYLE}>{(shift.total_sf || 0).toLocaleString()}</td>
                                <td style={TD_STYLE}>{(shift.total_tons || 0).toLocaleString()}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// Table styles
// ============================================

const TH_STYLE: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontWeight: 600,
  fontSize: '0.7rem', color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};

const TD_STYLE: React.CSSProperties = {
  padding: '4px 8px', textAlign: 'left',
};
