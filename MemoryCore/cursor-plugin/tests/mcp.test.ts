import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorConfig } from "../src/config.js";
import { createCursorMcpServer, type CursorSearchClient } from "../src/mcp.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

const config: CursorConfig = {
  rootDir: "/root",
  gatewayUrl: "https://memory.example.com",
  gatewayApiKey: "secret",
  serviceId: "service-1",
  teamId: "team-1",
  agentId: "agent-1",
  userId: "user-1",
  captureTimeoutMs: 60_000,
  recallTimeoutMs: 2_000,
  executablePath: "/bin/memory-tencentdb-cursor",
  transcriptsRoot: "/home/test/.cursor/projects",
};

function fakeClient(overrides: Partial<CursorSearchClient> = {}): CursorSearchClient {
  return {
    searchAtomic: vi.fn().mockResolvedValue({ items: [] }),
    searchConversation: vi.fn().mockResolvedValue({ messages: [] }),
    readScenario: vi.fn().mockResolvedValue({
      path: "project/scene.md",
      content: "场景正文",
      created_at: null,
      updated_at: null,
    }),
    ...overrides,
  };
}

async function connect(memoryClient: CursorSearchClient) {
  const server = createCursorMcpServer(config, memoryClient);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("Cursor v3 MCP bridge", () => {
  // MCP 表面严格限定为 L1、L0、L2 三个只读工具.
  it("只注册三个只读工具", async () => {
    const client = await connect(fakeClient());

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "tdai_conversation_search",
      "tdai_memory_search",
      "tdai_read_cos",
    ]);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const memorySearch = result.tools.find((tool) => tool.name === "tdai_memory_search");
    expect(memorySearch?.inputSchema.properties).not.toHaveProperty("scene");
  });

  // L1 参数直接映射 searchAtomic, 不保留无消费者的 scene.
  it("映射 L1 searchAtomic", async () => {
    const memoryClient = fakeClient({
      searchAtomic: vi.fn().mockResolvedValue({ items: [{ id: "1", content: "偏好" }] }),
    });
    const client = await connect(memoryClient);

    const result = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "偏好", limit: 5, type: "preference" },
    });

    expect(memoryClient.searchAtomic).toHaveBeenCalledWith({
      query: "偏好",
      limit: 5,
      type: "preference",
    });
    expect(result.isError).not.toBe(true);
  });

  // L0 的 session_key 只映射为 SDK session_id.
  it("映射 L0 searchConversation", async () => {
    const memoryClient = fakeClient();
    const client = await connect(memoryClient);

    await client.callTool({
      name: "tdai_conversation_search",
      arguments: { query: "原话", session_key: "cursor:c1" },
    });

    expect(memoryClient.searchConversation).toHaveBeenCalledWith({
      query: "原话",
      session_id: "cursor:c1",
    });
  });

  // tdai_read_cos 仅复用工具名, 实际必须调用 v3 readScenario.
  it("映射 L2 readScenario", async () => {
    const memoryClient = fakeClient();
    const client = await connect(memoryClient);

    const result = await client.callTool({
      name: "tdai_read_cos",
      arguments: { path: "project/scene.md" },
    });

    expect(memoryClient.readScenario).toHaveBeenCalledWith({ path: "project/scene.md" });
    expect(result.content).toEqual([{
      type: "text",
      text: "场景正文",
    }]);
  });

  // 空、绝对和 traversal path 必须在调用 SDK 前拒绝.
  it.each([
    "",
    "/absolute.md",
    "../secret.md",
    "safe/../secret.md",
    "safe\\secret.md",
    "safe/line\nbreak.md",
    "safe/`break.md",
    "safe/control\u0001.md",
  ])(
    "拒绝不安全 path %j",
    async (scenarioPath) => {
      const memoryClient = fakeClient();
      const client = await connect(memoryClient);

      const result = await client.callTool({
        name: "tdai_read_cos",
        arguments: { path: scenarioPath },
      });

      expect(result.isError).toBe(true);
      expect(memoryClient.readScenario).not.toHaveBeenCalled();
    },
  );

  // v3 以 content:null 表示场景不存在, 工具必须给出明确错误.
  it("将 content:null 转为 tool error", async () => {
    const memoryClient = fakeClient({
      readScenario: vi.fn().mockResolvedValue({
        path: "missing.md",
        content: null,
        created_at: null,
        updated_at: null,
      }),
    });
    const client = await connect(memoryClient);

    const result = await client.callTool({
      name: "tdai_read_cos",
      arguments: { path: "missing.md" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "Scenario not found: missing.md",
    }]);
  });

  // SDK 错误必须保持 bounded, 不向 MCP 输出无限响应体.
  it("返回 bounded SDK error", async () => {
    const memoryClient = fakeClient({
      searchAtomic: vi.fn().mockRejectedValue(new Error("x".repeat(1_000))),
    });
    const client = await connect(memoryClient);

    const result = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "偏好" },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.length).toBeLessThanOrEqual(330);
  });
});
