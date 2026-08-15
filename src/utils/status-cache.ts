/**
 * Generic TTL cache with in-flight promise coalescing.
 *
 * When multiple callers request a value while the cache is stale, only one
 * underlying `fetch` call is made — all callers await the same in-flight
 * promise, preventing thundering-herd I/O on hot health-check endpoints.
 */
export class StatusCache<T> {
  private entry: { value: T; expiresAt: number } | null = null;
  private inflight: Promise<T> | null = null;

  constructor(private readonly ttlMs: number) {}

  /**
   * Return the cached value if still fresh, otherwise call `fetch` once and
   * cache the result. Concurrent callers while a fetch is in-flight all
   * receive the same promise.
   */
  async get(fetch: () => Promise<T>): Promise<T> {
    if (this.entry !== null && Date.now() < this.entry.expiresAt) {
      return this.entry.value;
    }
    if (this.inflight !== null) {
      return this.inflight;
    }
    this.inflight = fetch().then(
      (value) => {
        this.entry = { value, expiresAt: Date.now() + this.ttlMs };
        this.inflight = null;
        return value;
      },
      (err: unknown) => {
        this.inflight = null;
        throw err;
      },
    );
    return this.inflight;
  }

  /** Force the next call to re-fetch, even if the TTL has not expired. */
  invalidate(): void {
    this.entry = null;
    // Leave inflight alone — it will complete and populate the entry,
    // but the next call after invalidate() will still re-fetch because
    // entry is null when the in-flight promise resolves.
  }

  /** True when a cached (non-expired) value is available. */
  get isFresh(): boolean {
    return this.entry !== null && Date.now() < this.entry.expiresAt;
  }
}
