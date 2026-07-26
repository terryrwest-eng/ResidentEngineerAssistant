/**
 * Daily Reporter V3 — Resource Resolution Dialog
 *
 * Shows unmatched/low-confidence resources after dispatch import.
 * User picks correct PMWeb codes from searchable dropdowns.
 * "Remember" checkbox saves aliases for future auto-matching.
 *
 * Design: Flat 2.0, overlay modal, scrollable list.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { DEFAULT_MANPOWER, DEFAULT_EQUIPMENT } from '@/lib/constants';
import { settingsApi } from '@/lib/settingsApi';
import { saveResourceAliases } from '@/lib/resourceMatcher';
import { Search, Check, X, AlertCircle, ChevronDown } from 'lucide-react';

// ============================================
// Types
// ============================================

export interface UnmatchedResource {
  /** Index in the original manpower/equipment array */
  index: number;
  /** Whether this is equipment or manpower */
  type: 'equipment' | 'manpower';
  /** The raw description from the dispatch/AI */
  rawDescription: string;
  /** Best guess from ResourceMatcher (null if none scored ≥0.7) */
  bestGuess: string | null;
  /** Confidence of bestGuess (0-1) */
  confidence: number;
  /** Top alternatives from ResourceMatcher */
  alternatives: string[];
}

export interface Resolution {
  index: number;
  type: 'equipment' | 'manpower';
  rawDescription: string;
  code: string;
  remember: boolean;
}

interface ResourceResolutionDialogProps {
  items: UnmatchedResource[];
  onResolve: (resolutions: Resolution[]) => void;
  onCancel: () => void;
}

// ============================================
// Component
// ============================================

export function ResourceResolutionDialog({
  items,
  onResolve,
  onCancel,
}: ResourceResolutionDialogProps) {
  // State: selected code for each item, indexed by array position
  const [selections, setSelections] = useState<Map<number, string>>(() => {
    const initial = new Map<number, string>();
    items.forEach((item, i) => {
      if (item.bestGuess) {
        initial.set(i, item.bestGuess);
      }
    });
    return initial;
  });

  // Load custom resource codes from settings
  const [customLabor, setCustomLabor] = useState<string[]>([]);
  const [customEquipment, setCustomEquipment] = useState<string[]>([]);
  useEffect(() => {
    settingsApi.get()
      .then(s => {
        setCustomLabor(s.custom_resource_codes?.labor || []);
        setCustomEquipment(s.custom_resource_codes?.equipment || []);
      })
      .catch(err => console.warn('[ResourceResolution] Failed to load custom codes:', err));
  }, []);

  const extendedManpower = useMemo(() => Array.from(new Set([...DEFAULT_MANPOWER, ...customLabor])), [customLabor]);
  const extendedEquipment = useMemo(() => Array.from(new Set([...DEFAULT_EQUIPMENT, ...customEquipment])), [customEquipment]);

  // State: "Remember this" toggle for each item
  const [rememberFlags, setRememberFlags] = useState<Map<number, boolean>>(() => {
    const initial = new Map<number, boolean>();
    items.forEach((_item, i) => initial.set(i, true)); // default: remember
    return initial;
  });

  // State: which dropdown is open
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  // State: search filter per dropdown
  const [searchFilter, setSearchFilter] = useState('');
  // State: saving in progress
  const [isSaving, setIsSaving] = useState(false);

  const allResolved = useMemo(
    () => items.every((_item, i) => selections.has(i)),
    [items, selections]
  );

  const handleSelect = useCallback((itemIndex: number, code: string) => {
    setSelections(prev => {
      const next = new Map(prev);
      next.set(itemIndex, code);
      return next;
    });
    setOpenDropdown(null);
    setSearchFilter('');
  }, []);

  const handleToggleRemember = useCallback((itemIndex: number) => {
    setRememberFlags(prev => {
      const next = new Map(prev);
      next.set(itemIndex, !prev.get(itemIndex));
      return next;
    });
  }, []);

  const handleApply = useCallback(async () => {
    if (!allResolved) return;
    setIsSaving(true);

    const resolutions: Resolution[] = items.map((item, i) => ({
      index: item.index,
      type: item.type,
      rawDescription: item.rawDescription,
      code: selections.get(i) || '',
      remember: rememberFlags.get(i) || false,
    }));

    // Save aliases for items marked "Remember"
    const newAliases: { equipment: Record<string, string>; manpower: Record<string, string> } = {
      equipment: {},
      manpower: {},
    };

    for (const res of resolutions) {
      if (res.remember && res.rawDescription && res.code) {
        newAliases[res.type][res.rawDescription] = res.code;
      }
    }

    const hasAliases = Object.keys(newAliases.equipment).length > 0 || Object.keys(newAliases.manpower).length > 0;
    if (hasAliases) {
      try {
        await saveResourceAliases(newAliases);
        console.debug('[ResourceResolution] Saved aliases:', newAliases);
      } catch (err) {
        console.error('[ResourceResolution] Failed to save aliases:', err);
      }
    }

    setIsSaving(false);
    onResolve(resolutions);
  }, [allResolved, items, selections, rememberFlags, onResolve]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
        padding: 'var(--space-lg)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: 'var(--color-surface)',
          borderRadius: 'var(--radius-lg)',
          width: '100%',
          maxWidth: '600px',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: 'var(--space-lg)',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <AlertCircle size={20} style={{ color: 'var(--color-warning)' }} />
            <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>
              Resolve Resource Codes
            </h3>
          </div>
          <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
            {items.length} item{items.length !== 1 ? 's' : ''} need{items.length === 1 ? 's' : ''} a PMWeb code assigned
          </p>
        </div>

        {/* Items list */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--space-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-md)',
        }}>
          {items.map((item, idx) => (
            <ResolutionItem
              key={`${item.type}-${item.index}-${idx}`}
              item={item}
              pool={item.type === 'equipment' ? extendedEquipment : extendedManpower}
              selectedCode={selections.get(idx) || ''}
              remember={rememberFlags.get(idx) || false}
              isDropdownOpen={openDropdown === idx}
              searchFilter={openDropdown === idx ? searchFilter : ''}
              onOpenDropdown={() => {
                setOpenDropdown(openDropdown === idx ? null : idx);
                setSearchFilter('');
              }}
              onSelect={(code) => handleSelect(idx, code)}
              onToggleRemember={() => handleToggleRemember(idx)}
              onSearchChange={setSearchFilter}
            />
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: 'var(--space-md) var(--space-lg)',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 'var(--space-md)',
          background: 'var(--color-bg)',
        }}>
          <button className="btn btn-ghost" onClick={onCancel}>
            <X size={16} /> Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!allResolved || isSaving}
            onClick={handleApply}
          >
            <Check size={16} />
            {isSaving ? 'Saving...' : `Apply ${items.length} Code${items.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Single Resolution Item
// ============================================

function ResolutionItem({
  item,
  pool,
  selectedCode,
  remember,
  isDropdownOpen,
  searchFilter,
  onOpenDropdown,
  onSelect,
  onToggleRemember,
  onSearchChange,
}: {
  item: UnmatchedResource;
  pool: string[];
  selectedCode: string;
  remember: boolean;
  isDropdownOpen: boolean;
  searchFilter: string;
  onOpenDropdown: () => void;
  onSelect: (code: string) => void;
  onToggleRemember: () => void;
  onSearchChange: (val: string) => void;
}) {


  const filteredOptions = useMemo(() => {
    if (!searchFilter.trim()) return pool;
    const lower = searchFilter.toLowerCase();
    return pool.filter(r => r.toLowerCase().includes(lower));
  }, [pool, searchFilter]);

  const confidenceColor = item.confidence >= 0.7 ? 'var(--color-warning)' : 'var(--color-danger, #dc2626)';
  const confidenceLabel = item.confidence >= 0.7
    ? `${Math.round(item.confidence * 100)}% match`
    : 'No match found';

  return (
    <div style={{
      border: `1px solid ${selectedCode ? 'var(--color-accent)' : 'var(--color-border)'}`,
      borderRadius: 'var(--radius-md)',
      padding: 'var(--space-md)',
      background: selectedCode ? 'var(--color-accent-light)' : 'var(--color-surface)',
      transition: 'all 0.15s ease',
    }}>
      {/* Raw description + confidence */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>
          &ldquo;{item.rawDescription}&rdquo;
        </span>
        <span style={{
          fontSize: '0.6875rem',
          color: confidenceColor,
          fontWeight: 500,
          background: `${confidenceColor}15`,
          padding: '1px 8px',
          borderRadius: '10px',
        }}>
          {confidenceLabel}
        </span>
      </div>

      {/* Type badge */}
      <span style={{
        fontSize: '0.625rem',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: 'var(--color-text-tertiary)',
        fontWeight: 600,
      }}>
        {item.type === 'equipment' ? '🚜 Equipment' : '👷 Manpower'}
      </span>

      {/* Dropdown selector */}
      <div style={{ marginTop: '8px', position: 'relative' }}>
        <button
          type="button"
          onClick={onOpenDropdown}
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg)',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontFamily: 'var(--font-sans)',
            fontSize: '0.8125rem',
            textAlign: 'left',
            color: selectedCode ? 'var(--color-text)' : 'var(--color-text-tertiary)',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedCode || 'Select a PMWeb code...'}
          </span>
          <ChevronDown size={14} style={{
            transition: 'transform 0.15s',
            transform: isDropdownOpen ? 'rotate(180deg)' : 'rotate(0)',
            flexShrink: 0,
          }} />
        </button>

        {/* Dropdown panel */}
        {isDropdownOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 50,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            marginTop: '4px',
            maxHeight: '240px',
            display: 'flex',
            flexDirection: 'column',
          }}>
            {/* Search input */}
            <div style={{ padding: '8px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{
                  position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--color-text-tertiary)',
                }} />
                <input
                  autoFocus
                  type="text"
                  placeholder="Search codes..."
                  value={searchFilter}
                  onChange={(e) => onSearchChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 8px 6px 28px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.8125rem',
                    fontFamily: 'var(--font-sans)',
                    background: 'var(--color-bg)',
                  }}
                />
              </div>
            </div>

            {/* Options list */}
            <div style={{ overflowY: 'auto', maxHeight: '180px' }}>
              {/* Show alternatives first if available */}
              {item.alternatives.length > 0 && !searchFilter && (
                <div style={{
                  padding: '4px 8px',
                  fontSize: '0.625rem',
                  color: 'var(--color-text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontWeight: 600,
                  background: 'var(--color-bg)',
                }}>
                  Best matches
                </div>
              )}
              {!searchFilter && item.alternatives.map(alt => (
                <button
                  key={alt}
                  type="button"
                  onClick={() => onSelect(alt)}
                  style={{
                    width: '100%',
                    padding: '6px 12px',
                    border: 'none',
                    background: selectedCode === alt ? 'var(--color-accent-light)' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '0.8125rem',
                    fontFamily: 'var(--font-sans)',
                    color: 'var(--color-text)',
                    fontWeight: selectedCode === alt ? 600 : 400,
                  }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--color-accent-light)'; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.background = selectedCode === alt ? 'var(--color-accent-light)' : 'transparent'; }}
                >
                  {alt}
                </button>
              ))}

              {/* Divider */}
              {item.alternatives.length > 0 && !searchFilter && (
                <div style={{ height: '1px', background: 'var(--color-border)', margin: '4px 0' }} />
              )}

              {/* All options */}
              {!searchFilter && (
                <div style={{
                  padding: '4px 8px',
                  fontSize: '0.625rem',
                  color: 'var(--color-text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontWeight: 600,
                  background: 'var(--color-bg)',
                }}>
                  All codes
                </div>
              )}
              {filteredOptions.map(code => (
                <button
                  key={code}
                  type="button"
                  onClick={() => onSelect(code)}
                  style={{
                    width: '100%',
                    padding: '6px 12px',
                    border: 'none',
                    background: selectedCode === code ? 'var(--color-accent-light)' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '0.8125rem',
                    fontFamily: 'var(--font-sans)',
                    color: 'var(--color-text)',
                    fontWeight: selectedCode === code ? 600 : 400,
                  }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--color-accent-light)'; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.background = selectedCode === code ? 'var(--color-accent-light)' : 'transparent'; }}
                >
                  {code}
                </button>
              ))}
              {filteredOptions.length === 0 && (
                <div style={{ padding: '12px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: '0.8125rem' }}>
                  No matching codes
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Remember checkbox */}
      <label style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginTop: '8px',
        fontSize: '0.75rem',
        color: 'var(--color-text-secondary)',
        cursor: 'pointer',
        userSelect: 'none',
      }}>
        <input
          type="checkbox"
          checked={remember}
          onChange={onToggleRemember}
          style={{ accentColor: 'var(--color-accent)' }}
        />
        Remember this mapping
      </label>
    </div>
  );
}
