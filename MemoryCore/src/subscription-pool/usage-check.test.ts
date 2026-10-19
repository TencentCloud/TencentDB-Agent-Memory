import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubscriptionQuotaWindow } from "../metadata/types.js";
import { checkAccountUsage, USAGE_CHECK_FAILED } from "./usage-check.js";
import { createPoolFixture, fakeAdapter, type PoolFixture } from "./test-support.js";

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

function win(used_pct: number, resets_at: number | null, partial: Partial<SubscriptionQuotaWindow> = {}): SubscriptionQuotaWindow {
  return { name: "primary_window", model_scope: null, used_pct, resets_at, observed_at: NOW, source: "usage_api", ...partial };
}

describe("checkAccountUsage", () => {
  let fx: PoolFixture;

  beforeEach(async () => {
    fx = await createPoolFixture();
  });

  afterEach(async () => {
    await fx.store.close();
  });

  it("stores the usage reading and clears the failure count", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { usage_fail_count: 2, last_error: USAGE_CHECK_FAILED });
    const adapter = fakeAdapter({ fetchUsage: async () => [win(30, NOW + 60 * MIN)] });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.failed).toBe(false);
    expect(result.account).toMatchObject({ usage_fail_count: 0, last_error: null, usage_updated_at: NOW });
    expect(result.account.usage.windows).toEqual([win(30, NOW + 60 * MIN)]);
  });

  it("releases an exhausted account when every shared window is below the threshold", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => [win(10, NOW + 5 * 60 * MIN), win(99, NOW + 60 * MIN, { name: "opus", model_scope: "gpt-5-codex" })] });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("keeps an account exhausted until the reset the provider returns", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => [win(100, NOW + 40 * MIN)] });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "exhausted", exhausted_until: NOW + 40 * MIN });
  });

  it("checks again in 15 minutes when a window at the threshold has no future reset time", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => [win(97, NOW - MIN)] });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account.exhausted_until).toBe(NOW + 15 * MIN);
    expect(result.account.usage.windows[0].resets_at).toBe(NOW + 15 * MIN);
  });

  it("does not mark an active account exhausted from a usage reading", async () => {
    const account = await fx.addAccount();
    const result = await checkAccountUsage(fx.store, account.account_id, fakeAdapter({ fetchUsage: async () => [win(100, NOW + MIN)] }), 95, NOW);
    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("counts a failure and keeps the stored usage", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { usage: { windows: [win(50, NOW + MIN)] } });
    const adapter = fakeAdapter({ fetchUsage: async () => { throw new Error("down"); } });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.failed).toBe(true);
    expect(result.account).toMatchObject({ usage_fail_count: 1, last_error: USAGE_CHECK_FAILED });
    expect(result.account.usage.windows).toEqual([win(50, NOW + MIN)]);
  });

  it("releases by time when the usage API fails after the reset", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW - 30_000 });
    const adapter = fakeAdapter({ fetchUsage: async () => { throw new Error("down"); } });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
  });

  it("does not release early when the usage API fails before the reset", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: NOW + 10 * MIN });
    const adapter = fakeAdapter({ fetchUsage: async () => { throw new Error("down"); } });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "exhausted", exhausted_until: NOW + 10 * MIN });
  });

  it("calls the provider with the stored token and account id", async () => {
    const account = await fx.addAccount();
    const adapter = fakeAdapter();
    await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);
    expect(adapter.fetchUsage).toHaveBeenCalledWith("access-1", "acct-1");
  });

  it("drops a stale window the provider no longer returns, so the account is released", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "exhausted",
      exhausted_until: NOW - 30_000,
      usage: { windows: [win(100, NOW - 30_000, { name: "primary", source: "429" }), win(100, NOW - 30_000, { name: "secondary_window", source: "429" })] },
    });
    const adapter = fakeAdapter({ fetchUsage: async () => [win(10, NOW + 5 * 60 * MIN)] });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account).toMatchObject({ status: "active", exhausted_until: null });
    expect(result.account.usage.windows.map((w) => w.name)).toEqual(["primary_window"]);
  });

  it("never sets an exhaustion time in the past", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, {
      status: "exhausted",
      exhausted_until: NOW - 30_000,
      usage: { windows: [win(100, NOW - MIN, { name: "weekly", source: "429" })] },
    });
    const adapter = fakeAdapter({ fetchUsage: async () => [win(100, NOW + 30 * MIN)] });

    const result = await checkAccountUsage(fx.store, account.account_id, adapter, 95, NOW);

    expect(result.account.exhausted_until).toBe(NOW + 30 * MIN);
  });
});
