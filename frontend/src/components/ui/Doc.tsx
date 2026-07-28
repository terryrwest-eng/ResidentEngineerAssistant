/**
 * Daily Reporter V3 — Document primitives
 *
 * The component layer the app never had. See UI_REDESIGN_BRIEF.md §2: there are
 * ~1,078 inline style objects across 31 components and almost no shared
 * components, which is why nothing looks consistent and why a visual direction
 * could not be applied centrally.
 *
 * These own their styling. A call site says what a thing IS, not what it looks
 * like — so the look changes in index.css, once, for the whole app.
 */

import type { ReactNode } from 'react';

/** Page container — holds the measure so text never runs to the window edge. */
export function Doc({ children }: { children: ReactNode }) {
  return <div className="doc">{children}</div>;
}

/**
 * Document header. Carries what identifies the report — project, number, date —
 * plus status and actions. The old header spent this space on the words
 * "Edit Report".
 */
export function DocHeader({
  title,
  meta,
  status,
  actions,
  figures,
}: {
  title: ReactNode;
  meta?: ReactNode[];
  status?: ReactNode;
  actions?: ReactNode;
  /** The numbers that define the day. Set large, tabular, on the ink block. */
  figures?: { value: ReactNode; label: string; accent?: boolean }[];
}) {
  const parts = (meta ?? []).filter(Boolean);
  const stats = (figures ?? []).filter(Boolean);
  return (
    <div className="doc-masthead">
      <header className="doc-header">
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 className="doc-title">{title}</h1>
          {(parts.length > 0 || status) && (
            <div className="doc-meta">
              {parts.map((part, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  {i > 0 && <span className="doc-meta-sep" aria-hidden />}
                  <span>{part}</span>
                </span>
              ))}
              {status}
            </div>
          )}
        </div>
        {actions && (
          <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
            {actions}
          </div>
        )}
      </header>

      {stats.length > 0 && (
        <div className="doc-figures">
          {stats.map((stat, i) => (
            <div className="doc-figure" key={i}>
              <span className={`doc-figure-value${stat.accent ? ' is-accent' : ''}`}>
                {stat.value}
              </span>
              <span className="doc-figure-label">{stat.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type StatusTone = 'ok' | 'warn' | 'err' | 'muted';

export function DocStatus({ tone = 'muted', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`doc-status doc-status-${tone}`}>{children}</span>;
}

/**
 * A section of the document: a small uppercase label, a hairline running out to
 * the edge, then the content. No card, no border, no shadow — the thing that
 * made every block on the old page carry identical weight.
 */
export function DocSection({
  label,
  aside,
  children,
  id,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="doc-section" id={id}>
      <div className="doc-section-head">
        <span className="doc-section-label">{label}</span>
        <span className="doc-section-rule" aria-hidden />
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Auto-fitting field grid. Columns come from available width, not a guess. */
export function DocGrid({ children, min }: { children: ReactNode; min?: number }) {
  return (
    <div
      className="doc-grid"
      style={min ? { gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` } : undefined}
    >
      {children}
    </div>
  );
}

/** A labelled field. The uppercase micro-label is the signature of the look. */
export function DocField({
  label,
  children,
  span,
  hint,
}: {
  label: string;
  children: ReactNode;
  /** Let a field take more than one column (notes, long text). */
  span?: number;
  hint?: ReactNode;
}) {
  return (
    <div className="doc-field" style={span ? { gridColumn: `span ${span}` } : undefined}>
      <label className="doc-field-label">{label}</label>
      {children}
      {hint && (
        <span style={{ fontSize: 'var(--text-micro)', color: 'var(--color-text-tertiary)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** A count with its unit, set in mono so figures line up down a list. */
export function DocTally({ value, label }: { value: ReactNode; label: string }) {
  return (
    <span className="doc-tally">
      <b>{value}</b> {label}
    </span>
  );
}
