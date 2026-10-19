/**
 * Requests that do not belong to a subscription pool group must reach the upstream with the
 * same URL, headers and body as before the pool existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../account-cache.js";
import { CORE_URL, installFetch, jsonResponse, makeApp, makeConfig } from "./test-harness.js";
import type { PoolAccount } from "../types.js";

const SPACE = "sp-off";

function row(partial: Partial<InstanceUpstreamRow>): InstanceUpstreamRow {
  return {
    group_id: "g1", group_type: "default", name: "n", agents: ["codex", "claude-code"], enabled: true,
    mode: "official", base_url: "", api_key: "", model_id: "", ...partial,
  };
}

const compactBody = JSON.stringify({ model: "gpt-5", input: [{ type: "message", role: "user", content: [] }] });

describe("pool off keeps the upstream request unchanged", () => {
  beforeEach(() => clearCache());
  afterEach(() => vi.unstubAllGlobals());

  it("official default group: global upstream URL and client authorization pass through", async () => {
    __primeCacheForTests(SPACE, [row({})]);
    const config = makeConfig();
    const { upstreamCalls } = installFetch(() => jsonResponse({ ok: true }));
    const res = await makeApp(config).request(`/codex/${SPACE}/v1/responses/compact`, {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json", "chatgpt-account-id": "client-acct", "x-custom": "1" },
      body: compactBody,
    });
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/responses/compact");
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer client-key");
    expect(upstreamCalls[0]!.headers["chatgpt-account-id"]).toBe("client-acct");
    expect(upstreamCalls[0]!.headers["x-custom"]).toBe("1");
    expect(JSON.parse(upstreamCalls[0]!.body)).toEqual(JSON.parse(compactBody));
  });

  it("zero rows from Core: same as official", async () => {
    __primeCacheForTests(SPACE, []);
    const config = makeConfig();
    config.upstream.apiKey = "global-key";
    const { upstreamCalls } = installFetch(() => jsonResponse({ ok: true }));
    await makeApp(config).request(`/codex/${SPACE}/v1/responses/compact`, {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json" },
      body: compactBody,
    });
    expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/responses/compact");
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer global-key");
  });

  it("custom_unified group: base URL and group key replace the client authorization", async () => {
    __primeCacheForTests(SPACE, [
      row({}),
      row({ group_id: "g2", group_type: "custom", agents: ["codex"], mode: "custom_unified", base_url: "http://custom.test/api", api_key: "group-key", model_id: "m-x" }),
    ]);
    const config = makeConfig();
    const { upstreamCalls } = installFetch(() => jsonResponse({ ok: true }));
    await makeApp(config).request(`/codex/${SPACE}/v1/responses/compact`, {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json" },
      body: compactBody,
    });
    expect(upstreamCalls[0]!.url).toBe("http://custom.test/api/responses/compact");
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer group-key");
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("m-x");
  });

  it("custom_passthrough group: client authorization is kept", async () => {
    __primeCacheForTests(SPACE, [
      row({}),
      row({ group_id: "g2", group_type: "custom", agents: ["codex"], mode: "custom_passthrough", base_url: "http://custom.test/api" }),
    ]);
    const config = makeConfig();
    const { upstreamCalls } = installFetch(() => jsonResponse({ ok: true }));
    await makeApp(config).request(`/codex/${SPACE}/v1/responses/compact`, {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json" },
      body: compactBody,
    });
    expect(upstreamCalls[0]!.url).toBe("http://custom.test/api/responses/compact");
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer client-key");
  });

  it("x-tdai-user-key is stripped upstream and the client's own authorization is forwarded as sent", async () => {
    __primeCacheForTests(SPACE, [row({})]);
    const config = makeConfig();
    const { upstreamCalls } = installFetch(() => jsonResponse({ ok: true }));
    await makeApp(config).request(`/codex/${SPACE}/v1/responses/compact`, {
      method: "POST",
      headers: { "x-tdai-user-key": "sk-mem", authorization: "Bearer chatgpt-login", "content-type": "application/json" },
      body: compactBody,
    });
    expect(upstreamCalls[0]!.headers["x-tdai-user-key"]).toBeUndefined();
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer chatgpt-login");
  });

  it("claude count_tokens in a pool group uses the pool account bearer and the oauth beta", async () => {
    __primeCacheForTests(SPACE, [row({}), row({ group_id: "p", group_type: "custom", agents: ["claude-code"], mode: "subscription_pool" })]);
    const account: PoolAccount = {
      account_id: "a", group_id: "p", provider: "claude", provider_account_id: "acct-a",
      status: "active", enabled: true, access_token: "secret-token-a", token_expires_at: Date.now() + 3_600_000,
      usage: { windows: [] }, exhausted_until: null,
    };
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [account] });
    const config = makeConfig();
    const { upstreamCalls } = installFetch(() => jsonResponse({ data: [] }));
    await makeApp(config).request(`/claude-code/${SPACE}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-tdai-user-key": "sk-mem", "x-api-key": "client-key", "anthropic-beta": "prompt-caching-2024-07-31", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", messages: [] }),
    });
    expect(upstreamCalls[0]!.url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-a");
    expect(upstreamCalls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(upstreamCalls[0]!.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31,oauth-2025-04-20");
    expect(JSON.stringify(upstreamCalls[0]!.headers)).not.toContain("sk-mem");
  });

  it("utility route: official group keeps the global upstream", async () => {
    __primeCacheForTests(SPACE, [row({})]);
    const config = makeConfig();
    const { upstreamCalls } = installFetch(() => jsonResponse({ data: [] }));
    const res = await makeApp(config).request(`/claude-code/${SPACE}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-api-key": "client-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(upstreamCalls[0]!.url).toBe("http://global-upstream.test/v1/messages/count_tokens");
    expect(upstreamCalls[0]!.headers["x-api-key"]).toBe("client-key");
  });

  it("Core is never asked for pool accounts when no pool group exists", async () => {
    __primeCacheForTests(SPACE, [row({})]);
    const config = makeConfig();
    const { coreCalls } = installFetch(() => jsonResponse({ ok: true }));
    await makeApp(config).request(`/codex/${SPACE}/v1/responses/compact`, {
      method: "POST",
      headers: { authorization: "Bearer client-key", "content-type": "application/json" },
      body: compactBody,
    });
    expect(coreCalls.filter((c) => c.url.startsWith(`${CORE_URL}/v3/internal/meta/subscription-pool`))).toHaveLength(0);
  });
});
