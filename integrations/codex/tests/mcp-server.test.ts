import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { CodexMcpServer } from "../src/mcp-server.js";
import type { CodexAdapterConfig } from "../src/types.js";

const config: CodexAdapterConfig = {
  gatewayUrl: "http://127.0.0.1:8420",
  requestTimeoutMs: 1_000,
  enableSupervisor: false,
  userId: "default_user",
  logDir: "logs",
  captureMode: "summary",
  resultMaxChars: 12_000,
};

describe("CodexMcpServer", () => {
  it("publishes the complete Codex memory tool set over MCP", async () => {
    const server = new CodexMcpServer({ config, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name)).toEqual([
      "agent_memory_health",
      "agent_memory_recall",
      "agent_memory_capture",
      "agent_memory_search",
      "agent_conversation_search",
      "agent_memory_session_end",
      "agent_memory_seed",
    ]);

    await client.close();
    await server.shutdown();
  });
});
