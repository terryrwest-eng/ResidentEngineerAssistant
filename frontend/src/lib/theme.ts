/**
 * Daily Reporter V3 — Theme
 *
 * Light / Dark / Auto. Defaults to Light — the app never forces a theme.
 * "Auto" follows the operating system, and keeps following it: if the OS flips
 * while the app is open, the page flips with it.
 *
 * The choice is resolved to a concrete "light" or "dark" and written to
 * data-theme on <html>. That keeps the CSS to a single [data-theme="dark"]
 * block instead of duplicating every rule under a media query.
 *
 * Stored in localStorage rather than server settings on purpose: it must apply
 * before the first paint, and waiting on a network round-trip would mean a
 * white flash on every load — which is precisely what someone turning dark mode
 * on at 8:30 PM is trying to avoid.
 */

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'daily-reporter-theme';

const listeners = new Set<(mode: ThemeMode, resolved: ResolvedTheme) => void>();

function prefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function getThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  } catch {
    // Private browsing / storage disabled — fall through to the default.
  }
  return 'light';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'auto') return prefersDark() ? 'dark' : 'light';
  return mode;
}

function paint(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.removeAttribute('data-theme');
  }
  return resolved;
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Not fatal — the theme still applies for this session.
  }
  const resolved = paint(mode);
  listeners.forEach((fn) => fn(mode, resolved));
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function onThemeChange(
  fn: (mode: ThemeMode, resolved: ResolvedTheme) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Apply the stored theme. Call once from main.tsx before React renders, so the
 * first paint is already the right colour.
 */
export function initTheme(): void {
  paint(getThemeMode());

  // Keep "auto" honest — follow the OS if it changes while we are open.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (getThemeMode() === 'auto') {
        const resolved = paint('auto');
        listeners.forEach((fn) => fn('auto', resolved));
      }
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
    } else if (typeof (query as MediaQueryList).addListener === 'function') {
      // Safari < 14
      (query as MediaQueryList).addListener(handler);
    }
  }
}
