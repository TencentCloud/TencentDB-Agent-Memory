import { describe, expect, it, vi } from "vitest";
import { CodexMemoryAdapter, GatewayHttpError } from "./gateway-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CodexMemoryAdapter", () => {
  it("sends recall requests with session key and bearer auth", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ context: "remembered", memory_count: 1 }));
    const adapter = new CodexMemoryAdapter({
      gatewayUrl: "http://localhost:8420/",
      apiKey: " secret ",
      sessionKey: "codex-session",
      userId: "user-1",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    const result = await adapter.recall("what should I know?");

    expect(result.context).toBe("remembered");
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:8420/recall", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        query: "what should I know?",
        session_key: "codex-session",
        user_id: "user-1",
      }),
    }));
  });

  it("captures a completed turn with optional raw messages", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ l0_recorded: 2, scheduler_notified: true }));
    const adapter = new CodexMemoryAdapter({
      sessionKey: "codex-session",
      sessionId: "turn-stream",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    const result = await adapter.captureTurn({
      userText: "hello",
      assistantText: "hi",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    });

    expect(result.l0_recorded).toBe(2);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      user_content: "hello",
      assistant_content: "hi",
      session_key: "codex-session",
      session_id: "turn-stream",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    });
  });

  it("throws GatewayHttpError with status and body on non-2xx responses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Unauthorized" }, 401));
    const adapter = new CodexMemoryAdapter({
      sessionKey: "codex-session",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.searchMemories({ query: "x" })).rejects.toMatchObject({
      name: "GatewayHttpError",
      status: 401,
      responseBody: JSON.stringify({ error: "Unauthorized" }),
    } satisfies Partial<GatewayHttpError>);
  });
});
