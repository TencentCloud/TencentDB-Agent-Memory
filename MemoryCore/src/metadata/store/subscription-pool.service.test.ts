import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type * as http from "node:http";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import { MetadataService, type SubscriptionAccountChange } from "../service/metadata-service.js";
import { SubscriptionProviderError } from "../../subscription-pool/providers/types.js";
import { fakeAdapter, tokens } from "../../subscription-pool/test-support.js";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import type { SupportedAgent } from "../types.js";

const AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic", display_name: "Claude Code" },
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
];

describe("subscription pool service", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
  });

  afterEach(async () => {
    await store.close();
  });

  it("moves codex onto a pool group and back onto the same default group", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const enabled = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const defaultGroup = enabled.find((group) => group.group_type === "default");
    const pool = enabled.find((group) => group.mode === "subscription_pool");
    expect(defaultGroup?.agents).not.toContain("codex");
    expect(defaultGroup?.agents).toContain("claude-code");
    expect(pool?.agents).toEqual(["codex"]);
    expect(pool?.base_url).toBe("");
    expect(pool?.api_key).toBe("");

    const disabled = await svc.disableSubscriptionPool("codex", AGENTS);
    const after = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const defaultAfter = after.find((group) => group.group_type === "default");
    expect(defaultAfter?.group_id).toBe(defaultGroup?.group_id);
    expect(defaultAfter?.agents).toContain("codex");
    expect(disabled.default_group_id).toBe(defaultGroup?.group_id);
    expect(after.find((group) => group.group_id === pool?.group_id)?.agents).toEqual([]);
  });

  it("refuses to enable the pool when the agent already has a custom upstream", async () => {
    await store.ensureDefaultSeeded(AGENTS);
    const groups = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const fallback = groups.find((group) => group.group_type === "default")!;
    await store.moveAgentBetweenUpstreamGroups({
      agent: "codex",
      from: [{ group_id: fallback.group_id }],
      to: { create: { name: "office gateway", mode: "custom_unified", base_url: "https://gw.example.test", api_key: "secret" } },
    });
    await expect(svc.enableSubscriptionPool("codex", AGENTS)).rejects.toMatchObject({ code: "POOL_AGENT_CUSTOM_GROUP" });
    const still = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    expect(still.find((group) => group.name === "office gateway")?.agents).toEqual(["codex"]);
  });

  it("rejects a base url on a subscription pool group", async () => {
    await expect(svc.createInstanceUpstreamCustomGroup({
      name: "claude subscription pool",
      agents: ["claude-code"],
      mode: "subscription_pool",
      base_url: "https://api.anthropic.com",
      api_key: "should-not-stick",
    }, AGENTS)).rejects.toMatchObject({ code: "POOL_REJECTS_UPSTREAM_CREDENTIALS" });
  });

  it("hides tokens on the public status and shows the access token only to the proxy", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const pool = (await store.listInstanceUpstreamGroups()).find((group) => group.mode === "subscription_pool")!;
    await store.upsertSubscriptionAccountByProviderId({
      group_id: pool.group_id,
      provider: "codex",
      provider_account_id: "acct-codex-1",
      display_name: "Plus 1",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_expires_at: Date.now() + 60 * 60 * 1000,
    });

    const status = JSON.stringify(await svc.getSubscriptionPoolStatus("codex"));
    expect(status).not.toContain("access-secret");
    expect(status).not.toContain("refresh-secret");
    expect(status).not.toContain("access_token");
    expect(status).not.toContain("refresh_token");

    const listed = await svc.listSubscriptionAccountsInternal();
    expect(listed.accounts).toEqual([expect.objectContaining({
      access_token: "access-secret",
      provider_account_id: "acct-codex-1",
    })]);
    expect(JSON.stringify(listed)).not.toContain("refresh-secret");
    expect(JSON.stringify(listed)).not.toContain("refresh_token");

    await svc.disableSubscriptionPool("codex", AGENTS);
    expect((await svc.listSubscriptionAccountsInternal()).accounts).toEqual([]);
  });

  it("marks an account exhausted when the proxy reports 429", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const pool = (await store.listInstanceUpstreamGroups()).find((group) => group.mode === "subscription_pool")!;
    const { account } = await store.upsertSubscriptionAccountByProviderId({
      group_id: pool.group_id,
      provider: "codex",
      provider_account_id: "acct-codex-1",
      display_name: "Max 1",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_expires_at: null,
    });
    const before = Date.now();
    const reported = await svc.reportSubscriptionAccount(account.account_id, { status_code: 429 });
    expect(reported.status).toBe("exhausted");
    expect(reported.exhausted_until).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);
    const stored = await store.getSubscriptionAccount(account.account_id);
    expect(stored?.status).toBe("exhausted");
    expect(JSON.stringify(reported)).not.toContain("access-secret");
  });

  it("returns an authorize url without the code verifier", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const started = svc.startSubscriptionOAuth("codex");
    expect(started.authorize_url).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(started.authorize_url).toContain(`state=${started.state}`);
    expect(started.authorize_url).not.toContain("code_verifier");
    expect(JSON.stringify(started)).not.toContain("codeVerifier");
  });

  it("moves claude-code onto its own pool and returns a Claude authorize URL", async () => {
    await svc.enableSubscriptionPool("claude", AGENTS);
    const enabled = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const defaultGroup = enabled.find((group) => group.group_type === "default");
    const pool = enabled.find((group) => group.mode === "subscription_pool");
    expect(defaultGroup?.agents).not.toContain("claude-code");
    expect(defaultGroup?.agents).toContain("codex");
    expect(pool?.agents).toEqual(["claude-code"]);
    expect(pool?.name).toBe("claude subscription pool");

    const started = svc.startSubscriptionOAuth("claude");
    const url = new URL(started.authorize_url);
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    expect(started.authorize_url).not.toContain("code_verifier");
    expect(JSON.stringify(started)).not.toContain("codeVerifier");

    await svc.disableSubscriptionPool("claude", AGENTS);
    const disabled = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    expect(disabled.find((group) => group.group_type === "default")?.agents).toContain("claude-code");
  });
});

describe("subscription pool provider calls", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;
  let adapter: ReturnType<typeof fakeAdapter>;
  let changes: SubscriptionAccountChange[];

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
    adapter = fakeAdapter({
      exchangeCode: vi.fn(async () => tokens({ providerAccountId: "acct-9", accountLabel: "pool@example.com pro" })),
    });
    changes = [];
    svc.setSubscriptionPoolHooks({ adapterFor: () => adapter, onAccountChanged: (_instanceId, change) => { changes.push(change); } });
  });

  afterEach(async () => {
    await store.close();
  });

  async function login(redirect = true) {
    const started = svc.startSubscriptionOAuth("codex");
    const input = redirect
      ? { redirect_url: `http://localhost:1455/auth/callback?code=code-1&state=${started.state}` }
      : { code: "code-1" };
    return { started, account: await svc.completeSubscriptionOAuth({ provider: "codex", state: started.state, ...input }) };
  }

  it("adds a claude account from a code#state paste and hides the tokens", async () => {
    adapter.fetchUsage.mockResolvedValue([{
      name: "five_hour", model_scope: null, used_pct: 40, resets_at: null, observed_at: 1, source: "usage_api",
    }]);
    const started = svc.startSubscriptionOAuth("claude");
    const account = await svc.completeSubscriptionOAuth({
      provider: "claude",
      state: started.state,
      code: `code-1#${started.state}`,
    });
    expect(account).toMatchObject({ provider: "claude", provider_account_id: "acct-9", created: true });
    expect(JSON.stringify(account)).not.toContain("access-new");
    expect(JSON.stringify(account)).not.toContain("refresh-new");
    const stored = (await store.listSubscriptionAccounts()).find((row) => row.account_id === account.account_id);
    expect(stored).toMatchObject({ provider: "claude", access_token: "access-new", refresh_token: "refresh-new" });
    expect(adapter.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({
      code: "code-1",
      state: started.state,
      redirectUri: "https://platform.claude.com/oauth/code/callback",
    }));
    expect(adapter.fetchUsage).toHaveBeenCalledWith("access-new", "acct-9");
    expect(account.usage).toMatchObject({ windows: [expect.objectContaining({ name: "five_hour", used_pct: 40 })] });
  });

  it("adds an account while the pool is off and keeps it from the proxy until the pool is on", async () => {
    const { account } = await login();

    const groups = await store.listInstanceUpstreamGroups(undefined, AGENTS);
    const pool = groups.find((group) => group.mode === "subscription_pool");
    expect(pool).toMatchObject({ enabled: false, agents: [] });
    expect(account.group_id).toBe(pool?.group_id);
    expect(groups.find((group) => group.group_type === "default")?.agents).toContain("codex");
    expect((await svc.listSubscriptionAccountsInternal()).accounts).toEqual([]);

    await svc.enableSubscriptionPool("codex", AGENTS);

    const enabled = (await store.listInstanceUpstreamGroups(undefined, AGENTS)).filter((group) => group.mode === "subscription_pool");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ group_id: pool?.group_id, enabled: true, agents: ["codex"] });
    expect((await svc.listSubscriptionAccountsInternal()).accounts).toHaveLength(1);
    const status = await svc.getSubscriptionPoolStatus("codex") as { providers: Array<{ group_id: string | null; accounts: unknown[] }> };
    expect(status.providers[0]).toMatchObject({ group_id: pool?.group_id });
    expect(status.providers[0].accounts).toHaveLength(1);
  });

  it("creates an account from the pasted redirect url and returns it without tokens", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const { started, account } = await login();

    expect(adapter.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ code: "code-1", state: started.state }));
    expect(account).toMatchObject({ provider: "codex", provider_account_id: "acct-9", display_name: "pool@example.com pro", created: true });
    expect(JSON.stringify(account)).not.toMatch(/access-new|refresh-new|access_token|refresh_token/);
    const stored = (await store.listSubscriptionAccounts())[0];
    expect(stored).toMatchObject({ access_token: "access-new", refresh_token: "refresh-new" });
    expect(changes.at(-1)?.account?.account_id).toBe(stored.account_id);
  });

  it("replaces the tokens of the same provider account and keeps its name", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const { account } = await login();
    await svc.updateSubscriptionAccount(String(account.account_id), { display_name: "Pro A" });
    adapter.exchangeCode.mockResolvedValueOnce(tokens({ providerAccountId: "acct-9", accessToken: "access-2", refreshToken: "refresh-2" }));

    const again = await login();

    expect(again.account).toMatchObject({ account_id: account.account_id, display_name: "Pro A", created: false });
    expect((await store.listSubscriptionAccounts())[0]).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
  });

  it("returns an account that needed a new login to service after the re-login", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const { account } = await login();
    const id = String(account.account_id);
    await store.updateSubscriptionAccount(id, { status: "auth_error", refresh_fail_count: 2, last_error: "re-login needed" });

    await login();

    expect(await store.getSubscriptionAccount(id)).toMatchObject({ status: "active", refresh_fail_count: 0, last_error: null });
    expect(changes.at(-1)?.account?.status).toBe("active");
  });

  it("keeps an admin switch-off through a re-login", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const { account } = await login();
    await svc.updateSubscriptionAccount(String(account.account_id), { enabled: false });
    await login();
    expect((await store.getSubscriptionAccount(String(account.account_id)))?.enabled).toBe(false);
  });

  it("uses a login state only once", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const { started } = await login();
    await expect(svc.completeSubscriptionOAuth({ provider: "codex", state: started.state, code: "code-1" }))
      .rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
  });

  it("reports a failed code exchange without the provider body", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    adapter.exchangeCode.mockRejectedValueOnce(new SubscriptionProviderError("bad code", true, 400));
    await expect(login(false)).rejects.toMatchObject({ code: "OAUTH_EXCHANGE_FAILED" });
  });

  it("checks usage now and returns the account without tokens", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    const { account } = await login();
    adapter.fetchUsage.mockResolvedValueOnce([{ name: "primary_window", model_scope: null, used_pct: 12, resets_at: null, observed_at: 1, source: "usage_api" }]);

    const checked = await svc.checkSubscriptionAccountUsage(String(account.account_id));

    expect(checked).toMatchObject({ account_id: account.account_id, usage: { windows: [expect.objectContaining({ used_pct: 12 })] } });
    expect(JSON.stringify(checked)).not.toContain("access-new");
  });

  it("checks usage of every account", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    await login();
    adapter.exchangeCode.mockResolvedValueOnce(tokens({ providerAccountId: "acct-10" }));
    await login();

    const result = await svc.checkAllSubscriptionAccountUsage();

    expect(result).toMatchObject({ checked: 2, failed: 0 });
    // Each login checks usage once, then check-all checks both accounts again.
    expect(adapter.fetchUsage).toHaveBeenCalledTimes(4);
  });

  it("refreshes at once on a proxy 401 and returns the stored token to later callers", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    await login();
    const held = (await store.listSubscriptionAccounts())[0];
    adapter.refresh.mockResolvedValueOnce(tokens({ accessToken: "access-3", expiresAt: Date.now() + 9 * 24 * 3600 * 1000 }));

    const first = await svc.refreshSubscriptionAccount(held.account_id, held.token_expires_at);
    const second = await svc.refreshSubscriptionAccount(held.account_id, held.token_expires_at);

    expect(first.access_token).toBe("access-3");
    expect(second.access_token).toBe("access-3");
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
  });

  it("fails the proxy refresh when the provider refuses the refresh token", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    await login();
    const held = (await store.listSubscriptionAccounts())[0];
    adapter.refresh.mockRejectedValueOnce(new SubscriptionProviderError("refresh_token_reused", true, 401));

    await expect(svc.refreshSubscriptionAccount(held.account_id, held.token_expires_at)).rejects.toMatchObject({ code: "token_refresh_failed" });
    expect((await store.getSubscriptionAccount(held.account_id))?.status).toBe("auth_error");
    expect(changes.at(-1)?.account?.status).toBe("auth_error");
  });

  it("tells the scheduler about reports, updates and deletes", async () => {
    await svc.enableSubscriptionPool("codex", AGENTS);
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    changes = [];

    await svc.reportSubscriptionAccount(id, { status_code: 429 });
    await svc.updateSubscriptionAccount(id, { enabled: false });
    await svc.deleteSubscriptionAccount(id);

    expect(changes.map((change) => change.account?.status ?? null)).toEqual(["exhausted", "exhausted", null]);
    expect(changes[1].account?.enabled).toBe(false);
    expect(changes[2].accountId).toBe(id);
  });
});

describe("subscription pool routes", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
  });

  afterEach(async () => {
    await store.close();
  });

  async function post(userKey: string, body: unknown): Promise<{ status: number; body: { code: number; message: string } }> {
    let status = 0;
    let parsed: { code: number; message: string } = { code: 0, message: "" };
    const handled = await handleV3MetaRoute(
      { headers: { "x-tdai-service-id": "default", "x-tdai-user-key": userKey } } as http.IncomingMessage,
      {} as http.ServerResponse,
      "/v3/meta/subscription-pool/status",
      "POST",
      async () => body,
      (_res, code, payload) => {
        status = code;
        parsed = payload as { code: number; message: string };
      },
      {
        getMetadataService: () => svc,
        logger: {},
        getSupportedAgents: () => AGENTS,
      },
    );
    expect(handled).toBe(true);
    return { status, body: parsed };
  }

  it("rejects a member and accepts a system admin", async () => {
    store.createUser({ username: "member", auth_provider: "local", external_id: "member", default_key_value: "member-key", user_type: "normal" });
    store.createUser({ username: "admin", auth_provider: "local", external_id: "admin", default_key_value: "admin-key", user_type: "system_admin" });

    const denied = await post("member-key", {});
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("permission_denied");

    const allowed = await post("admin-key", {});
    expect(allowed.status).toBe(200);
    expect(allowed.body.code).toBe(0);
    expect(JSON.stringify(allowed.body)).not.toContain("access_token");
  });

});

describe("subscription pool writes that race", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;
  let adapter: ReturnType<typeof fakeAdapter>;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "default");
    adapter = fakeAdapter({ exchangeCode: async () => tokens({ providerAccountId: "acct-9", accessToken: "A-login", refreshToken: "R-login" }) });
    svc.setSubscriptionPoolHooks({ adapterFor: () => adapter });
    await svc.enableSubscriptionPool("codex", AGENTS);
  });

  afterEach(async () => {
    await store.close();
  });

  async function login() {
    const started = svc.startSubscriptionOAuth("codex");
    return svc.completeSubscriptionOAuth({ provider: "codex", state: started.state, code: "c" });
  }

  it("keeps a re-login that lands while a refresh is running", async () => {
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    let finishRefresh!: () => void;
    adapter.refresh.mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = () => resolve(tokens({ accessToken: "A-old-family", refreshToken: "R-old-family" }));
    }));
    adapter.exchangeCode.mockResolvedValueOnce(tokens({ providerAccountId: "acct-9", accessToken: "A-relogin", refreshToken: "R-relogin" }));

    const refreshing = svc.runSubscriptionTokenRefresh(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const relogin = login();
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishRefresh();
    await Promise.all([refreshing, relogin]);

    expect(await store.getSubscriptionAccount(id)).toMatchObject({ access_token: "A-relogin", refresh_token: "R-relogin" });
  });

  it("does not undo a Panel change with a quota report", async () => {
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    await svc.updateSubscriptionAccount(id, { status: "disabled" });
    await svc.reportSubscriptionAccount(id, { active_sessions: 1 });
    expect((await store.getSubscriptionAccount(id))?.status).toBe("disabled");
  });

  it("rejects a malformed redirect url as a bad code", async () => {
    const started = svc.startSubscriptionOAuth("codex");
    await expect(svc.completeSubscriptionOAuth({ provider: "codex", state: started.state, redirect_url: "http://[broken" }))
      .rejects.toMatchObject({ code: "INVALID_OAUTH_CODE" });
  });

  it("checks only accounts that can serve", async () => {
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    await store.updateSubscriptionAccount(id, { status: "auth_error", last_error: "re-login needed" });
    expect(await svc.checkAllSubscriptionAccountUsage()).toEqual({ checked: 0, failed: 0 });
    expect((await store.getSubscriptionAccount(id))?.last_error).toBe("re-login needed");
  });

  it("keeps the write when the scheduler hook throws", async () => {
    svc.setSubscriptionPoolHooks({ onAccountChanged: () => { throw new Error("hook"); } });
    await login();
    const id = (await store.listSubscriptionAccounts())[0].account_id;
    await expect(svc.reportSubscriptionAccount(id, { status_code: 429 })).resolves.toMatchObject({ status: "exhausted" });
  });
});
