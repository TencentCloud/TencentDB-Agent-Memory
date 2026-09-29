import { describe, expect, it, vi } from "vitest";
import { GatewayClient, GatewayClientError } from "../src/gateway-client.js";

describe("GatewayClient", () => {
  it("adds Bearer auth and serializes Gateway requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ context: "memory" }), { status: 200 }));
    const client = new GatewayClient({ baseUrl: "http://gateway/", timeoutMs: 100, apiKey: " secret ", fetchImpl });
    await expect(client.recall({ query: "q", session_key: "s" })).resolves.toEqual({ context: "memory" });
    expect(fetchImpl).toHaveBeenCalledWith("http://gateway/recall", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret", "Content-Type": "application/json" }),
    }));
  });

  it("reports bounded HTTP failures without secrets", async () => {
    const client = new GatewayClient({
      baseUrl: "http://gateway",
      timeoutMs: 100,
      fetchImpl: vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    });
    await expect(client.health()).rejects.toBeInstanceOf(GatewayClientError);
  });
});
