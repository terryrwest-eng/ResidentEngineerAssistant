/**
 * Daily Reporter V3 — Report section nav
 *
 * A sticky row of chips that jumps to each section of the report.
 *
 * WHY: the report page is one long scroll — details, schedule, then every
 * activity with five collapsed resource tables each. Getting from the crew you
 * are entering back up to the date field meant a lot of thumb. This pins the
 * jumps to the top of the page.
 *
 * The active chip is driven by IntersectionObserver rather than scroll maths so
 * it stays correct when sections expand and collapse underneath it.
 */

import { useEffect, useState } from 'react';

export interface NavSection {
  id: string;
  label: string;
}

export function SectionNav({ sections }: { sections: NavSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');

  useEffect(() => {
    const elements = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost section currently intersecting wins.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // Bias the band toward the upper part of the viewport, so the chip
      // matches what you are actually looking at rather than what is scrolling
      // off the bottom.
      { rootMargin: '-80px 0px -55% 0px', threshold: 0 },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  function jump(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        display: 'flex',
        gap: 'var(--space-xs)',
        overflowX: 'auto',
        padding: 'var(--space-sm) 0',
        marginBottom: 'var(--space-md)',
        background: 'var(--color-bg)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      {sections.map((section) => {
        const isActive = active === section.id;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => jump(section.id)}
            style={{
              flexShrink: 0,
              minHeight: 34,
              padding: '0 14px',
              border: `1px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-full)',
              background: isActive ? 'var(--color-accent-light)' : 'var(--color-surface)',
              color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              fontFamily: 'var(--font-sans)',
              fontSize: '0.8125rem',
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
            }}
          >
            {section.label}
          </button>
        );
      })}
    </div>
  );
}
