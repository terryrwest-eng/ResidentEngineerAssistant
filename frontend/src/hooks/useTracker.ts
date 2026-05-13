/**
 * useTracker — generic hook for all tracker CRUD operations.
 * Load on mount, optimistic local updates, server sync on every write.
 */

import { useState, useEffect, useCallback } from 'react';

type Row = Record<string, unknown> & { id: string };

type TrackerHookApi = {
  list: () => Promise<Row[]>;
  create: (row: Record<string, unknown>) => Promise<Row>;
  update: (id: string, row: Record<string, unknown>) => Promise<Row>;
  remove: (id: string) => Promise<unknown>;
};

export function useTracker(api: TrackerHookApi) {
  const [rows, setRows] = useState<Row[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.list();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load';
      setError(msg);
      console.error('[useTracker] load error:', e);
    } finally {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async (row: Record<string, unknown>) => {
    const created = await api.create(row);
    setRows((prev) => [created, ...prev]);
    return created;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback(async (id: string, row: Record<string, unknown>) => {
    const updated = await api.update(id, row);
    setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
    return updated;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = useCallback(async (id: string) => {
    await api.remove(id);
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { rows, isLoading, error, create, update, remove, reload: load };
}
