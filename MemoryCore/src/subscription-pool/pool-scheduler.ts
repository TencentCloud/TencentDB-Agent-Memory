import { apiRequestStorage } from "../api-trace/api-request-context.js";
import type { SubscriptionAccountChange } from "../metadata/service/metadata-service.js";
import type { SubscriptionAccountEntity } from "../metadata/types.js";
import { SUPPORTED_SUBSCRIPTION_PROVIDERS } from "./providers/index.js";
import type { RefreshOptions } from "./token-refresher.js";
import { PoolTimerQueue, type PoolTimerEntry, type PoolTimerKind } from "./timer-queue.js";
import { planAccountTimers, REFRESH_LEAD_MS } from "./timer-plan.js";

/** The part of `MetadataService` the scheduler uses. Routes and timers share these methods. */
export interface SubscriptionPoolSchedulerTarget {
  listSubscriptionAccountEntities(): Promise<SubscriptionAccountEntity[]>;
  subscriptionThreshold(): Promise<number>;
  runSubscriptionUsageCheck(accountId: string): Promise<unknown>;
  runSubscriptionTokenRefresh(accountId: string, options?: RefreshOptions): Promise<unknown>;
}

export interface SubscriptionPoolSchedulerOptions {
  getService: (instanceId: string) => Promise<SubscriptionPoolSchedulerTarget>;
  /** Interval of the usage check for every account. */
  checkIntervalMs: number;
  logger: { warn?: (message: string) => void; info?: (message: string) => void };
  /** Pause between two accounts of one pass, so the provider sees no burst. */
  accountGapMs?: number;
}

/** The interval pass also refreshes tokens with less than this time left. */
const SWEEP_REFRESH_WITHIN_MS = 40 * 60 * 1000;
/** A refresh timer can fire a little late; this margin keeps it from being skipped. */
const REFRESH_TIMER_MARGIN_MS = 60 * 1000;
const PLANNED_KINDS = ["refresh", "reset-check"] as const;

function errorCode(error: unknown): string {
  // Only a code or a class name is logged: provider and store messages can quote request data.
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string") return error.reason;
  return error instanceof Error ? error.name : "error";
}

/**
 * In-memory timers of the subscription pool for every instance this Core serves. Nothing is read
 * from the database after an instance's startup pass; every account write reaches `syncAccount`.
 * One Core process per instance must run this; several replicas would need a lease first.
 */
export class SubscriptionPoolScheduler {
  // Timers are armed from inside HTTP requests; they must not carry that request's trace context.
  private readonly queue = new PoolTimerQueue(
    (entry) => { void this.run(entry); },
    Date.now,
    (ms, fn) => apiRequestStorage.exit(() => setTimeout(fn, ms)),
  );
  private readonly instances = new Set<string>();
  private readonly accountGapMs: number;
  private stopped = false;

  constructor(private readonly options: SubscriptionPoolSchedulerOptions) {
    this.accountGapMs = options.accountGapMs ?? 1000;
  }

  /** Starts the timers of an instance the first time it is seen. Resolves when its startup pass ends. */
  async registerInstance(instanceId: string): Promise<void> {
    if (this.stopped || this.instances.has(instanceId)) return;
    this.instances.add(instanceId);
    this.armSweep(instanceId);
    await apiRequestStorage.exit(() => this.pass(instanceId, REFRESH_LEAD_MS, true));
  }

  /** Re-plans the timers of one account after any write to it. */
  syncAccount(instanceId: string, change: SubscriptionAccountChange): void {
    if (this.stopped) return;
    const { accountId, account } = change;
    if (!account || !account.enabled || account.status === "disabled" || account.status === "auth_error") {
      this.queue.removeAccount(instanceId, accountId);
      return;
    }
    const plan = planAccountTimers(account, change.thresholdPct, Date.now());
    for (const kind of PLANNED_KINDS) {
      const timer = plan.find((item) => item.kind === kind);
      if (timer) this.upsert(instanceId, accountId, kind, timer.at);
      else this.queue.remove(this.key(instanceId, accountId, kind));
    }
    if (change.retryRefreshAt !== undefined) this.upsert(instanceId, accountId, "retry-refresh", change.retryRefreshAt);
    else if (account.refresh_fail_count === 0) this.queue.remove(this.key(instanceId, accountId, "retry-refresh"));
    if (change.retryUsageAt !== undefined) this.upsert(instanceId, accountId, "retry-usage", change.retryUsageAt);
    else if (account.usage_fail_count === 0) this.queue.remove(this.key(instanceId, accountId, "retry-usage"));
  }

  pendingTimers(): PoolTimerEntry[] {
    return this.queue.list();
  }

  stop(): void {
    this.stopped = true;
    this.queue.stop();
    this.instances.clear();
  }

  private key(instanceId: string, accountId: string, kind: PoolTimerKind): string {
    return `${instanceId}\0${accountId}\0${kind}`;
  }

  private upsert(instanceId: string, accountId: string, kind: PoolTimerKind, at: number): void {
    this.queue.upsert({ key: this.key(instanceId, accountId, kind), instanceId, accountId, kind, at });
  }

  private armSweep(instanceId: string): void {
    this.upsert(instanceId, "", "usage-sweep", Date.now() + this.options.checkIntervalMs);
  }

  /**
   * One account at a time: refresh a token that expires soon, then read usage. At startup the
   * stored state arms the timers first, so a failing provider still leaves the timers in place.
   */
  private async pass(instanceId: string, refreshWithinMs: number, armFromSnapshot: boolean): Promise<void> {
    let svc: SubscriptionPoolSchedulerTarget;
    let accounts: SubscriptionAccountEntity[];
    try {
      svc = await this.options.getService(instanceId);
      accounts = await svc.listSubscriptionAccountEntities();
      if (armFromSnapshot) {
        const thresholdPct = await svc.subscriptionThreshold();
        for (const account of accounts) this.syncAccount(instanceId, { accountId: account.account_id, account, thresholdPct });
      }
    } catch (error) {
      this.options.logger.warn?.(`[subscription-pool] pass failed instance=${instanceId} error=${errorCode(error)}`);
      return;
    }
    const active = accounts.filter((account) => account.enabled
      && account.status !== "disabled"
      && account.status !== "auth_error"
      && SUPPORTED_SUBSCRIPTION_PROVIDERS.includes(account.provider));
    for (const [index, account] of active.entries()) {
      if (this.stopped) return;
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, this.accountGapMs));
      if (this.stopped) return;
      // A refresh that failed before a restart lost its retry timer, so it runs again now.
      const refreshOptions = armFromSnapshot && account.refresh_fail_count > 0 ? {} : { ifExpiresWithinMs: refreshWithinMs };
      await this.guard(instanceId, account.account_id, "refresh", () => svc.runSubscriptionTokenRefresh(account.account_id, refreshOptions));
      await this.guard(instanceId, account.account_id, "usage", () => svc.runSubscriptionUsageCheck(account.account_id));
    }
  }

  private async run(entry: PoolTimerEntry): Promise<void> {
    if (this.stopped) return;
    if (entry.kind === "usage-sweep") {
      this.armSweep(entry.instanceId);
      await this.pass(entry.instanceId, SWEEP_REFRESH_WITHIN_MS, false);
      return;
    }
    await this.guard(entry.instanceId, entry.accountId, entry.kind, async () => {
      const svc = await this.options.getService(entry.instanceId);
      if (entry.kind === "refresh") {
        await svc.runSubscriptionTokenRefresh(entry.accountId, { ifExpiresWithinMs: REFRESH_LEAD_MS + REFRESH_TIMER_MARGIN_MS });
      } else if (entry.kind === "retry-refresh") {
        await svc.runSubscriptionTokenRefresh(entry.accountId);
      } else {
        await svc.runSubscriptionUsageCheck(entry.accountId);
      }
    });
  }

  private async guard(instanceId: string, accountId: string, what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      const code = errorCode(error);
      if (code === "account_not_found") {
        this.queue.removeAccount(instanceId, accountId);
        return;
      }
      this.options.logger.warn?.(`[subscription-pool] ${what} failed instance=${instanceId} account=${accountId} error=${code}`);
    }
  }
}
