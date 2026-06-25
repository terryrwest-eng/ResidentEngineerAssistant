/**
 * useIMEInput — Composition-aware input hook for Android WebView
 *
 * PROBLEM:
 * React controlled inputs (value + onChange) break swipe/glide typing on
 * Android WebView. When the user swipes, Gboard enters "composition mode"
 * and sends compositionstart → compositionupdate → compositionend events.
 * React's onChange fires during each compositionupdate and overwrites the
 * input value, which kills the IME's internal state mid-swipe.
 *
 * FIX:
 * During composition, we let the input operate uncontrolled — the DOM value
 * is NOT overwritten from the store. When compositionend fires, we sync the
 * final composed value to the store.
 *
 * USAGE:
 *   const { inputProps } = useIMEInput(currentValue, (newVal) => updateStore(newVal));
 *   <input {...inputProps} className="input" placeholder="..." />
 */

import { useRef, useCallback, useEffect } from 'react';

interface UseIMEInputOptions {
  /** Current value from the store (source of truth) */
  value: string;
  /** Callback to update the store with the new value */
  onChange: (value: string) => void;
}

interface IMEInputProps {
  value?: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  ref: React.RefCallback<HTMLInputElement | HTMLTextAreaElement>;
  /** Explicit type to help Android WebView keyboard detection */
  autoComplete: string;
  autoCorrect: string;
  autoCapitalize: string;
}

export function useIMEInput({ value, onChange }: UseIMEInputOptions): { inputProps: IMEInputProps } {
  const isComposingRef = useRef(false);
  const elementRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Sync the store value to the DOM when NOT composing
  useEffect(() => {
    if (!isComposingRef.current && elementRef.current) {
      // Only update if the DOM value differs from store to avoid cursor jump
      if (elementRef.current.value !== value) {
        elementRef.current.value = value;
      }
    }
  }, [value]);

  const handleRef = useCallback((el: HTMLInputElement | HTMLTextAreaElement | null) => {
    elementRef.current = el;
    if (el && el.value !== value) {
      el.value = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty — we set initial value once on mount

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (isComposingRef.current) {
      // During composition (swipe in progress), do NOT push to store.
      // The IME is building the word — let it work uninterrupted.
      console.debug('[useIMEInput] Composing — skipping store update');
      return;
    }
    // Normal typing (tap-by-tap) — update store immediately
    onChange(e.target.value);
  }, [onChange]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    console.debug('[useIMEInput] Composition started (swipe in progress)');
  }, []);

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    // Composition finished — sync the final composed word to the store
    const finalValue = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    console.debug('[useIMEInput] Composition ended, syncing:', finalValue);
    onChange(finalValue);
  }, [onChange]);

  return {
    inputProps: {
      // Do NOT pass `value` — we manage the DOM value via ref to avoid
      // overwriting during composition. This makes the input "uncontrolled"
      // from React's perspective during swipe, but we keep it in sync
      // via the useEffect above when NOT composing.
      onChange: handleChange,
      onCompositionStart: handleCompositionStart,
      onCompositionEnd: handleCompositionEnd,
      ref: handleRef,
      // Explicit IME hints for Android WebView
      autoComplete: 'off',
      autoCorrect: 'on',
      autoCapitalize: 'sentences',
    },
  };
}

/**
 * Lightweight version for components with many inputs.
 * Returns handlers that can be spread onto any input, using the field name
 * to route changes to the correct store update.
 *
 * USAGE:
 *   const imeHandlers = useIMEFieldHandlers(updateGeneral);
 *   <input {...imeHandlers.getProps('project_name', gen.project_name)} className="input" />
 */
export function useIMEFieldHandlers(
  updateFn: (update: Record<string, string>) => void,
): {
  getProps: (field: string, currentValue: string) => {
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    defaultValue: string;
    autoComplete: string;
    autoCorrect: string;
    autoCapitalize: string;
  };
} {
  const composingFieldRef = useRef<string | null>(null);

  const handleChange = useCallback((field: string, e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (composingFieldRef.current === field) {
      // Swipe in progress on this field — don't push to store
      return;
    }
    updateFn({ [field]: e.target.value });
  }, [updateFn]);

  const handleCompositionStart = useCallback((field: string) => {
    composingFieldRef.current = field;
    console.debug(`[useIMEFieldHandlers] Composition started on "${field}"`);
  }, []);

  const handleCompositionEnd = useCallback((field: string, e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    composingFieldRef.current = null;
    const finalValue = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    console.debug(`[useIMEFieldHandlers] Composition ended on "${field}":`, finalValue);
    updateFn({ [field]: finalValue });
  }, [updateFn]);

  const getProps = useCallback((field: string, currentValue: string) => ({
    defaultValue: currentValue,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => handleChange(field, e),
    onCompositionStart: () => handleCompositionStart(field),
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => handleCompositionEnd(field, e),
    autoComplete: 'off' as const,
    autoCorrect: 'on' as const,
    autoCapitalize: 'sentences' as const,
  }), [handleChange, handleCompositionStart, handleCompositionEnd]);

  return { getProps };
}
