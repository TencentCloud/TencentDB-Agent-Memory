import { vi } from "vitest";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import { MetadataService } from "../metadata/service/metadata-service.js";
import type { SubscriptionAccountEntity, SupportedAgent, UpsertSubscriptionAccountInput } from "../metadata/types.js";
import type { ExchangedSubscriptionTokens, SubscriptionProviderAdapter } from "./providers/types.js";

export const POOL_AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
];

export interface PoolFixture {
  store: SqliteMetadataStore;
  svc: MetadataService;
  groupId: string;
  addAccount(input?: Partial<UpsertSubscriptionAccountInput>): Promise<SubscriptionAccountEntity>;
}

/** In-memory store with an enabled Codex pool group. */
export async function createPoolFixture(): Promise<PoolFixture> {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const svc = new MetadataService(store, "default");
  await svc.enableSubscriptionPool("codex", POOL_AGENTS);
  const groupId = (await store.listInstanceUpstreamGroups()).find((group) => group.mode === "subscription_pool")!.group_id;
  let n = 0;
  return {
    store,
    svc,
    groupId,
    async addAccount(input = {}) {
      n += 1;
      const { account } = await store.upsertSubscriptionAccountByProviderId({
        group_id: groupId,
        provider: "codex",
        provider_account_id: `acct-${n}`,
        display_name: `Pro ${n}`,
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        token_expires_at: Date.now() + 60 * 60 * 1000,
        ...input,
      });
      return account;
    },
  };
}

export function tokens(partial: Partial<ExchangedSubscriptionTokens> = {}): ExchangedSubscriptionTokens {
  return {
    accessToken: "access-new",
    refreshToken: "refresh-new",
    expiresAt: Date.now() + 8 * 24 * 60 * 60 * 1000,
    providerAccountId: "",
    accountLabel: "",
    ...partial,
  };
}

/** Codex adapter whose methods are mocks; `partial` gives their first implementation. */
export function fakeAdapter(partial: Partial<Omit<SubscriptionProviderAdapter, "provider">> = {}) {
  return {
    provider: "codex" as const,
    exchangeCode: vi.fn<SubscriptionProviderAdapter["exchangeCode"]>(partial.exchangeCode ?? (async () => tokens())),
    refresh: vi.fn<SubscriptionProviderAdapter["refresh"]>(partial.refresh ?? (async () => tokens())),
    fetchUsage: vi.fn<SubscriptionProviderAdapter["fetchUsage"]>(partial.fetchUsage ?? (async () => [])),
  } satisfies SubscriptionProviderAdapter;
}
