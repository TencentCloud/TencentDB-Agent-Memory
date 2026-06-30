import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gatewayGet,
  gatewayPost,
  resolveGatewayApiKey,
  resolveGatewayBaseUrl,
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

    await expect(gatewayPost("/recall", { query: "" }, {
      baseUrl: "http://127.0.0.1:8420",
    })).rejects.toThrow("bad query");
  });
});
