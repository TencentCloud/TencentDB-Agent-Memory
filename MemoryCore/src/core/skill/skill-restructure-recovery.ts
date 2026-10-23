import type { SkillRestructureService } from "./skill-restructure-service.js";

interface SkillRestructureRecoveryOptions {
  resolve: (instanceId: string) => Promise<Pick<SkillRestructureService, "requeuePending">>;
  logger: { warn(message: string): void };
  intervalMs?: number;
  maxInstancesPerTick?: number;
  pageSize?: number;
}

/** Requeue durable operations, never scan skill contents or run models outside the worker pool. */
export class SkillRestructureRecovery {
  private readonly cursors = new Map<string, string | undefined>();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopped = true;

  constructor(private readonly options: SkillRestructureRecoveryOptions) {}

  register(instanceId: string): void {
    if (!this.cursors.has(instanceId)) this.cursors.set(instanceId, undefined);
  }

  forget(instanceId: string): void {
    this.cursors.delete(instanceId);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? 30_000);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve();
    this.inFlight = Promise.resolve().then(() => this.scan()).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async scan(): Promise<void> {
    const count = Math.min(this.cursors.size, this.options.maxInstancesPerTick ?? 10);
    for (let index = 0; index < count && !this.stopped; index++) {
      const entry = this.cursors.entries().next().value;
      if (!entry) return;
      const [instanceId, after] = entry;
      this.cursors.delete(instanceId);
      this.cursors.set(instanceId, after);
      try {
        const service = await this.options.resolve(instanceId);
        if (this.stopped || !this.cursors.has(instanceId)) continue;
        const page = await service.requeuePending({ limit: this.options.pageSize ?? 50, after });
        if (this.cursors.has(instanceId)) this.cursors.set(instanceId, page.next);
      } catch (error) {
        if (!this.stopped) this.options.logger.warn(`[skill-restructure-recovery] instance=${instanceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
