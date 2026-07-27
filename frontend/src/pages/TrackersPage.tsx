/**
 * Daily Reporter V3 — Trackers Page
 * Four project-level tracking tables: Excavation, Pay Items, Punch List, Redlines.
 * Each tracker has full add/edit/delete. Inline row editing via a slide-in form panel.
 */

import { useState } from 'react';
import { useTracker } from '@/hooks/useTracker';
import { trackerApi } from '@/lib/trackerApi';
import { Shovel, ListChecks, AlertCircle, AlertTriangle, GitBranch, Plus, Pencil, Trash2, Loader2, X, Save } from 'lucide-react';

type TrackerTab = 'excavation' | 'payitems' | 'punchlist' | 'redlines';

const PRIORITY_COLORS: Record<string, string> = {
  Low: 'var(--color-success)', Medium: 'var(--color-warning)', High: 'var(--color-danger)', Critical: 'var(--color-ai)',
};
const STATUS_COLORS: Record<string, string> = {
  Open: 'var(--color-danger)', 'In Progress': 'var(--color-warning)', Closed: 'var(--color-success)',
  Pending: 'var(--color-warning)', Approved: 'var(--color-success)', Rejected: 'var(--color-danger)',
};

function StatusBadge({ value }: { value: string }) {
  const color = STATUS_COLORS[value] || 'var(--color-text-tertiary)';
  return (
    <span style={{ padding: '2px 10px', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 600, background: color + '20', color }}>
      {value}
    </span>
  );
}

function PriorityBadge({ value }: { value: string }) {
  const color = PRIORITY_COLORS[value] || 'var(--color-text-tertiary)';
  return (
    <span style={{ padding: '2px 10px', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 600, background: color + '20', color }}>
      {value}
    </span>
  );
}

export function TrackersPage() {
  const [tab, setTab] = useState<TrackerTab>('excavation');

  const tabs = [
    { id: 'excavation' as TrackerTab, label: 'Excavation Log', icon: <Shovel size={16} /> },
    { id: 'payitems' as TrackerTab, label: 'Pay Items', icon: <ListChecks size={16} /> },
    { id: 'punchlist' as TrackerTab, label: 'Punch List', icon: <AlertCircle size={16} /> },
    { id: 'redlines' as TrackerTab, label: 'Redlines', icon: <GitBranch size={16} /> },
  ];

  return (
    <div>
      <div style={{ marginBottom: 'var(--space-lg)' }}>
        <h1 style={{ margin: 0 }}>Project Trackers</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-tertiary)', fontSize: '0.875rem' }}>
          Project-level logs — saved separately from daily reports
        </p>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-xs)', marginBottom: 'var(--space-lg)', overflowX: 'auto' }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'excavation' && <ExcavationTracker />}
      {tab === 'payitems' && <PayItemTracker />}
      {tab === 'punchlist' && <PunchListTracker />}
      {tab === 'redlines' && <RedlineTracker />}
    </div>
  );
}

/* ─────────────────────────────────────
   SHARED: TrackerShell
───────────────────────────────────── */

type Field = { key: string; label: string; type?: string; options?: string[]; span?: number };

function TrackerShell({
  title, rows, isLoading, error,
  columns, fields, defaults,
  onSave, onDelete,
  renderCell,
  summaryRow,
}: {
  title: string;
  rows: Record<string, unknown>[];
  isLoading: boolean;
  error: string | null;
  columns: { key: string; label: string; render?: (row: Record<string, unknown>) => React.ReactNode }[];
  fields: Field[];
  defaults: Record<string, unknown>;
  onSave: (id: string | null, data: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  renderCell?: (key: string, row: Record<string, unknown>) => React.ReactNode;
  summaryRow?: React.ReactNode;
}) {
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  function openNew() { setEditing({ ...defaults }); }
  function openEdit(row: Record<string, unknown>) { setEditing({ ...row }); }
  function close() { setEditing(null); }

  async function handleSave() {
    if (!editing) return;
    setIsSaving(true);
    try {
      await onSave(editing.id as string | null, editing);
      close();
    } catch (e) {
      console.error('[TrackerShell] save error:', e);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleteId(id);
    try { await onDelete(id); } finally { setDeleteId(null); }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{title} <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400, fontSize: '0.875rem' }}>({rows.length})</span></h3>
        <button className="btn btn-primary btn-sm" onClick={openNew}><Plus size={14} /> Add Entry</button>
      </div>

      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
          padding: 'var(--space-md) var(--space-lg)',
          color: 'var(--color-danger)', fontSize: '0.875rem',
        }}>
          <AlertTriangle size={15} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => <th key={c.key}>{c.label}</th>)}
              <th style={{ width: 80 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={columns.length + 1} style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--color-text-tertiary)' }}>
                <Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} />
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--color-text-tertiary)' }}>
                No entries yet. Click "Add Entry" to start.
              </td></tr>
            ) : rows.map((row) => (
              <tr key={row.id as string}>
                {columns.map((c) => (
                  <td key={c.key}>
                    {renderCell ? renderCell(c.key, row) : (c.render ? c.render(row) : String(row[c.key] ?? ''))}
                  </td>
                ))}
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost btn-icon" onClick={() => openEdit(row)} title="Edit"><Pencil size={14} /></button>
                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={() => handleDelete(row.id as string)}
                      disabled={deleteId === row.id}
                      style={{ color: 'var(--color-danger)' }}
                      title="Delete"
                    >
                      {deleteId === row.id ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Trash2 size={14} />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {summaryRow}
          </tbody>
        </table>
      </div>

      {/* Edit Panel */}
      {editing && (
        <div className="dialog-overlay">
          <div className="dialog" style={{ maxWidth: 640, width: '95vw' }}>
            <div className="dialog-header">
              <h3 style={{ margin: 0 }}>{editing.id ? 'Edit Entry' : 'New Entry'}</h3>
              <button className="btn btn-ghost btn-icon" onClick={close}><X size={18} /></button>
            </div>
            <div className="dialog-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }}>
                {fields.map((f) => (
                  <div key={f.key} style={{ gridColumn: f.span === 2 ? 'span 2' : 'span 1' }}>
                    <label className="label">{f.label}</label>
                    {f.options ? (
                      <select
                        className="input"
                        value={String(editing[f.key] ?? '')}
                        onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })}
                      >
                        {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        className="input"
                        type={f.type || 'text'}
                        value={String(editing[f.key] ?? '')}
                        onChange={(e) => setEditing({ ...editing, [f.key]: f.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value })}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn btn-ghost" onClick={close}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
                {isSaving ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving...</> : <><Save size={14} /> Save</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────
   EXCAVATION TRACKER
───────────────────────────────────── */

function ExcavationTracker() {
  const { rows, isLoading, error, create, update, remove } = useTracker({
    list: trackerApi.listExcavation,
    create: trackerApi.createExcavation,
    update: trackerApi.updateExcavation,
    remove: trackerApi.deleteExcavation,
  });

  const totalCY = rows.reduce((s, r) => s + (Number(r.volume_cy) || 0), 0);

  async function onSave(id: string | null, data: Record<string, unknown>) {
    if (id) await update(id, data); else await create(data);
  }

  const columns = [
    { key: 'date', label: 'Date' },
    { key: 'location', label: 'Location' },
    { key: 'station_from', label: 'Sta From' },
    { key: 'station_to', label: 'Sta To' },
    { key: 'length_lf', label: 'LF' },
    { key: 'width_ft', label: 'W (ft)' },
    { key: 'depth_ft', label: 'D (ft)' },
    { key: 'volume_cy', label: 'CY', render: (r: Record<string, unknown>) => <strong>{Number(r.volume_cy || 0).toFixed(1)}</strong> },
    { key: 'soil_type', label: 'Soil' },
  ];

  const fields: Field[] = [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'location', label: 'Location', span: 2 },
    { key: 'station_from', label: 'Station From' },
    { key: 'station_to', label: 'Station To' },
    { key: 'length_lf', label: 'Length (LF)', type: 'number' },
    { key: 'width_ft', label: 'Width (ft)', type: 'number' },
    { key: 'depth_ft', label: 'Depth (ft)', type: 'number' },
    { key: 'soil_type', label: 'Soil Type' },
    { key: 'notes', label: 'Notes', span: 2 },
  ];

  const summaryRow = (
    <tr style={{ background: 'var(--color-accent-light)', fontWeight: 600 }}>
      <td colSpan={7} style={{ textAlign: 'right', color: 'var(--color-accent)' }}>Total CY:</td>
      <td style={{ color: 'var(--color-accent)' }}>{totalCY.toFixed(1)}</td>
      <td />
    </tr>
  );

  return (
    <TrackerShell
      title="Excavation Log" rows={rows} isLoading={isLoading} error={error}
      columns={columns} fields={fields}
      defaults={{ date: '', location: '', station_from: '', station_to: '', length_lf: 0, width_ft: 0, depth_ft: 0, soil_type: '', notes: '' }}
      onSave={onSave} onDelete={remove}
      summaryRow={summaryRow}
    />
  );
}

/* ─────────────────────────────────────
   PAY ITEM TRACKER
───────────────────────────────────── */

function PayItemTracker() {
  const { rows, isLoading, error, create, update, remove } = useTracker({
    list: trackerApi.listPayItems,
    create: trackerApi.createPayItem,
    update: trackerApi.updatePayItem,
    remove: trackerApi.deletePayItem,
  });

  async function onSave(id: string | null, data: Record<string, unknown>) {
    if (id) await update(id, data); else await create(data);
  }

  function pctColor(pct: number) {
    if (pct >= 100) return 'var(--color-success)';
    if (pct >= 75) return 'var(--color-accent)';
    if (pct >= 50) return 'var(--color-warning)';
    return 'var(--color-danger)';
  }

  const columns = [
    { key: 'bid_item', label: 'Bid Item' },
    { key: 'description', label: 'Description' },
    { key: 'unit', label: 'Unit' },
    { key: 'contract_qty', label: 'Contract Qty' },
    { key: 'running_total', label: 'To Date' },
    {
      key: 'percent_complete', label: '% Complete',
      render: (r: Record<string, unknown>) => {
        const pct = Number(r.percent_complete || 0);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, height: 6, background: 'var(--color-border)', borderRadius: 3 }}>
              <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: pctColor(pct), borderRadius: 3 }} />
            </div>
            <span style={{ fontWeight: 600, color: pctColor(pct), fontSize: '0.8125rem', minWidth: 36 }}>{pct}%</span>
          </div>
        );
      }
    },
    { key: 'contract_value', label: 'Contract $', render: (r: Record<string, unknown>) => `$${Number(r.contract_value || 0).toLocaleString()}` },
  ];

  const fields: Field[] = [
    { key: 'bid_item', label: 'Bid Item #' },
    { key: 'unit', label: 'Unit (LF, EA, CY…)' },
    { key: 'description', label: 'Description', span: 2 },
    { key: 'contract_qty', label: 'Contract Qty', type: 'number' },
    { key: 'unit_price', label: 'Unit Price ($)', type: 'number' },
    { key: 'running_total', label: 'Running Total (to date)', type: 'number' },
    { key: 'notes', label: 'Notes', span: 2 },
  ];

  return (
    <TrackerShell
      title="Pay Item Tracker" rows={rows} isLoading={isLoading} error={error}
      columns={columns} fields={fields}
      defaults={{ bid_item: '', description: '', unit: '', contract_qty: 0, unit_price: 0, running_total: 0, notes: '' }}
      onSave={onSave} onDelete={remove}
    />
  );
}

/* ─────────────────────────────────────
   PUNCH LIST
───────────────────────────────────── */

function PunchListTracker() {
  const { rows, isLoading, error, create, update, remove } = useTracker({
    list: trackerApi.listPunchList,
    create: trackerApi.createPunchItem,
    update: trackerApi.updatePunchItem,
    remove: trackerApi.deletePunchItem,
  });

  async function onSave(id: string | null, data: Record<string, unknown>) {
    if (id) await update(id, data); else await create(data);
  }

  const columns = [
    { key: 'item_number', label: '#', render: (r: Record<string, unknown>) => <strong>#{String(r.item_number || '')}</strong> },
    { key: 'date_opened', label: 'Opened' },
    { key: 'description', label: 'Description' },
    { key: 'location', label: 'Location' },
    { key: 'assigned_to', label: 'Assigned To' },
    { key: 'priority', label: 'Priority', render: (r: Record<string, unknown>) => <PriorityBadge value={String(r.priority || '')} /> },
    { key: 'status', label: 'Status', render: (r: Record<string, unknown>) => <StatusBadge value={String(r.status || '')} /> },
    { key: 'date_closed', label: 'Closed' },
  ];

  const fields: Field[] = [
    { key: 'date_opened', label: 'Date Opened', type: 'date' },
    { key: 'date_closed', label: 'Date Closed', type: 'date' },
    { key: 'description', label: 'Description', span: 2 },
    { key: 'location', label: 'Location', span: 2 },
    { key: 'assigned_to', label: 'Assigned To' },
    { key: 'priority', label: 'Priority', options: ['Low', 'Medium', 'High', 'Critical'] },
    { key: 'status', label: 'Status', options: ['Open', 'In Progress', 'Closed'] },
    { key: 'notes', label: 'Notes', span: 2 },
  ];

  const openCount = rows.filter((r) => r.status !== 'Closed').length;
  const closedCount = rows.filter((r) => r.status === 'Closed').length;

  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
        {[
          { label: 'Open', count: openCount, color: 'var(--color-danger)' },
          { label: 'Closed', count: closedCount, color: 'var(--color-success)' },
          { label: 'Total', count: rows.length, color: 'var(--color-text-secondary)' },
        ].map((s) => (
          <div key={s.label} style={{ padding: 'var(--space-md)', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', minWidth: 80, textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: s.color }}>{s.count}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>{s.label}</div>
          </div>
        ))}
      </div>
      <TrackerShell
        title="Punch List" rows={rows} isLoading={isLoading} error={error}
        columns={columns} fields={fields}
        defaults={{ date_opened: '', date_closed: '', description: '', location: '', assigned_to: '', priority: 'Medium', status: 'Open', notes: '' }}
        onSave={onSave} onDelete={remove}
      />
    </div>
  );
}

/* ─────────────────────────────────────
   REDLINE TRACKER
───────────────────────────────────── */

function RedlineTracker() {
  const { rows, isLoading, error, create, update, remove } = useTracker({
    list: trackerApi.listRedlines,
    create: trackerApi.createRedline,
    update: trackerApi.updateRedline,
    remove: trackerApi.deleteRedline,
  });

  async function onSave(id: string | null, data: Record<string, unknown>) {
    if (id) await update(id, data); else await create(data);
  }

  const columns = [
    { key: 'date', label: 'Date' },
    { key: 'sheet_number', label: 'Sheet #' },
    { key: 'description', label: 'Description' },
    { key: 'location', label: 'Location' },
    { key: 'change_type', label: 'Type' },
    { key: 'submitted_by', label: 'Submitted By' },
    { key: 'status', label: 'Status', render: (r: Record<string, unknown>) => <StatusBadge value={String(r.status || '')} /> },
  ];

  const fields: Field[] = [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'sheet_number', label: 'Sheet #' },
    { key: 'description', label: 'Description', span: 2 },
    { key: 'location', label: 'Location' },
    { key: 'station', label: 'Station' },
    { key: 'change_type', label: 'Change Type', options: ['Alignment', 'Elevation', 'Material', 'Structure', 'Other'] },
    { key: 'submitted_by', label: 'Submitted By' },
    { key: 'status', label: 'Status', options: ['Pending', 'Approved', 'Rejected'] },
    { key: 'notes', label: 'Notes', span: 2 },
  ];

  return (
    <TrackerShell
      title="Redline Tracker" rows={rows} isLoading={isLoading} error={error}
      columns={columns} fields={fields}
      defaults={{ date: '', sheet_number: '', description: '', location: '', station: '', change_type: 'Other', submitted_by: '', status: 'Pending', notes: '' }}
      onSave={onSave} onDelete={remove}
    />
  );
}
