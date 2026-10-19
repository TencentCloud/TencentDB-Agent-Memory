import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubscriptionProviderError } from "./providers/types.js";
import { nextRetryDelayMs, refreshAccountTokens } from "./token-refresher.js";
import { createPoolFixture, fakeAdapter, tokens, type PoolFixture } from "./test-support.js";

const MIN = 60 * 1000;

describe("refreshAccountTokens", () => {
  let fx: PoolFixture;

  beforeEach(async () => {
    fx = await createPoolFixture();
  });

  afterEach(async () => {
    await fx.store.close();
  });

  it("stores the rotated token pair and keeps the account state", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { status: "exhausted", exhausted_until: Date.now() + 30 * MIN });
    const adapter = fakeAdapter();

    const result = await refreshAccountTokens(fx.store, account.account_id, adapter);

    expect(adapter.refresh).toHaveBeenCalledWith("refresh-1");
    expect(result.refreshed).toBe(true);
    const stored = await fx.store.getSubscriptionAccount(account.account_id);
    expect(stored).toMatchObject({ access_token: "access-new", refresh_token: "refresh-new", status: "exhausted", refresh_fail_count: 0 });
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const account = await fx.addAccount();
    await refreshAccountTokens(fx.store, account.account_id, fakeAdapter({ refresh: async () => tokens({ refreshToken: "" }) }));
    expect((await fx.store.getSubscriptionAccount(account.account_id))?.refresh_token).toBe("refresh-1");
  });

  it("does not lose a rotated token when a usage write lands during the refresh", async () => {
    const account = await fx.addAccount();
    const adapter = fakeAdapter({
      refresh: async () => {
        await fx.store.updateSubscriptionAccount(account.account_id, { active_sessions: 3 });
        return tokens();
      },
    });

    await refreshAccountTokens(fx.store, account.account_id, adapter);

    expect(await fx.store.getSubscriptionAccount(account.account_id)).toMatchObject({ refresh_token: "refresh-new", active_sessions: 3 });
  });

  it("skips the provider when the token has more time left than asked", async () => {
    const account = await fx.addAccount({ token_expires_at: Date.now() + 60 * MIN });
    const adapter = fakeAdapter();
    const result = await refreshAccountTokens(fx.store, account.account_id, adapter, { ifExpiresWithinMs: 40 * MIN });
    expect(result.refreshed).toBe(false);
    expect(adapter.refresh).not.toHaveBeenCalled();
  });

  it("returns the newer token without a provider call when the caller holds an older one", async () => {
    const account = await fx.addAccount();
    const held = account.token_expires_at;
    await refreshAccountTokens(fx.store, account.account_id, fakeAdapter());
    const adapter = fakeAdapter();

    const result = await refreshAccountTokens(fx.store, account.account_id, adapter, { heldExpiresAt: held });

    expect(adapter.refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refreshed: false, failed: false });
    expect(result.account.access_token).toBe("access-new");
  });

  it("refreshes at once when the caller holds the current token, even if it is not near expiry", async () => {
    const account = await fx.addAccount({ token_expires_at: Date.now() + 5 * 24 * 60 * MIN });
    const adapter = fakeAdapter();
    const result = await refreshAccountTokens(fx.store, account.account_id, adapter, { heldExpiresAt: account.token_expires_at });
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    expect(result.refreshed).toBe(true);
  });

  it("makes one provider call for concurrent 401 refreshes of the same token", async () => {
    const account = await fx.addAccount();
    const adapter = fakeAdapter();
    const held = account.token_expires_at;
    await Promise.all([
      refreshAccountTokens(fx.store, account.account_id, adapter, { heldExpiresAt: held }),
      refreshAccountTokens(fx.store, account.account_id, adapter, { heldExpiresAt: held }),
      refreshAccountTokens(fx.store, account.account_id, adapter, { heldExpiresAt: held }),
    ]);
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
  });

  it("marks the account for a new login on a permanent failure", async () => {
    const account = await fx.addAccount();
    const adapter = fakeAdapter({ refresh: async () => { throw new SubscriptionProviderError("refresh_token_reused", true, 401); } });

    const result = await refreshAccountTokens(fx.store, account.account_id, adapter);

    expect(result).toMatchObject({ failed: true, retryAt: null });
    expect(result.account).toMatchObject({ status: "auth_error", last_error: "re-login needed" });
  });

  it("schedules a retry after 1, 5 and 15 minutes on transient failures and keeps serving", async () => {
    const account = await fx.addAccount();
    const adapter = fakeAdapter({ refresh: async () => { throw new TypeError("fetch failed"); } });

    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const before = Date.now();
      const result = await refreshAccountTokens(fx.store, account.account_id, adapter);
      delays.push(Math.round((result.retryAt! - before) / MIN));
      expect(result.failed).toBe(true);
      expect(result.account.status).toBe("active");
    }

    expect(delays).toEqual([1, 5, 15, 15]);
    expect((await fx.store.getSubscriptionAccount(account.account_id))?.refresh_fail_count).toBe(4);
  });

  it("clears the refresh failure state after a success", async () => {
    const account = await fx.addAccount();
    await fx.store.updateSubscriptionAccount(account.account_id, { refresh_fail_count: 2, last_error: "refresh failed" });
    const result = await refreshAccountTokens(fx.store, account.account_id, fakeAdapter());
    expect(result.account).toMatchObject({ refresh_fail_count: 0, last_error: null });
  });

  it("caps the retry delay at 15 minutes", () => {
    expect(nextRetryDelayMs(9)).toBe(15 * MIN);
  });

  it("keeps the stored access token and expiry when the refresh response has none", async () => {
    const account = await fx.addAccount();
    await refreshAccountTokens(fx.store, account.account_id, fakeAdapter({ refresh: async () => tokens({ accessToken: "", expiresAt: null, refreshToken: "refresh-rotated" }) }));
    expect(await fx.store.getSubscriptionAccount(account.account_id)).toMatchObject({
      access_token: "access-1",
      token_expires_at: account.token_expires_at,
      refresh_token: "refresh-rotated",
    });
  });
});
