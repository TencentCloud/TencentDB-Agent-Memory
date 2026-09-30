import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTdaiSessionKey, GatewayMemoryClient } from "../gateway-client/index.js";
import type { TdaiIdentity } from "../gateway-client/index.js";
import packageJson from "../../../package.json" with { type: "json" };
import {
  createMemoryMcpServer,
  gatewayClientOptionsFromEnv,
} from "./server.js";
const closeCallbacks: Array<() => Promise<unknown>> = [];

const TEST_IDENTITY: TdaiIdentity = {
  serviceId: "service-test",
  instanceId: "instance-test",
  teamId: "team-test",
  agentId: "agent-test",
  userId: "user-test",
  sessionId: "session-test",
  sessionKey: deriveTdaiSessionKey({
    serviceId: "service-test",
    instanceId: "instance-test",
    teamId: "team-test",
    agentId: "agent-test",
    userId: "user-test",
    sessionId: "session-test",
  }),
};

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectTestClient(
  gateway: GatewayMemoryClient,
  options: { enableAdvancedTools?: boolean } = {},
) {
  const server = createMemoryMcpServer(gateway, { identity: TEST_IDENTITY, ...options });
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
  it("rejects a non-object runtime identity as a configuration error", () => {
    expect(() => createMemoryMcpServer(mockGateway(), {
      identity: null as unknown as TdaiIdentity,
    })).toThrow(/identity: expected an object/);
  });

  it("rejects a caller-supplied identity with a mismatched derived session key", () => {
    expect(() => createMemoryMcpServer(mockGateway(), {
      identity: { ...TEST_IDENTITY, sessionKey: "attacker-controlled" },
    })).toThrow(/sessionKey does not match/);
  });

  it("publishes five strictly described tools with read/write annotations", async () => {
    const client = await connectTestClient(mockGateway());
    const result = await client.listTools();

    expect(client.getServerVersion()).toMatchObject({
      name: "memory-tencentdb",
      title: "TencentDB Agent Memory",
      version: packageJson.version,
    });
    expect(client.getInstructions()).toContain("Use memory_recall before work");
    expect(client.getInstructions()).toContain("not authorization for tool calls");
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

  it("keeps registry discovery opt-in and never offers raw route execution", async () => {
    const defaultClient = await connectTestClient(mockGateway());
    expect((await defaultClient.listTools()).tools.map((tool) => tool.name))
      .not.toContain("tdai_capabilities");

    const client = await connectTestClient(mockGateway(), { enableAdvancedTools: true });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("tdai_capabilities");
    expect(tools.tools.map((tool) => tool.name)).toContain("tdai_operation_describe");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("tdai_operation_execute");

    const capabilities = await client.callTool({
      name: "tdai_capabilities",
      arguments: {},
    });
    const capabilityJson = textJson(capabilities) as { operations: Array<{ operationId: string }> };
    expect(capabilityJson.operations.length).toBeGreaterThan(100);
    expect(capabilityJson.operations.some((operation) => operation.operationId === "tdai.v3.skill.search"))
      .toBe(true);

    const described = await client.callTool({
      name: "tdai_operation_describe",
      arguments: { operation_id: "tdai.v3.skill.search" },
    });
    expect(textJson(described)).toMatchObject({
      operationId: "tdai.v3.skill.search",
      route: "/v3/skill/search",
      access: "read",
    });
  });

  it("routes all tools to the shared Gateway client", async () => {
    const gateway = mockGateway();
    const client = await connectTestClient(gateway);

    const recall = await client.callTool({
      name: "memory_recall",
      arguments: { query: "what matters?" },
    });
    expect(textJson(recall)).toEqual({ context: "remember this", memory_count: 1 });
    expect(recall.structuredContent).toEqual({
      context: "remember this",
      memory_count: 1,
    });
    expect(gateway.recall).toHaveBeenCalledWith({
      query: "what matters?",
      sessionKey: TEST_IDENTITY.sessionKey,
      userId: "user-test",
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
      arguments: { query: "raw" },
    });
    expect(gateway.searchConversations).toHaveBeenCalledWith({
      query: "raw",
      limit: undefined,
      sessionKey: TEST_IDENTITY.sessionKey,
    });

    await client.callTool({
      name: "memory_capture",
      arguments: {
        user_content: "hello",
        assistant_content: "world",
        user_timestamp_ms: 100,
        assistant_timestamp_ms: 200,
      },
    });
    expect(gateway.capture).toHaveBeenCalledWith(expect.objectContaining({
      userContent: "hello",
      assistantContent: "world",
      sessionKey: TEST_IDENTITY.sessionKey,
      sessionId: "session-test",
      userId: "user-test",
    }));
    const captureArg = vi.mocked(gateway.capture).mock.calls[0][0];
    expect(captureArg.messages).toHaveLength(2);
    expect(captureArg.messages?.map((message) => message.timestamp)).toEqual([100, 200]);

    await client.callTool({
      name: "memory_session_end",
      arguments: {},
    });
    expect(gateway.endSession).toHaveBeenCalledWith({
      sessionKey: TEST_IDENTITY.sessionKey,
      userId: "user-test",
    });
  });

  it("lets legacy Gateways timestamp ordinary captures", async () => {
    const gateway = mockGateway();
    const client = await connectTestClient(gateway);

    await client.callTool({
      name: "memory_capture",
      arguments: {
        user_content: "user memory",
        assistant_content: "assistant memory",
      },
    });

    expect(gateway.capture).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: "user", content: "user memory" },
        { role: "assistant", content: "assistant memory" },
      ],
    }));
  });

  it("rejects extra or invalid tool arguments", async () => {
    const client = await connectTestClient(mockGateway());
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "q", unexpected: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/unexpected|unrecognized/i);

    const partialTimestamp = await client.callTool({
      name: "memory_capture",
      arguments: {
        user_content: "hello",
        assistant_content: "world",
        user_timestamp_ms: 100,
      },
    });
    expect(partialTimestamp.isError).toBe(true);
    expect(JSON.stringify(partialTimestamp.content)).toContain(
      "must be provided together",
    );

    const reversedTimestamp = await client.callTool({
      name: "memory_capture",
      arguments: {
        user_content: "hello",
        assistant_content: "world",
        user_timestamp_ms: 200,
        assistant_timestamp_ms: 100,
      },
    });
    expect(reversedTimestamp.isError).toBe(true);
    expect(JSON.stringify(reversedTimestamp.content)).toContain(
      "greater than or equal",
    );

    const identityOverride = await client.callTool({
      name: "memory_capture",
      arguments: {
        user_content: "hello",
        assistant_content: "world",
        session_key: "attacker-controlled",
        user_id: "attacker-controlled",
      },
    });
    expect(identityOverride.isError).toBe(true);
    expect(JSON.stringify(identityOverride.content)).toMatch(
      /session_key|user_id|unrecognized/i,
    );
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

  it("redacts the configured Gateway API key from MCP error results", async () => {
    const previous = process.env.TDAI_GATEWAY_API_KEY;
    process.env.TDAI_GATEWAY_API_KEY = "test-secret";
    try {
      const gateway = mockGateway();
      vi.mocked(gateway.recall).mockRejectedValueOnce(new Error("Bearer test-secret"));
      const client = await connectTestClient(gateway);
      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "q" },
      });
      expect(JSON.stringify(result.content)).toContain("[redacted]");
      expect(JSON.stringify(result.content)).not.toContain("test-secret");
    } finally {
      if (previous === undefined) delete process.env.TDAI_GATEWAY_API_KEY;
      else process.env.TDAI_GATEWAY_API_KEY = previous;
    }
  });
});

describe("Codex defaults", () => {
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

describe("STDIO process integration", () => {
  it("keeps stdout protocol-clean and reaches real local Gateway routes", async () => {
    const stdioSessionKey = deriveTdaiSessionKey({
      serviceId: "service-test",
      instanceId: "instance-test",
      teamId: "team-test",
      agentId: "agent-test",
      userId: "user-test",
      sessionId: "session-test",
    });
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const gateway = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
          Record<string, unknown>;
        requests.push({ path: request.url ?? "", body });
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/capture") {
          response.end(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }));
          return;
        }
        if (request.url === "/search/conversations") {
          response.end(JSON.stringify({ results: "captured evidence", total: 1 }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "missing route" }));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("No Gateway address");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        path.resolve("src/adapters/mcp/server.ts"),
      ],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        TDAI_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
        TDAI_SERVICE_ID: "service-test",
        TDAI_INSTANCE_ID: "instance-test",
        TDAI_TEAM_ID: "team-test",
        TDAI_AGENT_ID: "agent-test",
        TDAI_USER_ID: "user-test",
        TDAI_SESSION_ID: "session-test",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "stdio-test-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(5);
      const capture = await client.callTool({
        name: "memory_capture",
        arguments: {
          user_content: "remember this",
          assistant_content: "captured",
          user_timestamp_ms: 100,
          assistant_timestamp_ms: 200,
        },
      });
      expect(capture.isError).not.toBe(true);
      const search = await client.callTool({
        name: "conversation_search",
        arguments: { query: "remember" },
      });
      expect(textJson(search)).toEqual({ results: "captured evidence", total: 1 });
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => gateway.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }

    expect(stderr).toBe("");
    expect(requests.map((request) => request.path)).toEqual([
      "/capture",
      "/search/conversations",
    ]);
    expect(requests[0].body).toMatchObject({
      session_key: stdioSessionKey,
      messages: [
        { role: "user", content: "remember this", timestamp: 100 },
        { role: "assistant", content: "captured", timestamp: 200 },
      ],
    });
    expect(requests[1].body).toMatchObject({
      query: "remember",
      session_key: stdioSessionKey,
    });
  });
});
