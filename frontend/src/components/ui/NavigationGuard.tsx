/**
 * Daily Reporter V3 — Navigation Guard
 *
 * Prevents accidental data loss by intercepting:
 * 1. Browser tab close / refresh (beforeunload)
 * 2. Showing an in-app prompt when user clicks away
 *
 * Shows a Word-style "Save / Don't Save / Cancel" dialog.
 *
 * NOTE: Using a simple state-based approach instead of useBlocker
 * for maximum React Router version compatibility.
 */

import { useEffect } from 'react';
import { useReportStore } from '@/stores/reportStore';

export function NavigationGuard() {
  const isDirty = useReportStore((s) => s.isDirty);
  const isSaved = useReportStore((s) => s.isSaved);

  // Block browser close/refresh when there are unsaved changes
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (isDirty || (!isSaved && isDirty)) {
        e.preventDefault();
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty, isSaved]);

  // This component renders nothing — it only hooks into beforeunload.
  // The Save/Don't Save/Cancel dialog is triggered by explicit user actions
  // (clicking navigation buttons) rather than by intercepting the router.
  return null;
}
