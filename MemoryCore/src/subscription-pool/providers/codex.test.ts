import { describe, expect, it } from "vitest";
import { createCodexAdapter, parseCodexUsage } from "./codex.js";
import { SubscriptionProviderError, type SubscriptionFetch } from "./types.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

const ID_TOKEN = fakeJwt({
  email: "pool-1@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "pro" },
});

interface Captured { url: string; init?: RequestInit }

function fetchReturning(status: number, body: unknown, calls: Captured[] = []): SubscriptionFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

describe("parseCodexUsage", () => {
  it("reads both windows and named extra limits from the usage payload", () => {
    const now = 1_800_000_000_000;
    const windows = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 600, reset_at: 1_800_000_600 },
        secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: null },
      },
      additional_rate_limits: [{ limit_name: "bengalfox", model: "gpt-5-codex", primary_window: { used_percent: 90, reset_at: 1_800_001_000 } }],
    }, now);

    expect(windows).toEqual([
      { name: "primary_window", model_scope: null, used_pct: 42, resets_at: 1_800_000_600_000, observed_at: now, source: "usage_api" },
      { name: "secondary_window", model_scope: null, used_pct: 7, resets_at: now + 3_600_000, observed_at: now, source: "usage_api" },
      { name: "bengalfox", model_scope: "gpt-5-codex", used_pct: 90, resets_at: 1_800_001_000_000, observed_at: now, source: "usage_api" },
    ]);
  });

  it("skips null windows", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } })).toEqual([]);
  });
});

describe("codex adapter", () => {
  it("exchanges a code with a form body and reads the account id from the id token", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, {
      id_token: ID_TOKEN,
      access_token: fakeJwt({ exp: 1_900_000_000 }),
      refresh_token: "refresh-1",
    }, calls));

    const tokens = await adapter.exchangeCode({ code: "code-1", codeVerifier: "verifier-1", redirectUri: "", state: "s" });

    expect(calls[0].url).toBe("https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(tokens.providerAccountId).toBe("acct-123");
    expect(tokens.accountLabel).toBe("pool-1@example.com pro");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(tokens.expiresAt).toBe(1_900_000_000_000);
  });

  it("takes the expiry from the access token when the refresh response has no expires_in", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, { access_token: fakeJwt({ exp: 1_900_000_100 }) }, calls));

    const tokens = await adapter.refresh("refresh-old");

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-old" });
    expect(body.scope).toBeUndefined();
    expect(tokens.expiresAt).toBe(1_900_000_100_000);
    expect(tokens.refreshToken).toBe("");
  });

  it.each(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"])(
    "treats %s as a permanent refresh failure",
    async (code) => {
      const adapter = createCodexAdapter(fetchReturning(403, { error: { code, message: "no" } }));
      const error = await adapter.refresh("r").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubscriptionProviderError);
      expect((error as SubscriptionProviderError).permanent).toBe(true);
    },
  );

  it("treats a 5xx refresh failure as transient", async () => {
    const adapter = createCodexAdapter(fetchReturning(502, { error: "bad gateway" }));
    const error = await adapter.refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(error.permanent).toBe(false);
  });

  it("calls the usage endpoint with the bearer token and account header", async () => {
    const calls: Captured[] = [];
    const adapter = createCodexAdapter(fetchReturning(200, { rate_limit: { primary_window: { used_percent: 5, reset_at: 1_800_000_000 } } }, calls));

    const windows = await adapter.fetchUsage("access-1", "acct-123");

    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    expect(windows).toHaveLength(1);
  });

  it("does not put a token into a provider error message", async () => {
    const adapter = createCodexAdapter(fetchReturning(401, { error: { message: "token expired" } }));
    const error = await adapter.fetchUsage("access-secret", "acct").catch((e: unknown) => e) as Error;
    expect(error.message).not.toContain("access-secret");
  });

  it("treats a 400 without a known error code as transient", async () => {
    const adapter = createCodexAdapter(fetchReturning(400, { error: { message: "malformed" } }));
    const error = await adapter.refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect(error.permanent).toBe(false);
  });

  it("treats invalid_grant and a 401 as permanent", async () => {
    const grant = await createCodexAdapter(fetchReturning(400, { error: "invalid_grant" })).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    const unauthorized = await createCodexAdapter(fetchReturning(401, {})).refresh("r").catch((e: unknown) => e) as SubscriptionProviderError;
    expect([grant.permanent, unauthorized.permanent]).toEqual([true, true]);
  });

  it("skips extra limit rows without a usage percent and reads nested rate limits", () => {
    const windows = parseCodexUsage({
      additional_rate_limits: [
        { limit_name: "unknown-shape", metered_feature: "x" },
        { limit_name: "nested", rate_limit: { primary_window: { used_percent: 55, reset_at: 1_800_000_000 } } },
      ],
    }, 1);
    expect(windows).toEqual([expect.objectContaining({ name: "nested", used_pct: 55 })]);
  });
});
