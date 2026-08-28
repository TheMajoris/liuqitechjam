import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";

export interface PolledResource<T> {
  data: T | null;
  error: string | null;
  /** True only before the first successful load for the current key. */
  loading: boolean;
  /** True while a background refresh (poll or manual) is in flight. */
  refreshing: boolean;
  status: number | null;
  refetch: () => void;
}

interface Options {
  /** When set and > 0, re-fetch on this interval (ms) after each settle. */
  intervalMs?: number;
  /** When false, the resource is idle: no fetch, data cleared. */
  enabled?: boolean;
}

/**
 * The single server-state abstraction for the app. One fetch loop per usage,
 * with cleanup. `key` identifies the request; changing it resets loading state
 * and restarts the loop. `fetcher` is read through a ref so callers may pass an
 * inline closure without churning the effect.
 */
export function usePolledResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  { intervalMs, enabled = true }: Options = {},
): PolledResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setStatus(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setLoading(true);

    const run = async () => {
      if (cancelled) return;
      setRefreshing(true);
      try {
        const next = await fetcherRef.current();
        if (cancelled) return;
        setData(next);
        setError(null);
        setStatus(200);
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus(reason instanceof ApiError ? reason.status : null);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
          if (intervalMs && intervalMs > 0) {
            timer = setTimeout(run, intervalMs);
          }
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, enabled, tick]);

  return { data, error, loading, refreshing, status, refetch };
}
