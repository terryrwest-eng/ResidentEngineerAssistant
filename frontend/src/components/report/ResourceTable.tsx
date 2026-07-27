/**
 * Daily Reporter V3 — Resource Table (Manpower / Equipment)
 *
 * Full-featured inline-editable table matching the original app's layout.
 * Features:
 * - PMWeb LL/LE resource dropdown (first column)
 * - Multi-select rows with checkbox
 * - Bulk Apply row (Hours, Start, Stop, Company, 3rd/EW/Con checkboxes)
 * - Start/Stop time columns
 * - 3rd Party, Extra Work, Consultant checkboxes per row
 * - Rental checkbox (equipment only)
 * - Duplicate row button
 * - Row lock (protected from bulk apply)
 */

import { useState, useEffect, useRef } from 'react';
import type { ManpowerRow, EquipmentRow } from '@/types';
import { DEFAULT_MANPOWER, DEFAULT_EQUIPMENT, DEFAULT_COMPANY } from '@/lib/constants';
import { settingsApi } from '@/lib/settingsApi';
import { ResourceDropdown } from '@/components/report/ResourceDropdown';
import { Plus, Trash2, Copy, Lock, Unlock } from 'lucide-react';

type ResourceType = 'manpower' | 'equipment';

interface ResourceTableProps {
  type: ResourceType;
  rows: (ManpowerRow | EquipmentRow)[];
  onChange: (rows: (ManpowerRow | EquipmentRow)[]) => void;
  companyOptions?: string[];
  defaultStartTime?: string;
  defaultStopTime?: string;
  /** Default hours for new rows + bulk apply (cascaded from manpower) */
  defaultHours?: number;
  /** Default company for new rows + bulk apply (cascaded from manpower) */
  defaultCompany?: string;
}

/** Default companies if none provided from settings */
const FALLBACK_COMPANIES = [
  'OHL NA', 'SRK Eng', 'AR Concrete', 'Brino Builders',
  'NorCal Pipeline', 'City of San Diego', 'Jacobs', 'RJ Noble',
  'Deans Welding', 'IQC Infrastructure', 'HMS', 'Z-Trucking',
  'United Rentals', 'Herc', 'Cor-Pro', 'Concrete Coring Company',
  'GC Fence', 'Pickette Fences', 'Western Gardens Landscape Inc.',
  'Oday Consultants',
];

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ResourceTable({
  type,
  rows,
  onChange,
  companyOptions = FALLBACK_COMPANIES,
  defaultStartTime = '7:00 AM',
  defaultStopTime = '3:30 PM',
  defaultHours,
  defaultCompany,
}: ResourceTableProps) {
  const isManpower = type === 'manpower';

  // Load custom resource codes from settings and merge with hardcoded defaults
  const [customCodes, setCustomCodes] = useState<string[]>([]);
  useEffect(() => {
    settingsApi.get()
      .then(s => {
        const codes = isManpower
          ? (s.custom_resource_codes?.labor || [])
          : (s.custom_resource_codes?.equipment || []);
        setCustomCodes(codes);
        console.debug(`[ResourceTable] Loaded ${codes.length} custom ${type} codes`);
      })
      .catch(err => console.warn('[ResourceTable] Failed to load custom codes:', err));
  }, [isManpower, type]);

  const options = isManpower
    ? Array.from(new Set([...DEFAULT_MANPOWER, ...customCodes]))
    : Array.from(new Set([...DEFAULT_EQUIPMENT, ...customCodes]));

  // --- Multi-select state ---
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  // --- Bulk apply state ---
  const [bulkHours, setBulkHours] = useState(defaultHours ? String(defaultHours) : '');
  const [bulkStartTime, setBulkStartTime] = useState(defaultStartTime);
  const [bulkStopTime, setBulkStopTime] = useState(defaultStopTime);
  const [bulkCompany, setBulkCompany] = useState(defaultCompany || '');
  const [bulk3rdParty, setBulk3rdParty] = useState(false);
  const [bulkEW, setBulkEW] = useState(false);
  const [bulkConsultant, setBulkConsultant] = useState(false);
  const [bulkRental, setBulkRental] = useState(false);

  // Track initial mount to avoid overwriting user edits on first render
  const isFirstRenderRef = useRef(true);

  // Sync bulk apply defaults when props change (manpower → equipment cascade).
  // Skips the initial mount so we don't clobber initial state.
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    console.debug(`[ResourceTable:${type}] Defaults cascaded — start=${defaultStartTime}, stop=${defaultStopTime}, hrs=${defaultHours}, co=${defaultCompany}`);
    setBulkStartTime(defaultStartTime);
    setBulkStopTime(defaultStopTime);
    if (defaultHours !== undefined) setBulkHours(String(defaultHours));
    if (defaultCompany !== undefined) setBulkCompany(defaultCompany);
  }, [defaultStartTime, defaultStopTime, defaultHours, defaultCompany, type]);

  // Ensure every row has a unique ID — rows loaded from saved reports
  // may lack IDs, causing updateRow (id === undefined) to match ALL rows.
  useEffect(() => {
    const needsIds = rows.some((r) => !r.id);
    if (needsIds) {
      console.warn(`[ResourceTable:${type}] Found rows without IDs — assigning now`);
      const fixed = rows.map((r) => (r.id ? r : { ...r, id: generateId() }));
      onChange(fixed);
    }
  }, [rows, type]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Row CRUD ---
  function addRow() {
    const newRow = isManpower
      ? {
          id: generateId(),
          trade: '',
          name: '',
          qty: 0,
          hours: 0,
          start_time: defaultStartTime,
          stop_time: defaultStopTime,
          company: DEFAULT_COMPANY,
          classification: '',
          is_3rd_party: false,
          is_extra_work: false,
          is_consultant: false,
          locked: false,
        } as ManpowerRow
      : {
          id: generateId(),
          name: '',
          description: '',
          qty: 0,
          hours: defaultHours || 0,
          start_time: defaultStartTime,
          stop_time: defaultStopTime,
          company: defaultCompany || DEFAULT_COMPANY,
          is_3rd_party: false,
          is_extra_work: false,
          is_consultant: false,
          is_rental: false,
          locked: false,
        } as EquipmentRow;

    onChange([...rows, newRow]);
  }

  function removeRow(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }

  function duplicateRow(idx: number) {
    const original = rows[idx];
    const clone = { ...original, id: generateId() };
    const updated = [...rows];
    updated.splice(idx + 1, 0, clone);
    onChange(updated);
  }

  function updateRow(id: string, field: string, value: string | number | boolean) {
    onChange(rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  // --- Multi-select ---
  function toggleSelection(idx: number) {
    const next = new Set(selectedRows);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setSelectedRows(next);
  }

  function toggleAll() {
    if (selectedRows.size === rows.length && rows.length > 0) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(rows.map((_, i) => i)));
    }
  }

  function deleteSelected() {
    if (selectedRows.size === 0) return;
    if (!window.confirm(`Delete ${selectedRows.size} selected rows?`)) return;
    onChange(rows.filter((_, i) => !selectedRows.has(i)));
    setSelectedRows(new Set());
  }

  // --- Bulk Apply ---
  function applyBulkValues() {
    const updates: Record<string, string | number | boolean> = {};
    const hrs = parseFloat(bulkHours);
    if (Number.isFinite(hrs) && hrs > 0) updates.hours = hrs;
    if (bulkStartTime) updates.start_time = bulkStartTime;
    if (bulkStopTime) updates.stop_time = bulkStopTime;
    if (bulkCompany) updates.company = bulkCompany;

    // Check we have at least one non-checkbox update
    const hasMeaningful = Object.keys(updates).length > 0;

    // Always apply checkbox values
    updates.is_3rd_party = bulk3rdParty;
    updates.is_extra_work = bulkEW;
    updates.is_consultant = bulkConsultant;
    if (!isManpower) updates.is_rental = bulkRental;

    if (!hasMeaningful) return;

    const updated = rows.map((r) => {
      if (r.locked) return r;
      // Skip rows without a resource selected
      const hasResource = isManpower ? (r as ManpowerRow).trade?.trim() : (r as EquipmentRow).name?.trim();
      if (!hasResource) return r;
      return { ...r, ...updates };
    });

    onChange(updated);

    // Reset bulk fields
    setBulkHours('');
    setBulkStartTime(defaultStartTime);
    setBulkStopTime(defaultStopTime);
    setBulkCompany('');
    setBulk3rdParty(false);
    setBulkEW(false);
    setBulkConsultant(false);
    setBulkRental(false);
  }

  // --- Styles ---
  const cellStyle: React.CSSProperties = { padding: '3px 4px', verticalAlign: 'middle' };
  const inputStyle: React.CSSProperties = { fontSize: '0.75rem', padding: '5px 6px', width: '100%', boxSizing: 'border-box' };
  const smallInputStyle: React.CSSProperties = { ...inputStyle, textAlign: 'center', maxWidth: '70px' };
  const checkboxColStyle: React.CSSProperties = { ...cellStyle, textAlign: 'center', width: '32px' };
  const headerStyle: React.CSSProperties = { fontSize: '0.6875rem', fontWeight: 600, padding: '6px 4px', whiteSpace: 'nowrap' };
  const checkLabelStyle: React.CSSProperties = { fontSize: '8px', color: 'var(--color-text-tertiary)', display: 'block', textAlign: 'center', lineHeight: 1 };

  return (
    <div style={{ marginBottom: 'var(--space-sm)' }}>
      <div className="resource-table-scroll" style={{ overflowX: 'auto' }}>
        <table className="table resource-table" style={{ minWidth: '1050px', fontSize: '0.75rem' }}>
          <thead>
            <tr>
              <th style={{ ...headerStyle, width: '30px', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selectedRows.size === rows.length}
                  onChange={toggleAll}
                  style={{ width: '14px', height: '14px' }}
                />
              </th>
              <th style={{ ...headerStyle, width: '22%' }}>{isManpower ? 'Resource' : 'Resource'}</th>
              <th style={{ ...headerStyle, width: '12%' }}>{isManpower ? 'Name' : 'Equip #'}</th>
              <th style={{ ...headerStyle, width: '6%', textAlign: 'center' }}>Qty</th>
              <th style={{ ...headerStyle, width: '6%', textAlign: 'center' }}>Hrs</th>
              <th style={{ ...headerStyle, width: '8%' }}>Start</th>
              <th style={{ ...headerStyle, width: '8%' }}>Stop</th>
              <th style={{ ...headerStyle, width: '14%' }}>Company</th>
              <th style={{ ...headerStyle, width: '10%', textAlign: 'center' }}>3rd / EW / Con</th>
              {!isManpower && <th style={{ ...headerStyle, width: '4%', textAlign: 'center' }}>Ren</th>}
              <th style={{ ...headerStyle, width: '4%', textAlign: 'center' }}></th>
              <th style={{ ...headerStyle, width: '3%', textAlign: 'center' }} title="Locked">
                <Lock size={11} style={{ display: 'inline', verticalAlign: 'middle' }} />
              </th>
            </tr>
          </thead>
          <tbody>
            {/* === BULK APPLY ROW === */}
            <tr style={{ background: 'var(--color-bg)', borderBottom: '2px solid var(--color-border)' }}>
              <td style={checkboxColStyle}>
                {selectedRows.size > 0 && (
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={deleteSelected}
                    title="Delete Selected"
                    style={{ width: '22px', height: '22px', padding: '2px' }}
                  >
                    <Trash2 size={12} style={{ color: 'var(--color-danger)' }} />
                  </button>
                )}
              </td>
              <td style={cellStyle}>
                <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Bulk Apply:</span>
              </td>
              <td style={cellStyle}><span style={{ color: 'var(--color-text-placeholder)', fontSize: '0.6875rem' }}>—</span></td>
              <td style={cellStyle}><span style={{ color: 'var(--color-text-placeholder)', fontSize: '0.6875rem', textAlign: 'center', display: 'block' }}>—</span></td>
              <td style={cellStyle}>
                <input className="input" type="number" value={bulkHours} onChange={(e) => setBulkHours(e.target.value)} placeholder="Hrs" style={smallInputStyle} />
              </td>
              <td style={cellStyle}>
                <input className="input" value={bulkStartTime} onChange={(e) => setBulkStartTime(e.target.value)} placeholder="Start" style={inputStyle} />
              </td>
              <td style={cellStyle}>
                <input className="input" value={bulkStopTime} onChange={(e) => setBulkStopTime(e.target.value)} placeholder="Stop" style={inputStyle} />
              </td>
              <td style={cellStyle}>
                <input
                  className="input"
                  value={bulkCompany}
                  onChange={(e) => setBulkCompany(e.target.value)}
                  placeholder="Company..."
                  list={`company-opts-bulk-${type}`}
                  style={inputStyle}
                  autoComplete="off"
                />
                <datalist id={`company-opts-bulk-${type}`}>
                  {companyOptions.map((co, i) => <option key={i} value={co} />)}
                </datalist>
              </td>
              <td style={{ ...cellStyle, textAlign: 'center' }}>
                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
                    <span style={checkLabelStyle}>3rd</span>
                    <input type="checkbox" checked={bulk3rdParty} onChange={(e) => setBulk3rdParty(e.target.checked)} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
                    <span style={checkLabelStyle}>EW</span>
                    <input type="checkbox" checked={bulkEW} onChange={(e) => setBulkEW(e.target.checked)} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
                    <span style={checkLabelStyle}>Con</span>
                    <input type="checkbox" checked={bulkConsultant} onChange={(e) => setBulkConsultant(e.target.checked)} />
                  </label>
                </div>
              </td>
              {!isManpower && (
                <td style={checkboxColStyle}>
                  <input type="checkbox" checked={bulkRental} onChange={(e) => setBulkRental(e.target.checked)} style={{ width: '14px', height: '14px' }} />
                </td>
              )}
              <td style={{ ...cellStyle, textAlign: 'center' }} colSpan={2}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={applyBulkValues}
                  style={{ fontSize: '0.6875rem', padding: '3px 8px' }}
                >
                  Apply
                </button>
              </td>
            </tr>

            {/* === DATA ROWS === */}
            {rows.map((row, idx) => (
              <ResourceRow
                key={row.id}
                row={row}
                idx={idx}
                type={type}
                options={options}
                companyOptions={companyOptions}
                isSelected={selectedRows.has(idx)}
                onToggleSelect={() => toggleSelection(idx)}
                onUpdate={(field, value) => updateRow(row.id, field, value)}
                onRemove={() => removeRow(row.id)}
                onDuplicate={() => duplicateRow(idx)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <button className="btn btn-ghost btn-sm" onClick={addRow} style={{ marginTop: 'var(--space-xs)' }}>
        <Plus size={14} />
        Add {isManpower ? 'Person' : 'Equipment'}
      </button>
    </div>
  );
}


// ============================================
// ResourceRow — A single editable row
// ============================================

function ResourceRow({
  row,
  idx,
  type,
  options,
  companyOptions,
  isSelected,
  onToggleSelect,
  onUpdate,
  onRemove: _onRemove,
  onDuplicate,
}: {
  row: ManpowerRow | EquipmentRow;
  idx: number;
  type: ResourceType;
  options: string[];
  companyOptions: string[];
  isSelected: boolean;
  onToggleSelect: () => void;
  onUpdate: (field: string, value: string | number | boolean) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const isManpower = type === 'manpower';
  const currentValue = isManpower ? (row as ManpowerRow).trade : (row as EquipmentRow).name;

  const cellStyle: React.CSSProperties = { padding: '3px 4px', verticalAlign: 'middle' };
  const inputStyle: React.CSSProperties = { fontSize: '0.75rem', padding: '5px 6px', width: '100%', boxSizing: 'border-box' };
  const smallInputStyle: React.CSSProperties = { ...inputStyle, textAlign: 'center' };
  const checkboxColStyle: React.CSSProperties = { ...cellStyle, textAlign: 'center', width: '32px' };
  const checkLabelStyle: React.CSSProperties = { fontSize: '8px', color: 'var(--color-text-tertiary)', display: 'block', textAlign: 'center', lineHeight: 1 };

  const rowBg = isSelected ? 'rgba(59,130,246,0.06)' : 'transparent';

  return (
    <tr style={{ background: rowBg }}>
      {/* Select checkbox */}
      <td style={checkboxColStyle}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          style={{ width: '14px', height: '14px' }}
        />
      </td>

      {/* Resource (PMWeb dropdown — portal-based, never clipped by table overflow) */}
      <td data-label="Resource" style={cellStyle}>
        <ResourceDropdown
          value={currentValue}
          onChange={(val) => onUpdate(isManpower ? 'trade' : 'name', val)}
          options={options}
          placeholder={`Select ${isManpower ? 'resource' : 'equipment'}...`}
          id={`activity-${type}-${idx}-${isManpower ? 'trade' : 'name'}`}
        />
      </td>

      {/* Name (manpower) / Equipment Number (equipment) */}
      <td data-label={isManpower ? "Name" : "Equip #"} style={cellStyle}>
        <input
          className="input"
          style={inputStyle}
          value={isManpower ? (row as ManpowerRow).name : (row as EquipmentRow).description}
          onChange={(e) => onUpdate(isManpower ? 'name' : 'description', e.target.value)}
          placeholder={isManpower ? 'Name' : 'Equip #'}
          id={`activity-${type}-${idx}-${isManpower ? 'name' : 'description'}`}
        />
      </td>

      {/* Qty */}
      <td data-label="Qty" style={cellStyle}>
        <input
          className="input"
          type="number"
          min={0}
          style={smallInputStyle}
          value={row.qty || ''}
          onChange={(e) => onUpdate('qty', parseInt(e.target.value, 10) || 0)}
          placeholder="0"
          id={`activity-${type}-${idx}-qty`}
        />
      </td>

      {/* Hours */}
      <td data-label="Hours" style={cellStyle}>
        <input
          className="input"
          type="number"
          min={0}
          step={0.5}
          style={smallInputStyle}
          value={row.hours || ''}
          onChange={(e) => onUpdate('hours', parseFloat(e.target.value) || 0)}
          placeholder="0"
          id={`activity-${type}-${idx}-hours`}
        />
      </td>

      {/* Start Time */}
      <td data-label="Start" style={cellStyle}>
        <input
          className="input"
          style={inputStyle}
          value={(row as ManpowerRow).start_time || ''}
          onChange={(e) => onUpdate('start_time', e.target.value)}
          placeholder="7:00 AM"
          id={`activity-${type}-${idx}-start_time`}
        />
      </td>

      {/* Stop Time */}
      <td data-label="Stop" style={cellStyle}>
        <input
          className="input"
          style={inputStyle}
          value={(row as ManpowerRow).stop_time || ''}
          onChange={(e) => onUpdate('stop_time', e.target.value)}
          placeholder="3:30 PM"
          id={`activity-${type}-${idx}-stop_time`}
        />
      </td>

      {/* Company (combobox — text input + datalist for suggestions) */}
      <td data-label="Company" style={cellStyle}>
        <input
          className="input"
          style={inputStyle}
          value={row.company || ''}
          onChange={(e) => onUpdate('company', e.target.value)}
          placeholder="Company..."
          list={`company-opts-${type}-${idx}`}
          autoComplete="off"
          id={`activity-${type}-${idx}-company`}
        />
        <datalist id={`company-opts-${type}-${idx}`}>
          {companyOptions.map((co, i) => <option key={i} value={co} />)}
        </datalist>
      </td>

      {/* 3rd Party / EW / Consultant checkboxes */}
      <td data-label="Flags" style={{ ...cellStyle, textAlign: 'center' }}>
        <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
            <span style={checkLabelStyle}>3rd</span>
            <input
              type="checkbox"
              checked={!!(row as ManpowerRow).is_3rd_party}
              onChange={(e) => onUpdate('is_3rd_party', e.target.checked)}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
            <span style={checkLabelStyle}>EW</span>
            <input
              type="checkbox"
              checked={!!row.is_extra_work}
              onChange={(e) => onUpdate('is_extra_work', e.target.checked)}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}>
            <span style={checkLabelStyle}>Con</span>
            <input
              type="checkbox"
              checked={!!(row as ManpowerRow).is_consultant}
              onChange={(e) => onUpdate('is_consultant', e.target.checked)}
            />
          </label>
        </div>
      </td>

      {/* Rental (equipment only) */}
      {!isManpower && (
        <td style={checkboxColStyle}>
          <input
            type="checkbox"
            checked={!!(row as EquipmentRow).is_rental}
            onChange={(e) => onUpdate('is_rental', e.target.checked)}
            style={{ width: '14px', height: '14px' }}
          />
        </td>
      )}

      {/* Duplicate */}
      <td style={{ ...cellStyle, textAlign: 'center' }}>
        <button
          className="btn btn-ghost btn-icon"
          onClick={onDuplicate}
          title="Duplicate Row"
          style={{ width: '24px', height: '24px', padding: '2px' }}
        >
          <Copy size={12} style={{ color: 'var(--color-accent)' }} />
        </button>
      </td>

      {/* Lock toggle */}
      <td style={{ ...cellStyle, textAlign: 'center' }}>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => onUpdate('locked', !row.locked)}
          title={row.locked ? 'Locked (protected from bulk apply)' : 'Unlocked'}
          style={{ width: '24px', height: '24px', padding: '2px' }}
        >
          {row.locked
            ? <Lock size={12} style={{ color: 'var(--color-warning)' }} />
            : <Unlock size={12} style={{ color: 'var(--color-text-placeholder)' }} />}
        </button>
      </td>
    </tr>
  );
}
