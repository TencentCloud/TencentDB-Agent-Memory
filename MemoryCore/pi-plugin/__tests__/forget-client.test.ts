import { describe, expect, it, vi } from "vitest";
import { ProxyForgetClient } from "../forget-client.js";

describe("ProxyForgetClient", () => {
  it("sends only routing identity and the search keyword", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { state: "select", candidates: [] },
    })));
    const client = new ProxyForgetClient({
      proxyBase: "http://proxy.test/",
      spaceId: "space-a",
      userKey: "user-key",
      conversationId: "pi-session-a",
      fetcher,
    });

    await client.preview("deploy");

    expect(fetcher).toHaveBeenCalledWith(
      "http://proxy.test/v3/pi/memory-forget/preview",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer user-key",
          "Content-Type": "application/json",
          "x-tdai-service-id": "space-a",
          "x-conversation-id": "pi-session-a",
        },
        body: JSON.stringify({ keyword: "deploy" }),
      }),
    );
  });

  it("does not leak a server response body through errors", async () => {
    const fetcher = vi.fn(async () => new Response("secret server details", { status: 500 }));
    const client = new ProxyForgetClient({
      proxyBase: "http://proxy.test",
      spaceId: "space-a",
      userKey: "user-key",
      conversationId: "pi-session-a",
      fetcher,
    });

    await expect(client.confirm("action-a")).rejects.toThrow(
      "memory deletion could not be confirmed; run a fresh preview",
    );
    await expect(client.confirm("action-a")).rejects.not.toThrow("secret server details");
  });
});
