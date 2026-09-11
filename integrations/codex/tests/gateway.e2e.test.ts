import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiGateway } from "../../../src/gateway/server.js";
import { CodexMcpServer } from "../src/mcp-server.js";
import type { CodexAdapterConfig } from "../src/types.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a TCP port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe("Codex MCP to Gateway E2E", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("captures, finds, flushes, and seeds L0 through real MCP and Gateway routes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tdai-codex-e2e-"));
    const port = await freePort();
    const configPath = join(dataDir, "tdai-gateway.yaml");
    await writeFile(configPath, [
      "memory:",
      "  extraction:",
      "    enabled: false",
      "  embedding:",
      "    enabled: false",
      "  bm25:",
      "    enabled: false",
    ].join("\n"));
    process.env.TDAI_GATEWAY_CONFIG = configPath;
    process.env.TDAI_DATA_DIR = dataDir;
    process.env.TDAI_GATEWAY_HOST = "127.0.0.1";
    process.env.TDAI_GATEWAY_PORT = String(port);

    const gateway = new TdaiGateway();
    const config: CodexAdapterConfig = {
      gatewayUrl: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 5_000,
      enableSupervisor: false,
      userId: "e2e-user",
      logDir: join(dataDir, "logs"),
      captureMode: "summary",
      resultMaxChars: 12_000,
    };
    const mcp = new CodexMcpServer({ config, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const client = new Client({ name: "codex-e2e", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await gateway.start();
      await Promise.all([mcp.server.connect(serverTransport), client.connect(clientTransport)]);

      const health = await client.callTool({ name: "agent_memory_health", arguments: {} });
      expect(health.isError).not.toBe(true);
      expect(health.content).toMatchObject([{ type: "text", text: expect.stringContaining("Agent Memory Health") }]);

      const marker = "codex-e2e durable project decision";
      const capture = await client.callTool({
        name: "agent_memory_capture",
        arguments: { user_content: marker, assistant_content: "The decision was implemented and verified." },
      });
      expect(capture.isError).not.toBe(true);
      expect(capture.content).toMatchObject([{ type: "text", text: expect.stringContaining("L0 recorded: 2") }]);

      const conversations = await client.callTool({
        name: "agent_conversation_search",
        arguments: { query: marker },
      });
      expect(conversations.isError).not.toBe(true);
      expect(conversations.content).toMatchObject([{ type: "text", text: expect.stringContaining(marker) }]);

      // Extraction is deliberately disabled for this hermetic test, so L1
      // search/recall may be empty. The assertions verify both routes make a
      // complete MCP -> Gateway -> TdaiCore round trip without a fatal error.
      const recall = await client.callTool({ name: "agent_memory_recall", arguments: { query: marker } });
      expect(recall.isError).not.toBe(true);
      expect(recall.content).toMatchObject([{ type: "text", text: expect.stringContaining("Agent Memory Recall") }]);

      const memories = await client.callTool({ name: "agent_memory_search", arguments: { query: marker } });
      expect(memories.isError).not.toBe(true);
      expect(memories.content).toMatchObject([{ type: "text", text: expect.stringContaining("Agent Memory Search Results") }]);

      const flush = await client.callTool({ name: "agent_memory_session_end", arguments: {} });
      expect(flush.isError).not.toBe(true);
      expect(flush.content).toMatchObject([{ type: "text", text: expect.stringContaining("Flushed: true") }]);

      const seed = await client.callTool({
        name: "agent_memory_seed",
        arguments: {
          data: [{
            sessionKey: "codex:e2e:seed",
            conversations: [[
              { role: "user", content: "seed user", timestamp: Date.now() - 1 },
              { role: "assistant", content: "seed assistant", timestamp: Date.now() },
            ]],
          }],
        },
      });
      expect(seed.isError).not.toBe(true);
      expect(seed.content).toMatchObject([{ type: "text", text: expect.stringContaining("Sessions processed: 1") }]);
    } finally {
      await client.close().catch(() => {});
      await mcp.shutdown().catch(() => {});
      await gateway.stop().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
