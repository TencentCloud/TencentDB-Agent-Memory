export type PoolTimerKind = "refresh" | "reset-check" | "retry-usage" | "retry-refresh" | "usage-sweep";

export interface PoolTimerEntry {
  key: string;
  instanceId: string;
  accountId: string;
  kind: PoolTimerKind;
  at: number;
}

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export class PoolTimerQueue {
  private readonly entries = new Map<string, PoolTimerEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly onDue: (entry: PoolTimerEntry) => void,
    private readonly now: () => number = Date.now,
    private readonly schedule: (ms: number, fn: () => void) => ReturnType<typeof setTimeout> = (ms, fn) => setTimeout(fn, ms),
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void = (timer) => clearTimeout(timer),
  ) {}

  upsert(entry: PoolTimerEntry): void {
    if (this.stopped) return;
    this.entries.set(entry.key, entry);
    this.arm();
  }

  remove(key: string): void {
    this.entries.delete(key);
    this.arm();
  }

  removeAccount(instanceId: string, accountId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.instanceId === instanceId && entry.accountId === accountId) this.entries.delete(key);
    }
    this.arm();
  }

  list(): PoolTimerEntry[] {
    return [...this.entries.values()].sort((a, b) => a.at - b.at);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.entries.clear();
  }

  private arm(): void {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    if (this.stopped || this.entries.size === 0) return;
    const next = this.list()[0];
    // Node fires a delay above 2^31-1 ms at once; a capped timer just re-arms when it fires early.
    const wait = Math.min(Math.max(0, next.at - this.now()), MAX_TIMER_DELAY_MS);
    this.timer = this.schedule(wait, () => {
      this.timer = null;
      const due = this.list().filter((entry) => entry.at <= this.now());
      for (const entry of due) this.entries.delete(entry.key);
      for (const entry of due) {
        try {
          this.onDue(entry);
        } catch {
          // The handler reports its own errors; one failure must not stop the other timers.
        }
      }
      this.arm();
    });
  }
}
