import { describe, expect, it } from "vitest";
import { createClaudeAdapter, parseClaudeUsage } from "./claude.js";
import { SubscriptionProviderError, type SubscriptionFetch } from "./types.js";

interface Captured { url: string; init?: RequestInit }

function fetchReturning(status: number, body: unknown, calls: Captured[] = []): SubscriptionFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

function fetchByUrl(handlers: Record<string, { status: number; body: unknown }>, calls: Captured[] = []): SubscriptionFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const match = handlers[url];
    if (!match) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify(match.body), { status: match.status, headers: { "content-type": "application/json" } });
  };
}

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

describe("parseClaudeUsage", () => {
  const now = 1_800_000_000_000;

  it("reads the flat windows and skips ones the payload omits", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 42, resets_at: "2027-01-15T00:10:00.000Z" },
      seven_day: { utilization: 7, resets_at: null },
      seven_day_opus: { utilization: 90, resets_at: 1_800_001_000 },
    }, now);
    expect(windows).toEqual([
      { name: "five_hour", model_scope: null, used_pct: 42, resets_at: Date.parse("2027-01-15T00:10:00.000Z"), observed_at: now, source: "usage_api" },
      { name: "seven_day", model_scope: null, used_pct: 7, resets_at: null, observed_at: now, source: "usage_api" },
      { name: "seven_day_opus", model_scope: null, used_pct: 90, resets_at: 1_800_001_000_000, observed_at: now, source: "usage_api" },
    ]);
  });

  it("prefers limits[] and maps session and weekly windows onto the meter names", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 1, resets_at: null },
      limits: [
        { kind: "session", percent: 12, resets_at: "2027-01-15T01:00:00.000Z", is_active: true },
        { kind: "weekly_all", percent: 3, resets_at: null, is_active: true },
        { kind: "weekly_scoped", percent: 80, resets_at: 1_800_002_000, is_active: true, scope: { model: { id: "claude-opus-4-6", display_name: "Opus" } } },
        { kind: "weekly_scoped", percent: 99, is_active: false, scope: { model: { id: "claude-sonnet" } } },
        { kind: "weekly_scoped", group: "no-percent" },
      ],
    }, now);
    expect(windows).toEqual([
      { name: "five_hour", model_scope: null, used_pct: 12, resets_at: Date.parse("2027-01-15T01:00:00.000Z"), observed_at: now, source: "usage_api" },
      { name: "seven_day", model_scope: null, used_pct: 3, resets_at: null, observed_at: now, source: "usage_api" },
      { name: "weekly_scoped", model_scope: "claude-opus-4-6", used_pct: 80, resets_at: 1_800_002_000_000, observed_at: now, source: "usage_api" },
    ]);
  });

  it("returns nothing for an empty payload", () => {
    expect(parseClaudeUsage({})).toEqual([]);
    expect(parseClaudeUsage(null)).toEqual([]);
  });
});

describe("claude adapter", () => {
  it("exchanges a code as JSON and reads the account from the token response", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchReturning(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 28800,
      account: { uuid: "acct-claude", email_address: "pool@example.com" },
      organization: { organization_type: "claude_pro" },
    }, calls));

    const tokens = await adapter.exchangeCode({
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "",
      state: "state-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKEN_URL);
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code_verifier: "verifier-1",
      state: "state-1",
    });
    expect((calls[0].init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      providerAccountId: "acct-claude",
      accountLabel: "pool@example.com claude_pro",
    });
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("loads the profile when the token response has no account id", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchByUrl({
      [TOKEN_URL]: { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 } },
      [PROFILE_URL]: {
        status: 200,
        body: { account: { uuid: "acct-from-profile", email: "from-profile@example.com" }, organization: { organization_type: "claude_max" } },
      },
    }, calls));

    const tokens = await adapter.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://platform.claude.com/oauth/code/callback", state: "s" });

    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, PROFILE_URL]);
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe("Bearer access-1");
    expect(tokens.providerAccountId).toBe("acct-from-profile");
    expect(tokens.accountLabel).toBe("from-profile@example.com claude_max");
  });

  it("rejects a login that never yields an account id", async () => {
    const adapter = createClaudeAdapter(fetchByUrl({
      [TOKEN_URL]: { status: 200, body: { access_token: "access-1" } },
      [PROFILE_URL]: { status: 200, body: { account: {} } },
    }));
    await expect(adapter.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://x", state: "s" }))
      .rejects.toThrow("claude token has no account id");
  });

  it("refreshes with JSON and keeps a rotated refresh token", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchReturning(200, {
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 28800,
    }, calls));

    const tokens = await adapter.refresh("refresh-old");

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("refresh-old");
    expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(body.scope).toContain("user:inference");
    expect(tokens.refreshToken).toBe("refresh-new");
    expect(tokens.accessToken).toBe("access-new");
    expect(tokens.providerAccountId).toBe("");
  });

  it("returns an empty refresh token when the provider omits one, so the stored token is kept", async () => {
    const adapter = createClaudeAdapter(fetchReturning(200, { access_token: "access-new", expires_in: 60 }));
    const tokens = await adapter.refresh("refresh-old");
    expect(tokens.refreshToken).toBe("");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it.each(["invalid_grant", "invalid_refresh_token"])("treats %s as a permanent refresh failure", async (code) => {
    const adapter = createClaudeAdapter(fetchReturning(400, { error: code }));
    const error = await adapter.refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(error).toBeInstanceOf(SubscriptionProviderError);
    expect(error.permanent).toBe(true);
  });

  it("treats a 400 without a known code and a 429 as transient", async () => {
    const malformed = await createClaudeAdapter(fetchReturning(400, { error: { message: "malformed" } })).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    const limited = await createClaudeAdapter(fetchReturning(429, { error: "rate_limited" })).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(malformed.permanent).toBe(false);
    expect(limited.permanent).toBe(false);
  });

  it("calls the usage endpoint with the bearer token and the oauth beta", async () => {
    const calls: Captured[] = [];
    const adapter = createClaudeAdapter(fetchReturning(200, { five_hour: { utilization: 5, resets_at: 1_800_000_000 } }, calls));

    const windows = await adapter.fetchUsage("access-1", "unused");

    expect(calls[0].url).toBe(USAGE_URL);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.name).toBe("five_hour");
  });

  it("does not put a token into a provider error message", async () => {
    const adapter = createClaudeAdapter(fetchReturning(401, { error: { message: "token expired" } }));
    const error = await adapter.fetchUsage("access-secret", "acct").catch((e: unknown) => e) as Error;
    expect(error.message).not.toContain("access-secret");
    expect(error).toBeInstanceOf(SubscriptionProviderError);
    expect((error as SubscriptionProviderError).permanent).toBe(true);
  });
});
