/**
 * Loads the pool status of one provider and refreshes it every 60 seconds while the page is
 * visible. A hidden tab stops polling and refreshes once when it becomes visible again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  subscriptionPoolApi,
  type PoolProvider,
  type SubscriptionPoolProviderStatus,
} from '@/lib/api/subscription-pool';

export const POOL_REFRESH_MS = 60_000;

export interface PoolStatusState {
  provider: SubscriptionPoolProviderStatus | null;
  thresholdPct: number;
  loading: boolean;
  error: unknown;
  /** Reload now. Resolves when the new data is in place. */
  refresh: () => Promise<void>;
}

const DEFAULT_THRESHOLD = 95;

export function usePoolStatus(provider: PoolProvider): PoolStatusState {
  const [data, setData] = useState<SubscriptionPoolProviderStatus | null>(null);
  const [thresholdPct, setThresholdPct] = useState(DEFAULT_THRESHOLD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Only the newest request may write state, so a slow older response cannot overwrite fresh data.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const status = await subscriptionPoolApi.status(provider);
      if (seq !== requestSeq.current) return;
      setData(status.providers.find((p) => p.provider === provider) ?? null);
      setThresholdPct(status.threshold_pct);
      setError(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    setData(null);
    setLoading(true);
    void refresh();

    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => void refresh(), POOL_REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      requestSeq.current++;
    };
  }, [refresh]);

  return { provider: data, thresholdPct, loading, error, refresh };
}
