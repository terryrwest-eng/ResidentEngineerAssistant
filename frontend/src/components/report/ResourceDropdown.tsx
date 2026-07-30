/**
 * Daily Reporter V3 — ResourceDropdown (PMWeb LL/LE code selector)
 *
 * Portal-based filterable dropdown for PMWeb resources.
 * Ported from V1 ResourceDropdown.jsx — same UX:
 * - Button trigger showing selected value
 * - Portal menu positioned via getBoundingClientRect (never clipped by overflow)
 * - Type-to-filter search input
 * - Custom value entry option
 * - Clear (X) button
 * - Repositions on scroll/resize
 *
 * WHY portal: The dropdown lives inside table cells with overflowX: auto.
 * Without portaling, the menu gets clipped and users can't see it.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';

interface ResourceDropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  id?: string;
}

export function ResourceDropdown({
  value,
  onChange,
  options,
  placeholder = 'Select resource...',
  id,
}: ResourceDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // --- Close on click outside ---
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedTrigger = containerRef.current?.contains(target);
      const clickedMenu = menuRef.current?.contains(target);
      if (!clickedTrigger && !clickedMenu) {
        setIsOpen(false);
        setFilter('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // --- Position menu relative to trigger ---
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const DROPDOWN_MAX_HEIGHT = 280;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < DROPDOWN_MAX_HEIGHT + 20 && rect.top > DROPDOWN_MAX_HEIGHT;

    const style: React.CSSProperties = {
      position: 'fixed',
      width: Math.max(rect.width, 240),
      left: rect.left,
      zIndex: 99999,
    };

    if (openUpward) {
      (style as Record<string, unknown>).bottom = window.innerHeight - rect.top + 4;
    } else {
      style.top = rect.bottom + 4;
    }

    setMenuStyle(style);
  }, []);

  // --- Reposition on scroll/resize ---
  useEffect(() => {
    if (!isOpen) return;

    updatePosition();
    // Focus the search input after menu renders
    requestAnimationFrame(() => inputRef.current?.focus());

    const reposition = () => updatePosition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen, updatePosition]);

  // --- Filter ---
  const filtered = filter
    ? options.filter((opt) => {
        const search = filter.toLowerCase();
        const optLower = opt.toLowerCase();
        if (optLower.includes(search)) return true;
        // Match on code (e.g., "LE-109")
        const codeMatch = opt.match(/^([A-Z]+-\d+)/);
        if (codeMatch && codeMatch[1].toLowerCase().includes(search)) return true;
        // Match on description after code
        const descMatch = opt.match(/- (.+)$/);
        if (descMatch && descMatch[1].toLowerCase().includes(search)) return true;
        return false;
      })
    : options;

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setFilter('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setFilter('');
  };

  const hasValue = !!value;
  const displayValue = value || placeholder;

  // Extract code and description for styled display
  const extractParts = (resource: string) => {
    const match = resource.match(/^([A-Z]+-\d+)- (.+)$/);
    return match ? { code: match[1], desc: match[2] } : { code: '', desc: resource };
  };

  // --- Portal menu ---
  const menu = isOpen
    ? ReactDOM.createPortal(
        <div
          ref={menuRef}
          style={{
            ...menuStyle,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md, 8px)',
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.18)',
            maxHeight: '280px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Search */}
          <div
            style={{
              padding: '6px',
              borderBottom: '1px solid var(--color-border)',
              flexShrink: 0,
            }}
          >
            <div style={{ position: 'relative' }}>
              <Search
                size={13}
                style={{
                  position: 'absolute',
                  left: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--color-text-placeholder)',
                  pointerEvents: 'none',
                }}
              />
              <input
                ref={inputRef}
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type to filter..."
                className="input"
                style={{
                  fontSize: '0.75rem',
                  padding: '6px 8px 6px 28px',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setIsOpen(false);
                    setFilter('');
                  }
                  if (e.key === 'Enter' && filtered.length > 0) {
                    handleSelect(filtered[0]);
                  }
                }}
              />
            </div>
          </div>

          {/* Options */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {/* Custom value option */}
            {filter && filter.trim() && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(filter.trim());
                }}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  fontSize: '0.75rem',
                  textAlign: 'left',
                  border: 'none',
                  borderBottom: '1px solid var(--color-border)',
                  background: 'var(--color-accent-light)',
                  color: 'var(--color-success)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <span
                  style={{
                    fontSize: '0.6875rem',
                    fontWeight: 700,
                    padding: '1px 5px',
                    borderRadius: '3px',
                    background: 'rgba(34,197,94,0.15)',
                    color: 'var(--color-success)',
                  }}
                >
                  +
                </span>
                Use &quot;{filter.trim()}&quot; as custom value
              </button>
            )}

            {filtered.length === 0 && !filter ? (
              <div
                style={{
                  padding: '12px',
                  textAlign: 'center',
                  fontSize: '0.75rem',
                  color: 'var(--color-text-tertiary)',
                }}
              >
                No resources found
              </div>
            ) : (
              filtered.slice(0, 40).map((opt) => {
                const isSelected = opt === value;
                const { code, desc } = extractParts(opt);

                return (
                  <button
                    key={opt}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(opt);
                    }}
                    style={{
                      width: '100%',
                      padding: '5px 10px',
                      fontSize: '0.75rem',
                      textAlign: 'left',
                      border: 'none',
                      background: isSelected ? 'var(--color-accent-light)' : 'transparent',
                      color: isSelected ? 'var(--color-accent)' : 'var(--color-text-primary)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontFamily: 'var(--font-sans)',
                      transition: 'background 0.08s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--color-surface-hover, rgba(0,0,0,0.04))';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = isSelected ? 'var(--color-accent-light)' : 'transparent';
                    }}
                  >
                    {code && (
                      <span
                        style={{
                          fontSize: '0.625rem',
                          fontWeight: 600,
                          padding: '1px 4px',
                          borderRadius: '3px',
                          background: 'var(--color-accent-light)',
                          color: 'var(--color-accent)',
                          fontFamily: 'var(--font-mono, monospace)',
                          flexShrink: 0,
                        }}
                      >
                        {code}
                      </span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {desc}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          textAlign: 'left',
          padding: '5px 6px',
          fontSize: '0.75rem',
          fontFamily: 'var(--font-sans)',
          background: 'var(--color-bg)',
          color: hasValue ? 'var(--color-text-primary)' : 'var(--color-text-placeholder)',
          border: `1px solid ${isOpen ? 'var(--color-accent)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-sm, 6px)',
          cursor: 'pointer',
          outline: 'none',
          transition: 'border-color 0.12s ease',
          minHeight: '30px',
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {displayValue}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px', flexShrink: 0 }}>
          {hasValue && (
            <X
              size={13}
              style={{ color: 'var(--color-text-tertiary)', cursor: 'pointer' }}
              onClick={handleClear}
            />
          )}
          <ChevronDown
            size={13}
            style={{
              color: 'var(--color-text-tertiary)',
              transition: 'transform 0.12s',
              transform: isOpen ? 'rotate(180deg)' : 'none',
            }}
          />
        </div>
      </button>

      {menu}
    </div>
  );
}
