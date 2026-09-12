import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeGatewayClient } from "./gateway-client.js";

describe("ClaudeCodeGatewayClient", () => {
  it("maps capture to the Gateway contract with auth and stable timestamps", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new ClaudeCodeGatewayClient({
      baseUrl: "http://localhost:8420",
      apiKey: "secret-token",
      fetchImpl,
    });

    await client.capture({
      userText: "hello",
      assistantText: "hi",
      userTimestamp: 100,
      assistantTimestamp: 200,
      sessionKey: "claude-code:workspace:session",
      sessionId: "session",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8420/capture");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      user_content: "hello",
      assistant_content: "hi",
      session_key: "claude-code:workspace:session",
      session_id: "session",
      messages: [
        { role: "user", timestamp: 100 },
        { role: "assistant", timestamp: 200 },
      ],
    });
  });

  it("rejects remote hosts unless explicitly enabled", () => {
    expect(() => new ClaudeCodeGatewayClient({
      baseUrl: "https://memory.example.com",
    })).toThrow(/Remote Gateway URLs are disabled/);

    expect(() => new ClaudeCodeGatewayClient({
      baseUrl: "https://memory.example.com",
      allowRemoteGateway: true,
    })).not.toThrow();
  });

  it("reports non-success Gateway responses", async () => {
    const client = new ClaudeCodeGatewayClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      ),
    });

    await expect(client.recall("query", "session")).rejects.toThrow(
      /\/recall returned HTTP 401/,
    );
  });
});
