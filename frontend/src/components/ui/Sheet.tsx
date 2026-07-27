/**
 * Daily Reporter V3 — Sheet
 *
 * The one overlay pattern: bottom sheet on a phone, centred card on a desktop.
 * Eleven overlays had drifted into eleven different looks, paddings and close
 * behaviours; this is the shape they collapse to.
 *
 * DELIBERATELY NO CLICK-OUTSIDE-TO-CLOSE. That rule predates this component
 * (see .dialog-overlay in index.css) and it is a good one — these overlays hold
 * half-entered field data, and a stray tap on a phone must never discard it.
 * Closing is always an explicit action.
 *
 * Escape is opt-in for the same reason: fine for a read-only preview, wrong for
 * a form.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Leading icon, rendered in the accent chip beside the title. */
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** Footer actions. Omit for a sheet with no actions of its own. */
  footer?: React.ReactNode;
  /** Escape closes the sheet. Leave off for anything holding unsaved input. */
  closeOnEscape?: boolean;
  /** Hide the header close button (when the footer already owns closing). */
  hideCloseButton?: boolean;
  /** Widen past the 640px default — for tables and side-by-side content. */
  maxWidth?: number | string;
}

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  closeOnEscape = false,
  hideCloseButton = false,
  maxWidth,
}: SheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Stop the page behind from scrolling while a sheet is up — on iOS the
  // background scrolling "through" a modal is the classic broken-feeling bug.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // Move focus in on open, and hand it back to wherever it came from on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    const timer = window.setTimeout(() => {
      const target = sheetRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      );
      target?.focus();
    }, 30);
    return () => {
      window.clearTimeout(timer);
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="sheet-overlay" role="presentation">
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        style={maxWidth ? { maxWidth } : undefined}
      >
        <div className="sheet-header">
          {icon && (
            <div style={{
              width: 34, height: 34, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--color-accent-light)',
              color: 'var(--color-accent)',
              borderRadius: 'var(--radius-md)',
            }}>
              {icon}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="sheet-title">{title}</h2>
            {subtitle && <p className="sheet-subtitle">{subtitle}</p>}
          </div>
          {!hideCloseButton && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              aria-label="Close"
              style={{ flexShrink: 0 }}
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="sheet-body">{children}</div>

        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
