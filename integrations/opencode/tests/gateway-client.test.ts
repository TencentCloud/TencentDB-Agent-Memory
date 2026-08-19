import { describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/gateway-client.js";

describe("GatewayClient", () => {
  it("routes JSON requests with optional Bearer auth", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ context: "memory" }), {
          status: 200,
        }),
    );
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8420/",
      timeoutMs: 1_000,
      apiKey: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.recall({ query: "q", session_key: "s" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8420/recall",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: JSON.stringify({ query: "q", session_key: "s" }),
      }),
    );
  });

  it("returns bounded HTTP errors", async () => {
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8420",
      timeoutMs: 1_000,
      fetchImpl: vi.fn(
        async () => new Response("x".repeat(1_000), { status: 500 }),
      ) as typeof fetch,
    });
    await expect(client.health()).rejects.toMatchObject({
      route: "/health",
      status: 500,
    });
    await expect(client.health()).rejects.not.toThrow("x".repeat(600));
  });

  it("rejects malformed JSON", async () => {
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8420",
      timeoutMs: 1_000,
      fetchImpl: vi.fn(
        async () => new Response("not-json", { status: 200 }),
      ) as typeof fetch,
    });
    await expect(client.health()).rejects.toThrow("invalid JSON");
  });

  it("rejects a valid JSON value with the wrong Gateway shape", async () => {
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8420",
      timeoutMs: 1_000,
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
          }),
      ) as typeof fetch,
    });
    await expect(client.health()).rejects.toThrow("invalid response shape");
  });
});
