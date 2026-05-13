/**
 * Daily Reporter V3 — Resource Table (Manpower / Equipment)
 *
 * Inline-editable table for adding/editing manpower or equipment rows.
 * Features:
 * - Filterable dropdown for PMWeb trade/equipment codes
 * - Inline editing (no modals)
 * - Add/remove rows
 * - Tab key moves between cells for fast data entry
 */

import { useState, useRef, useCallback } from 'react';
import type { ManpowerRow, EquipmentRow } from '@/types';
import { DEFAULT_MANPOWER, DEFAULT_EQUIPMENT, DEFAULT_COMPANY } from '@/lib/constants';
import { Plus, Trash2, Search } from 'lucide-react';

type ResourceType = 'manpower' | 'equipment';

interface ResourceTableProps {
  type: ResourceType;
  rows: any[];
  onChange: (rows: any[]) => void;
  isExtraWork?: boolean;
  isConsultant?: boolean;
}

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ResourceTable({
  type,
  rows,
  onChange,
  isExtraWork = false,
  isConsultant = false,
}: ResourceTableProps) {
  const isManpower = type === 'manpower';
  const options = isManpower ? DEFAULT_MANPOWER : DEFAULT_EQUIPMENT;

  function addRow() {
    const newRow = isManpower
      ? {
          id: generateId(),
          trade: '',
          name: '',
          qty: 1,
          hours: 8,
          company: DEFAULT_COMPANY,
          classification: '',
          is_extra_work: isExtraWork,
          is_consultant: isConsultant,
        } as ManpowerRow
      : {
          id: generateId(),
          name: '',
          description: '',
          qty: 1,
          hours: 8,
          company: DEFAULT_COMPANY,
          is_extra_work: isExtraWork,
        } as EquipmentRow;

    onChange([...rows, newRow]);
  }

  function removeRow(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }

  function updateRow(id: string, field: string, value: string | number | boolean) {
    onChange(
      rows.map((r) =>
        r.id === id ? { ...r, [field]: value } : r
      )
    );
  }

  return (
    <div style={{ marginBottom: 'var(--space-sm)' }}>
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: isManpower ? '650px' : '550px' }}>
            <thead>
              <tr>
                <th style={{ width: '35%' }}>{isManpower ? 'Trade' : 'Equipment'}</th>
                {isManpower && <th style={{ width: '15%' }}>Name</th>}
                <th style={{ width: '8%', textAlign: 'center' }}>Qty</th>
                <th style={{ width: '10%', textAlign: 'center' }}>Hours</th>
                <th style={{ width: '20%' }}>Company</th>
                <th style={{ width: '5%' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ResourceRow
                  key={row.id}
                  row={row}
                  type={type}
                  options={options}
                  onUpdate={(field, value) => updateRow(row.id, field, value)}
                  onRemove={() => removeRow(row.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        className="btn btn-ghost btn-sm"
        onClick={addRow}
        style={{ marginTop: 'var(--space-xs)' }}
      >
        <Plus size={14} />
        Add {isManpower ? 'Person' : 'Equipment'}
      </button>
    </div>
  );
}


/** A single editable row in the resource table */
function ResourceRow({
  row,
  type,
  options,
  onUpdate,
  onRemove,
}: {
  row: ManpowerRow | EquipmentRow;
  type: ResourceType;
  options: string[];
  onUpdate: (field: string, value: string | number) => void;
  onRemove: () => void;
}) {
  const isManpower = type === 'manpower';
  const [showDropdown, setShowDropdown] = useState(false);
  const [filterText, setFilterText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const currentValue = isManpower
    ? (row as ManpowerRow).trade
    : (row as EquipmentRow).name;

  const filteredOptions = filterText
    ? options.filter((opt) =>
        opt.toLowerCase().includes(filterText.toLowerCase())
      )
    : options;

  const handleResourceFocus = useCallback(() => {
    setShowDropdown(true);
    setFilterText('');
  }, []);

  const handleResourceBlur = useCallback(() => {
    // Delay to allow click on dropdown items
    setTimeout(() => setShowDropdown(false), 200);
  }, []);

  const handleSelectOption = useCallback(
    (value: string) => {
      onUpdate(isManpower ? 'trade' : 'name', value);
      setShowDropdown(false);
      setFilterText('');
    },
    [isManpower, onUpdate]
  );

  const handleResourceInput = useCallback(
    (value: string) => {
      setFilterText(value);
      onUpdate(isManpower ? 'trade' : 'name', value);
      if (!showDropdown) setShowDropdown(true);
    },
    [isManpower, onUpdate, showDropdown]
  );

  return (
    <tr>
      {/* Trade / Equipment Name — with dropdown */}
      <td style={{ position: 'relative', padding: '4px 8px' }}>
        <div style={{ position: 'relative' }}>
          <input
            ref={inputRef}
            className="input"
            style={{ fontSize: '0.8125rem', padding: '6px 10px', paddingRight: '28px' }}
            value={currentValue}
            onChange={(e) => handleResourceInput(e.target.value)}
            onFocus={handleResourceFocus}
            onBlur={handleResourceBlur}
            placeholder={`Select ${isManpower ? 'trade' : 'equipment'}...`}
          />
          <Search
            size={14}
            style={{
              position: 'absolute',
              right: '8px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-placeholder)',
              pointerEvents: 'none',
            }}
          />
          {showDropdown && filteredOptions.length > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                zIndex: 20,
                maxHeight: '200px',
                overflowY: 'auto',
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-lg)',
                marginTop: '2px',
              }}
            >
              {filteredOptions.slice(0, 30).map((opt) => (
                <div
                  key={opt}
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur
                    handleSelectOption(opt);
                  }}
                  style={{
                    padding: '6px 10px',
                    fontSize: '0.8125rem',
                    cursor: 'pointer',
                    background: opt === currentValue ? 'var(--color-accent-light)' : 'transparent',
                    color: opt === currentValue ? 'var(--color-accent)' : 'var(--color-text-primary)',
                    transition: 'background 0.08s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-surface-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background =
                      opt === currentValue ? 'var(--color-accent-light)' : 'transparent';
                  }}
                >
                  {opt}
                </div>
              ))}
            </div>
          )}
        </div>
      </td>

      {/* Name (manpower only) */}
      {isManpower && (
        <td style={{ padding: '4px 8px' }}>
          <input
            className="input"
            style={{ fontSize: '0.8125rem', padding: '6px 10px' }}
            value={(row as ManpowerRow).name}
            onChange={(e) => onUpdate('name', e.target.value)}
            placeholder="Name"
          />
        </td>
      )}

      {/* Qty */}
      <td style={{ padding: '4px 8px' }}>
        <input
          className="input"
          type="number"
          min={0}
          style={{ fontSize: '0.8125rem', padding: '6px 10px', textAlign: 'center' }}
          value={row.qty}
          onChange={(e) => onUpdate('qty', parseInt(e.target.value, 10) || 0)}
        />
      </td>

      {/* Hours */}
      <td style={{ padding: '4px 8px' }}>
        <input
          className="input"
          type="number"
          min={0}
          step={0.5}
          style={{ fontSize: '0.8125rem', padding: '6px 10px', textAlign: 'center' }}
          value={row.hours}
          onChange={(e) => onUpdate('hours', parseFloat(e.target.value) || 0)}
        />
      </td>

      {/* Company */}
      <td style={{ padding: '4px 8px' }}>
        <input
          className="input"
          style={{ fontSize: '0.8125rem', padding: '6px 10px' }}
          value={row.company}
          onChange={(e) => onUpdate('company', e.target.value)}
          placeholder="Company"
        />
      </td>

      {/* Delete */}
      <td style={{ padding: '4px 8px', textAlign: 'center' }}>
        <button
          className="btn btn-ghost btn-icon"
          onClick={onRemove}
          title="Remove row"
          style={{ width: '28px', height: '28px', padding: '4px' }}
        >
          <Trash2 size={14} style={{ color: 'var(--color-danger)' }} />
        </button>
      </td>
    </tr>
  );
}
