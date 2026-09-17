/**
 * Daily Reporter — does a media query match right now?
 *
 * useSyncExternalStore rather than useState + useEffect: the viewport is state
 * that lives outside React, and this is the hook React provides for reading
 * exactly that, without an effect copying it into component state a frame late.
 */

import { useCallback, useSyncExternalStore } from 'react';

/** The phone layout. Matches the 640px breakpoint the stylesheet uses. */
export const PHONE_QUERY = '(max-width: 640px)';

function canQuery(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (!canQuery()) return () => undefined;
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  const read = useCallback(() => canQuery() && window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, read, () => false);
}
