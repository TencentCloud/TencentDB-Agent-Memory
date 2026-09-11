import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayClientError,
  gatewayGet,
  gatewayPost,
  resolveGatewayApiKey,
  resolveGatewayBaseUrl,
  resolveGatewayTimeoutMs,
} from "./gateway-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("gateway client helpers", () => {
  it("resolves gateway URL and API key from environment", () => {
    vi.stubEnv("MEMORY_TENCENTDB_GATEWAY_URL", "http://127.0.0.1:9527///");
    vi.stubEnv("MEMORY_TENCENTDB_GATEWAY_API_KEY", " token-a ");

    expect(resolveGatewayBaseUrl()).toBe("http://127.0.0.1:9527");
    expect(resolveGatewayApiKey()).toBe("token-a");
  });

  it("falls back to host and port environment variables", () => {
    vi.stubEnv("MEMORY_TENCENTDB_GATEWAY_HOST", "localhost");
    vi.stubEnv("MEMORY_TENCENTDB_GATEWAY_PORT", "18420");
    vi.stubEnv("TDAI_GATEWAY_API_KEY", "token-b");

    expect(resolveGatewayBaseUrl()).toBe("http://localhost:18420");
    expect(resolveGatewayApiKey()).toBe("token-b");
  });

  it("uses a bounded default when the timeout environment value is invalid", () => {
    expect(resolveGatewayTimeoutMs("2500")).toBe(2500);
    expect(resolveGatewayTimeoutMs("0")).toBe(10_000);
    expect(resolveGatewayTimeoutMs("not-a-number")).toBe(10_000);
  });

  it("sends POST JSON with bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ ok: true });
    }) as typeof fetch);

    const result = await gatewayPost(
      "/search/memories",
      { query: "adapter proof", limit: 3 },
      { baseUrl: "http://127.0.0.1:8420/", apiKey: "secret" },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8420/search/memories");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: "adapter proof",
      limit: 3,
    });
  });

  it("sends GET requests with bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ status: "ok" });
    }) as typeof fetch);

    await expect(gatewayGet("/health", {
      baseUrl: "http://127.0.0.1:8420",
      apiKey: "secret",
    })).resolves.toEqual({ status: "ok" });

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:8420/health",
      init: { headers: { Authorization: "Bearer secret" } },
    });
  });

  it("surfaces gateway JSON error messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "bad query" }, { status: 400 }),
    );

    const request = gatewayPost("/recall", { query: "" }, {
      baseUrl: "http://127.0.0.1:8420",
    });

    await expect(request).rejects.toMatchObject({
      name: "GatewayClientError",
      code: "HTTP_ERROR",
      path: "/recall",
      status: 400,
    });
    await expect(request).rejects.toThrow("bad query");
  });

  it("reports malformed success responses as a typed client error", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));

    const request = gatewayGet("/health", {
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl,
    });

    await expect(request).rejects.toEqual(expect.objectContaining({
      name: "GatewayClientError",
      code: "INVALID_JSON",
      status: 200,
      responseBody: "not-json",
    }));
  });

  it("preserves non-JSON error context without leaking an unbounded body", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream unavailable", { status: 502 }));

    await expect(gatewayGet("/health", {
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl,
    })).rejects.toEqual(expect.objectContaining({
      name: "GatewayClientError",
      code: "HTTP_ERROR",
      status: 502,
      responseBody: "upstream unavailable",
    }));
  });

  it("aborts requests that exceed the configured timeout", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    await expect(gatewayGet("/health", {
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl,
      timeoutMs: 5,
    })).rejects.toEqual(expect.objectContaining({
      name: "GatewayClientError",
      code: "TIMEOUT",
      path: "/health",
    }));
  });

  it("distinguishes network failures from Gateway responses", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection refused");
    });

    const request = gatewayGet("/health", {
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl,
    });

    await expect(request).rejects.toBeInstanceOf(GatewayClientError);
    await expect(request).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});
