import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionQuotaWindow } from "../metadata/types.js";
import { SubscriptionPoolScheduler } from "./pool-scheduler.js";
import { createPoolFixture, fakeAdapter, tokens, type PoolFixture } from "./test-support.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;

function win(used_pct: number, resets_at: number | null): SubscriptionQuotaWindow {
  return { name: "primary_window", model_scope: null, used_pct, resets_at, observed_at: Date.now(), source: "usage_api" };
}

describe("SubscriptionPoolScheduler", () => {
  let fx: PoolFixture;
  let adapter: ReturnType<typeof fakeAdapter>;
  let scheduler: SubscriptionPoolScheduler;
  const warnings: string[] = [];

  async function setup(checkIntervalMs = 24 * HOUR) {
    fx = await createPoolFixture();
    adapter = fakeAdapter();
    scheduler = new SubscriptionPoolScheduler({
      getService: async () => fx.svc,
      checkIntervalMs,
      logger: { warn: (message: string) => warnings.push(message) },
    });
    fx.svc.setSubscriptionPoolHooks({
      adapterFor: () => adapter,
      onAccountChanged: (instanceId, change) => scheduler.syncAccount(instanceId, change),
    });
  }

  async function register() {
    const done = scheduler.registerInstance("default");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
  }

  async function at(ms: number) {
    await vi.advanceTimersByTimeAsync(T0 + ms - Date.now());
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0);
    warnings.length = 0;
  });

  afterEach(async () => {
    scheduler.stop();
    await fx.store.close();
    vi.useRealTimers();
  });

  it("checks usage at startup and releases an exhausted account at its reset", async () => {
    await setup();
    const account = await fx.addAccount({ token_expires_at: T0 + 8 * 24 * HOUR });
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: T0 + 20 * MIN });
    adapter.fetchUsage.mockResolvedValueOnce([win(100, T0 + 20 * MIN)]).mockResolvedValue([win(10, T0 + 5 * HOUR)]);

    await register();
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(1);
    expect((await fx.store.getSubscriptionAccount(account.account_id))?.status).toBe("exhausted");

    await at(20 * MIN + 29_000);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(1);
    await at(20 * MIN + 30_000);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(2);
    expect(await fx.store.getSubscriptionAccount(account.account_id)).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("keeps the stored timers when the usage API is down and retries after 1, 5 and 15 minutes", async () => {
    await setup();
    const account = await fx.addAccount({ token_expires_at: T0 + 8 * 24 * HOUR });
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: T0 + 60 * MIN });
    adapter.fetchUsage.mockRejectedValue(new Error("usage api down"));

    await register();
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(1);
    await at(1 * MIN);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(2);
    await at(6 * MIN);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(3);
    await at(21 * MIN);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(4);
    await at(59 * MIN);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(4);
    expect((await fx.store.getSubscriptionAccount(account.account_id))?.usage_fail_count).toBe(4);

    await at(60 * MIN + 30_000);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(5);
    expect(await fx.store.getSubscriptionAccount(account.account_id)).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("refreshes a token 10 minutes before it expires, even when the account is idle", async () => {
    await setup();
    await fx.addAccount({ token_expires_at: T0 + 30 * MIN });

    await register();
    expect(adapter.refresh).not.toHaveBeenCalled();
    await at(20 * MIN - 1_000);
    expect(adapter.refresh).not.toHaveBeenCalled();
    await at(20 * MIN);
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes at startup a token with less than 10 minutes left", async () => {
    await setup();
    await fx.addAccount({ token_expires_at: T0 + 5 * MIN });
    await register();
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
  });

  it("retries a failed refresh after 1 minute without a refresh loop", async () => {
    await setup();
    await fx.addAccount({ token_expires_at: T0 + 5 * MIN });
    adapter.refresh.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(tokens());

    await register();
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    await at(59_000);
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    await at(MIN);
    expect(adapter.refresh).toHaveBeenCalledTimes(2);
  });

  it("checks every account each interval and refreshes tokens with less than 40 minutes left", async () => {
    await setup(30 * MIN);
    await fx.addAccount({ token_expires_at: T0 + 8 * 24 * HOUR });
    await fx.addAccount({ token_expires_at: T0 + 65 * MIN });

    await register();
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(2);
    expect(adapter.refresh).not.toHaveBeenCalled();

    await at(30 * MIN + 5_000);
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(4);
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    expect(adapter.refresh).toHaveBeenCalledWith("refresh-2");
  });

  it("skips disabled accounts and accounts that need a new login", async () => {
    await setup();
    const a = await fx.addAccount({ token_expires_at: T0 + 5 * MIN });
    const b = await fx.addAccount({ token_expires_at: T0 + 5 * MIN });
    await fx.store.updateSubscriptionAccount(a.account_id, { enabled: false });
    await fx.store.updateSubscriptionAccount(b.account_id, { status: "auth_error" });

    await register();

    expect(adapter.fetchUsage).not.toHaveBeenCalled();
    expect(adapter.refresh).not.toHaveBeenCalled();
    expect(scheduler.pendingTimers().filter((entry) => entry.kind !== "usage-sweep")).toEqual([]);
  });

  it("keeps the other timers running when an account disappears", async () => {
    await setup();
    const gone = await fx.addAccount({ token_expires_at: T0 + 20 * MIN });
    await fx.addAccount({ token_expires_at: T0 + 20 * MIN });
    await register();
    await fx.store.deleteSubscriptionAccount(gone.account_id);

    await at(10 * MIN);

    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    expect(adapter.refresh).toHaveBeenCalledWith("refresh-2");
  });

  it("drops the timers of a deleted account and arms a reset check after a reported 429", async () => {
    await setup();
    const account = await fx.addAccount({ token_expires_at: T0 + 8 * 24 * HOUR });
    await register();

    const reportedAt = Date.now();
    await fx.svc.reportSubscriptionAccount(account.account_id, { status_code: 429, retry_after: 600 });
    expect(scheduler.pendingTimers()).toContainEqual(expect.objectContaining({ kind: "reset-check", at: reportedAt + 10 * MIN + 30_000 }));

    await fx.svc.deleteSubscriptionAccount(account.account_id);
    expect(scheduler.pendingTimers().filter((entry) => entry.accountId === account.account_id)).toEqual([]);
  });

  it("registers an instance once and stops every timer", async () => {
    await setup();
    await fx.addAccount();
    await register();
    await register();
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(1);

    scheduler.stop();

    expect(scheduler.pendingTimers()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never logs a token", async () => {
    await setup();
    await fx.addAccount({ token_expires_at: T0 + 5 * MIN });
    adapter.refresh.mockRejectedValue(new Error("upstream said refresh-1 is bad"));
    adapter.fetchUsage.mockRejectedValue(new Error("access-1 rejected"));
    await register();
    await at(30 * MIN);
    expect(warnings.join("\n")).not.toMatch(/access-1|refresh-1/);
  });

  it("does not loop on reset checks when the usage API omits a window held by a 429", async () => {
    await setup();
    const account = await fx.addAccount({ token_expires_at: T0 + 8 * 24 * HOUR });
    adapter.fetchUsage.mockImplementation(async () => [win(10, T0 + 5 * HOUR)]);
    await register();
    await fx.svc.reportSubscriptionAccount(account.account_id, {
      windows: [{ ...win(50, T0 + 5 * HOUR), name: "primary", source: "header" }],
    });
    await fx.svc.reportSubscriptionAccount(account.account_id, { status_code: 429, retry_after: 1 });
    const before = adapter.fetchUsage.mock.calls.length;

    await at(10 * MIN);

    expect(adapter.fetchUsage.mock.calls.length - before).toBe(1);
    expect(await fx.store.getSubscriptionAccount(account.account_id)).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("retries at startup a refresh that failed before the restart", async () => {
    await setup();
    const account = await fx.addAccount({ token_expires_at: T0 + 5 * HOUR });
    await fx.store.updateSubscriptionAccount(account.account_id, { refresh_fail_count: 1, last_error: "refresh failed" });
    await register();
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    expect((await fx.store.getSubscriptionAccount(account.account_id))?.refresh_fail_count).toBe(0);
  });
});
