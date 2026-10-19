/**
 * Contract tests for the subscription account methods of IMetadataStore.
 * The same cases run on SQLite and on MongoDB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IMetadataStore } from "./interface.js";
import {
  SubscriptionAccountWriteConflictError,
  type SubscriptionAccountUsage,
  type UpsertSubscriptionAccountInput,
} from "../types.js";

let groupSeq = 0;

async function createPoolGroup(store: IMetadataStore, agents: string[]): Promise<string> {
  groupSeq += 1;
  const group = await store.createInstanceUpstreamGroup({
    group_type: "custom",
    name: `pool-${groupSeq}`,
    agents,
    mode: "subscription_pool",
  });
  return group.group_id;
}

function accountInput(
  groupId: string,
  over: Partial<UpsertSubscriptionAccountInput> = {},
): UpsertSubscriptionAccountInput {
  return {
    group_id: groupId,
    provider: "claude",
    provider_account_id: "provider-acct-1",
    display_name: "Max 1",
    account_label: "one@example.test (max_20x)",
    access_token: "access-token-1",
    refresh_token: "refresh-token-1",
    token_expires_at: 1_900_000_000_000,
    ...over,
  };
}

async function expectConflict(
  action: () => unknown,
  reason: SubscriptionAccountWriteConflictError["reason"],
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SubscriptionAccountWriteConflictError);
  expect((caught as SubscriptionAccountWriteConflictError).reason).toBe(reason);
}

export function runSubscriptionAccountContract(
  name: string,
  makeStore: () => Promise<IMetadataStore>,
  teardown: (store: IMetadataStore) => Promise<void>,
): void {
  describe(`subscription accounts: ${name}`, () => {
    let store: IMetadataStore;
    let groupId: string;

    beforeEach(async () => {
      store = await makeStore();
      await store.init();
      groupId = await createPoolGroup(store, ["claude-code"]);
    });

    afterEach(async () => {
      await teardown(store);
    });

    it("creates an account with default state and lists it by group", async () => {
      const { account, created } = await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      expect(created).toBe(true);
      expect(account.account_id).toMatch(/^sacc-/);
      expect(account).toMatchObject({
        group_id: groupId,
        provider: "claude",
        display_name: "Max 1",
        account_label: "one@example.test (max_20x)",
        enabled: true,
        status: "active",
        access_token: "access-token-1",
        refresh_token: "refresh-token-1",
        token_expires_at: 1_900_000_000_000,
        provider_account_id: "provider-acct-1",
        usage: { windows: [] },
        usage_updated_at: null,
        exhausted_until: null,
        usage_fail_count: 0,
        refresh_fail_count: 0,
        last_error: null,
        version: 1,
      });

      expect(await store.getSubscriptionAccount(account.account_id)).toEqual(account);
      expect(await store.listSubscriptionAccounts(groupId)).toEqual([account]);
      expect(await store.listSubscriptionAccounts()).toEqual([account]);
      expect(await store.getSubscriptionAccount("sacc-missing")).toBeNull();
    });

    it("replaces the tokens of the same provider account and keeps its name and state", async () => {
      const first = (await store.upsertSubscriptionAccountByProviderId(accountInput(groupId))).account;
      const usage: SubscriptionAccountUsage = {
        windows: [
          { name: "five_hour", used_pct: 40, resets_at: 1_800_000_000_000, observed_at: 1_700_000_000_000, source: "usage_api" },
        ],
      };
      await store.updateSubscriptionAccount(first.account_id, {
        enabled: false,
        status: "auth_error",
        usage,
        usage_updated_at: 1_700_000_000_000,
        refresh_fail_count: 2,
        last_error: "invalid_grant",
      });

      const result = await store.upsertSubscriptionAccountByProviderId(
        accountInput(groupId, {
          display_name: "ignored name",
          account_label: "one@example.test (max_20x, renewed)",
          access_token: "access-token-2",
          refresh_token: "refresh-token-2",
          token_expires_at: 1_950_000_000_000,
        }),
      );

      expect(result.created).toBe(false);
      expect(result.account.account_id).toBe(first.account_id);
      expect(result.account).toMatchObject({
        display_name: "Max 1",
        account_label: "one@example.test (max_20x, renewed)",
        enabled: false,
        // New tokens end the auth error. The admin switch is still off.
        status: "disabled",
        access_token: "access-token-2",
        refresh_token: "refresh-token-2",
        token_expires_at: 1_950_000_000_000,
        usage,
        refresh_fail_count: 0,
        last_error: null,
        version: first.version + 2,
      });
      expect(await store.listSubscriptionAccounts(groupId)).toHaveLength(1);
    });

    it("moves an account out of auth_error to active when the account is enabled", async () => {
      const first = (await store.upsertSubscriptionAccountByProviderId(accountInput(groupId))).account;
      await store.updateSubscriptionAccount(first.account_id, { status: "auth_error" });
      const again = await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      expect(again.account.status).toBe("active");
    });

    it("keeps an exhausted account exhausted when its tokens are replaced", async () => {
      const first = (await store.upsertSubscriptionAccountByProviderId(accountInput(groupId))).account;
      await store.updateSubscriptionAccount(first.account_id, {
        status: "exhausted",
        exhausted_until: 1_800_000_000_000,
      });
      const again = await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      expect(again.account.status).toBe("exhausted");
      expect(again.account.exhausted_until).toBe(1_800_000_000_000);
    });

    it("rejects a new account whose display name is used in the group", async () => {
      await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      await expectConflict(
        () => store.upsertSubscriptionAccountByProviderId(
          accountInput(groupId, { provider_account_id: "provider-acct-2" }),
        ),
        "name_duplicate",
      );
      expect(await store.listSubscriptionAccounts(groupId)).toHaveLength(1);
    });

    it("rejects an account for a group that does not exist", async () => {
      await expectConflict(
        () => store.upsertSubscriptionAccountByProviderId(accountInput("grp-missing")),
        "group_not_found",
      );
    });

    it("allows the same provider account and name in two groups", async () => {
      const otherGroup = await createPoolGroup(store, ["codex"]);
      const a = await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      const b = await store.upsertSubscriptionAccountByProviderId(accountInput(otherGroup));
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect(a.account.account_id).not.toBe(b.account.account_id);
      expect(await store.listSubscriptionAccounts(otherGroup)).toEqual([b.account]);
    });

    it("applies a patch, stores per-model windows and clears nullable fields with null", async () => {
      const { account } = await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      const usage: SubscriptionAccountUsage = {
        windows: [
          { name: "five_hour", used_pct: 12.5, resets_at: 1_800_000_000_000, observed_at: 1_700_000_000_000, source: "header" },
          { name: "seven_day", used_pct: 80, resets_at: 1_800_500_000_000, observed_at: 1_700_000_000_000, source: "usage_api" },
          { name: "seven_day_opus", model_scope: "opus", used_pct: 100, resets_at: null, observed_at: 1_700_000_000_000, source: "rate_limit_429" },
        ],
      };

      const updated = await store.updateSubscriptionAccount(account.account_id, {
        display_name: "Max 1 renamed",
        enabled: false,
        status: "exhausted",
        usage,
        usage_updated_at: 1_700_000_000_000,
        exhausted_until: 1_800_000_000_000,
        usage_fail_count: 3,
        last_error: "usage check failed",
      });
      expect(updated).toMatchObject({
        display_name: "Max 1 renamed",
        enabled: false,
        status: "exhausted",
        usage,
        usage_updated_at: 1_700_000_000_000,
        exhausted_until: 1_800_000_000_000,
        usage_fail_count: 3,
        last_error: "usage check failed",
        // Fields that the patch does not name keep their value.
        access_token: "access-token-1",
        refresh_token: "refresh-token-1",
        version: account.version + 1,
      });
      expect(await store.getSubscriptionAccount(account.account_id)).toEqual(updated);

      const cleared = await store.updateSubscriptionAccount(account.account_id, {
        exhausted_until: null,
        last_error: null,
        token_expires_at: null,
      });
      expect(cleared.exhausted_until).toBeNull();
      expect(cleared.last_error).toBeNull();
      expect(cleared.token_expires_at).toBeNull();
      expect(cleared.usage).toEqual(usage);
      expect(cleared.version).toBe(updated.version + 1);
    });

    it("throws version_mismatch when the expected version is stale", async () => {
      const { account } = await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      await store.updateSubscriptionAccount(account.account_id, { usage_fail_count: 1 }, account.version);
      await expectConflict(
        () => store.updateSubscriptionAccount(account.account_id, { usage_fail_count: 2 }, account.version),
        "version_mismatch",
      );
      const current = await store.getSubscriptionAccount(account.account_id);
      expect(current?.usage_fail_count).toBe(1);
      expect(current?.version).toBe(account.version + 1);
    });

    it("throws account_not_found when it updates an account that does not exist", async () => {
      await expectConflict(
        () => store.updateSubscriptionAccount("sacc-missing", { enabled: false }),
        "account_not_found",
      );
    });

    it("rejects a rename to a name that another account of the group uses", async () => {
      await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      const second = (await store.upsertSubscriptionAccountByProviderId(
        accountInput(groupId, { provider_account_id: "provider-acct-2", display_name: "Max 2" }),
      )).account;
      await expectConflict(
        () => store.updateSubscriptionAccount(second.account_id, { display_name: "Max 1" }),
        "name_duplicate",
      );
      // The same name on the same account is not a clash.
      const same = await store.updateSubscriptionAccount(second.account_id, { display_name: "Max 2" });
      expect(same.display_name).toBe("Max 2");
    });

    it("deletes one account and reports false for a missing account", async () => {
      const { account } = await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      expect(await store.deleteSubscriptionAccount(account.account_id)).toBe(true);
      expect(await store.getSubscriptionAccount(account.account_id)).toBeNull();
      expect(await store.deleteSubscriptionAccount(account.account_id)).toBe(false);
    });

    it("deletes the accounts of a group when the group is deleted", async () => {
      const otherGroup = await createPoolGroup(store, ["codex"]);
      await store.upsertSubscriptionAccountByProviderId(accountInput(groupId));
      await store.upsertSubscriptionAccountByProviderId(
        accountInput(groupId, { provider_account_id: "provider-acct-2", display_name: "Max 2" }),
      );
      const kept = (await store.upsertSubscriptionAccountByProviderId(accountInput(otherGroup))).account;

      expect(await store.deleteInstanceUpstreamGroup({ group_id: groupId })).toBe(true);

      expect(await store.listSubscriptionAccounts(groupId)).toEqual([]);
      expect(await store.listSubscriptionAccounts()).toEqual([kept]);
    });
  });
}
