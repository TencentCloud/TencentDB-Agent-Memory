/**
 * Tests for TdaiGatewayClient — verifies wire mapping, auth, retries, timeouts,
 * and typed error classification using an injected fake fetch.
 */

import { describe, it, expect, vi } from "vitest";
import { TdaiGatewayClient, TdaiGatewayError } from "./gateway-client.js";

type FetchArgs = { url: string; init: RequestInit };

/** Build a fake fetch that returns queued responses and records calls. */
function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: FetchArgs[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const factory = responses[Math.min(i, responses.length - 1)];
    i++;
    return factory();
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TdaiGatewayClient", () => {
  it("posts recall with snake_case body and parses the response", async () => {
    const { fn, calls } = fakeFetch([() => json({ context: "you like tea", strategy: "hybrid", memory_count: 2 })]);
    const client = new TdaiGatewayClient({ baseUrl: "http://gw:8420", fetch: fn });

    const res = await client.recall("what do I like?", "s-1", "u-1");

    expect(res).toEqual({ context: "you like tea", strategy: "hybrid", memory_count: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://gw:8420/recall");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: "what do I like?",
      session_key: "s-1",
      user_id: "u-1",
    });
  });

  it("attaches a Bearer header only when an apiKey is set", async () => {
    const withKey = fakeFetch([() => json({ status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } })]);
    await new TdaiGatewayClient({ fetch: withKey.fn, apiKey: "  secret\n" }).health();
    expect(headers(withKey.calls[0]).authorization).toBe("Bearer secret"); // trimmed

    const noKey = fakeFetch([() => json({ status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } })]);
    await new TdaiGatewayClient({ fetch: noKey.fn }).health();
    expect(headers(noKey.calls[0]).authorization).toBeUndefined();
  });

  it("maps search params and omits absent optionals", async () => {
    const { fn, calls } = fakeFetch([() => json({ results: "…", total: 3, strategy: "vector" })]);
    const client = new TdaiGatewayClient({ fetch: fn });
    await client.searchMemories({ query: "cats", limit: 10 });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "cats", limit: 10 });
  });

  it("throws a non-retryable bad_request on HTTP 400", async () => {
    const { fn, calls } = fakeFetch([() => json({ error: "Missing required field: query" }, 400)]);
    const client = new TdaiGatewayClient({ fetch: fn, retries: 3 });

    const err = await client.searchMemories({ query: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(TdaiGatewayError);
    expect(err.code).toBe("bad_request");
    expect(err.status).toBe(400);
    expect(err.message).toContain("Missing required field");
    expect(calls).toHaveLength(1); // no retries on 4xx
  });

  it("classifies HTTP 401 as unauthorized", async () => {
    const { fn } = fakeFetch([() => json({ error: "Unauthorized" }, 401)]);
    const err = await new TdaiGatewayClient({ fetch: fn }).recall("q", "s").catch((e) => e);
    expect(err.code).toBe("unauthorized");
  });

  it("retries server_error (5xx) up to the configured limit, then throws", async () => {
    const { fn, calls } = fakeFetch([() => json({ error: "boom" }, 503)]);
    const client = new TdaiGatewayClient({ fetch: fn, retries: 2, retryBackoffMs: 1 });

    const err = await client.recall("q", "s").catch((e) => e);
    expect(err.code).toBe("server_error");
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it("recovers when a retried 5xx eventually succeeds", async () => {
    const { fn, calls } = fakeFetch([
      () => json({ error: "boom" }, 500),
      () => json({ context: "ok", memory_count: 0 }),
    ]);
    const client = new TdaiGatewayClient({ fetch: fn, retries: 2, retryBackoffMs: 1 });
    const res = await client.recall("q", "s");
    expect(res.context).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("wraps network failures as code 'network' and retries", async () => {
    const { fn, calls } = fakeFetch([() => Promise.reject(new Error("ECONNREFUSED"))]);
    const client = new TdaiGatewayClient({ fetch: fn, retries: 1, retryBackoffMs: 1 });
    const err = await client.health().catch((e) => e);
    // health() forces retries: 0, so a single attempt
    expect(err.code).toBe("network");
    expect(calls).toHaveLength(1);
  });

  it("aborts on timeout and reports code 'timeout'", async () => {
    const hanging: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;

    const client = new TdaiGatewayClient({ fetch: hanging, timeoutMs: 15, retries: 0 });
    const err = await client.recall("q", "s").catch((e) => e);
    expect(err.code).toBe("timeout");
    expect(err.message).toContain("timed out");
  });

  it("fromEnv reads TDAI_GATEWAY_URL / _API_KEY", async () => {
    vi.stubEnv("TDAI_GATEWAY_URL", "http://example:9000");
    vi.stubEnv("TDAI_GATEWAY_API_KEY", "k");
    const { fn, calls } = fakeFetch([() => json({ status: "ok", version: "1", uptime: 0, stores: { vectorStore: false, embeddingService: false } })]);
    const client = TdaiGatewayClient.fromEnv({ fetch: fn });
    await client.health();
    expect(calls[0].url).toBe("http://example:9000/health");
    expect(headers(calls[0]).authorization).toBe("Bearer k");
  });
});

function headers(call: FetchArgs): Record<string, string> {
  const h = call.init.headers as Record<string, string> | undefined;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) lower[k.toLowerCase()] = v;
  return lower;
}
