import { describe, expect, it, vi } from "vitest";

import { GatewayRequestError, TdaiGatewayClient } from "./gateway-client.js";

describe("TdaiGatewayClient", () => {
  it("sends authenticated JSON requests to the configured base path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ total: 1, results: "match", strategy: "hybrid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new TdaiGatewayClient({
      baseUrl: "https://memory.example.test/api/",
      apiKey: "secret",
      fetchImpl,
    });

    await expect(client.searchMemories({ query: "project", limit: 3 })).resolves.toMatchObject({
      total: 1,
      results: "match",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://memory.example.test/api/search/memories");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer secret" }),
      body: JSON.stringify({ query: "project", limit: 3 }),
    });
  });

  it("surfaces structured HTTP errors without exposing credentials", async () => {
    const client = new TdaiGatewayClient({
      baseUrl: "http://127.0.0.1:8787",
      apiKey: "do-not-leak",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid session", code: "BAD_SESSION" }), {
          status: 400,
        }),
      ),
    });

    const error = await client.recall({ query: "q", session_key: "s" }).catch((value) => value);
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error).toMatchObject({ status: 400, code: "BAD_SESSION", message: "invalid session" });
    expect(String(error)).not.toContain("do-not-leak");
  });

  it("rejects unsupported gateway URL schemes", () => {
    expect(() => new TdaiGatewayClient({ baseUrl: "file:///tmp/gateway" })).toThrow(
      "must use http or https",
    );
  });

  it("rejects malformed gateway URLs", () => {
    expect(() => new TdaiGatewayClient({ baseUrl: "not a URL" })).toThrow(
      "Invalid TDAI Gateway URL",
    );
  });

  it("reports invalid JSON responses as gateway errors", async () => {
    const client = new TdaiGatewayClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 502 })),
    });
    await expect(client.endSession({ session_key: "s" })).rejects.toThrow(
      "Gateway returned invalid JSON",
    );
  });

  it("uses every Gateway route without requiring an API key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () => new Response("{}", { status: 200 }),
    );
    const client = new TdaiGatewayClient({ baseUrl: "http://localhost:8787", fetchImpl });

    await client.recall({ query: "q", session_key: "s" });
    await client.capture({ user_content: "u", assistant_content: "a", session_key: "s" });
    await client.searchConversations({ query: "q" });
    await client.endSession({ session_key: "s" });

    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/recall",
      "/capture",
      "/search/conversations",
      "/session/end",
    ]);
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("maps network and timeout failures to stable client errors", async () => {
    const networkClient = new TdaiGatewayClient({
      baseUrl: "http://localhost:8787",
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused")),
    });
    await expect(networkClient.recall({ query: "q", session_key: "s" })).rejects.toThrow(
      "Gateway request failed: connection refused",
    );

    const timeoutClient = new TdaiGatewayClient({
      baseUrl: "http://localhost:8787",
      timeoutMs: 1,
      fetchImpl: vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
    });
    await expect(timeoutClient.recall({ query: "q", session_key: "s" })).rejects.toThrow(
      "timed out after 1ms",
    );
  });
});
