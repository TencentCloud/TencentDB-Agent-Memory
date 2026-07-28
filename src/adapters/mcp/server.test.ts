import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayMemoryClient } from "../gateway-client/index.js";
import {
  createMemoryMcpServer,
  deriveCodexSessionKey,
  gatewayClientOptionsFromEnv,
} from "./server.js";

const closeCallbacks: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectTestClient(gateway: GatewayMemoryClient) {
  const server = createMemoryMcpServer(gateway, { sessionKey: "codex:default" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  closeCallbacks.push(() => client.close(), () => server.close());
  return client;
}

function mockGateway(): GatewayMemoryClient {
  return {
    recall: vi.fn(async () => ({ context: "remember this", memory_count: 1 })),
    capture: vi.fn(async () => ({ l0_recorded: 2, scheduler_notified: true })),
    searchMemories: vi.fn(async () => ({ results: "memory", total: 1, strategy: "fts" })),
    searchConversations: vi.fn(async () => ({ results: "conversation", total: 1 })),
    endSession: vi.fn(async () => ({ flushed: true })),
  } as unknown as GatewayMemoryClient;
}

function textJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0].text ?? "");
}

describe("memory-tencentdb MCP server", () => {
  it("publishes five strictly described tools with read/write annotations", async () => {
    const client = await connectTestClient(mockGateway());
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "memory_recall",
      "memory_search",
      "conversation_search",
      "memory_capture",
      "memory_session_end",
    ]);
    expect(result.tools.find((tool) => tool.name === "memory_recall")?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(result.tools.find((tool) => tool.name === "memory_capture")?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(result.tools.find((tool) => tool.name === "memory_session_end")?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("routes all tools to the shared Gateway client", async () => {
    const gateway = mockGateway();
    const client = await connectTestClient(gateway);

    const recall = await client.callTool({
      name: "memory_recall",
      arguments: { query: "what matters?" },
    });
    expect(textJson(recall)).toEqual({ context: "remember this", memory_count: 1 });
    expect(gateway.recall).toHaveBeenCalledWith({
      query: "what matters?",
      sessionKey: "codex:default",
      userId: undefined,
    });

    await client.callTool({
      name: "memory_search",
      arguments: { query: "memory", limit: 3 },
    });
    expect(gateway.searchMemories).toHaveBeenCalledWith({
      query: "memory",
      limit: 3,
    });

    await client.callTool({
      name: "conversation_search",
      arguments: { query: "raw", session_key: "explicit" },
    });
    expect(gateway.searchConversations).toHaveBeenCalledWith({
      query: "raw",
      limit: undefined,
      sessionKey: "explicit",
    });

    await client.callTool({
      name: "memory_capture",
      arguments: {
        user_content: "hello",
        assistant_content: "world",
        session_id: "turn-1",
      },
    });
    expect(gateway.capture).toHaveBeenCalledWith(expect.objectContaining({
      userContent: "hello",
      assistantContent: "world",
      sessionKey: "codex:default",
      sessionId: "turn-1",
    }));
    const captureArg = vi.mocked(gateway.capture).mock.calls[0][0];
    expect(captureArg.messages).toHaveLength(2);
    expect(captureArg.messages?.[0].timestamp).toBeLessThanOrEqual(
      captureArg.messages?.[1].timestamp ?? 0,
    );

    await client.callTool({
      name: "memory_session_end",
      arguments: {},
    });
    expect(gateway.endSession).toHaveBeenCalledWith({
      sessionKey: "codex:default",
      userId: undefined,
    });
  });

  it("rejects extra or invalid tool arguments", async () => {
    const client = await connectTestClient(mockGateway());
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "q", unexpected: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/unexpected|unrecognized/i);
  });

  it("turns Gateway failures into MCP tool errors without throwing protocol errors", async () => {
    const gateway = mockGateway();
    vi.mocked(gateway.recall).mockRejectedValueOnce(new Error("gateway unavailable"));
    const client = await connectTestClient(gateway);
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "q" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("gateway unavailable");
  });
});

describe("Codex defaults", () => {
  it("derives a stable session key without exposing the workspace path", () => {
    const first = deriveCodexSessionKey("/private/work/acme", "");
    expect(first).toMatch(/^codex:[a-f0-9]{12}$/);
    expect(first).toBe(deriveCodexSessionKey("/private/work/acme", ""));
    expect(first).not.toContain("/private/work/acme");
    expect(deriveCodexSessionKey("/private/work/acme", " explicit ")).toBe("explicit");
  });

  it("maps documented environment variables to client options", () => {
    expect(gatewayClientOptionsFromEnv({
      TDAI_GATEWAY_URL: " https://memory.example.com/root ",
      TDAI_GATEWAY_API_KEY: "secret",
      TDAI_GATEWAY_TIMEOUT_MS: "2500",
      TDAI_GATEWAY_ALLOW_REMOTE: "true",
    })).toEqual({
      baseUrl: "https://memory.example.com/root",
      apiKey: "secret",
      timeoutMs: 2500,
      allowRemote: true,
    });
  });
});
