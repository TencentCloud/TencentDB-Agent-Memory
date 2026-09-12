import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config.js";
import { TdaiCore } from "../../core/tdai-core.js";
import type { Logger } from "../../core/types.js";
import { CodexHostAdapter } from "./host-adapter.js";
import {
  createCodexMcpServer,
  createDefaultCodexSessionKey,
  type CodexMemoryCore,
} from "./mcp-server.js";

interface ConnectedPair {
  client: Client;
  server: McpServer;
}

const openPairs: ConnectedPair[] = [];

async function connect(core: CodexMemoryCore, defaultSessionKey = "codex:test"): Promise<ConnectedPair> {
  const server = createCodexMcpServer(core, { defaultSessionKey });
  const client = new Client({ name: "codex-adapter-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const pair = { client, server };
  openPairs.push(pair);
  return pair;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected a text tool result");
  return first.text;
}

function mockCore(): CodexMemoryCore {
  return {
    handleBeforeRecall: vi.fn(async () => ({
      prependContext: "dynamic memory",
      appendSystemContext: "stable memory",
      recalledL1Memories: [{ content: "dynamic memory", score: 0.9, type: "fact" }],
      recallStrategy: "keyword",
    })),
    handleTurnCommitted: vi.fn(async () => ({
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 0,
      filteredMessages: [],
    })),
    searchMemories: vi.fn(async () => ({ text: "memory result", total: 1, strategy: "keyword" })),
    searchConversations: vi.fn(async () => ({ text: "conversation result", total: 1 })),
    handleSessionEnd: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  await Promise.all(openPairs.splice(0).map(async ({ client, server }) => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }));
});

describe("Codex MCP adapter", () => {
  it("registers read and write tools with matching annotations", async () => {
    const { client } = await connect(mockCore());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "conversation_search",
      "memory_capture",
      "memory_recall",
      "memory_search",
      "memory_session_end",
    ]);
    expect(tools.find((tool) => tool.name === "memory_recall")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "memory_capture")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "memory_capture")?.annotations?.idempotentHint).toBe(false);
  });

  it("maps Codex capture input to a completed turn with the default session", async () => {
    const core = mockCore();
    const { client } = await connect(core, "codex:workspace");
    const result = await client.callTool({
      name: "memory_capture",
      arguments: {
        user_content: "Remember the selected database.",
        assistant_content: "The project uses SQLite for local storage.",
      },
    });

    expect(core.handleTurnCommitted).toHaveBeenCalledWith(expect.objectContaining({
      userText: "Remember the selected database.",
      assistantText: "The project uses SQLite for local storage.",
      sessionKey: "codex:workspace",
    }));
    expect(JSON.parse(resultText(result))).toMatchObject({
      session_key: "codex:workspace",
      l0_recorded: 2,
      scheduler_notified: true,
    });
  });

  it("returns both dynamic and stable recall context", async () => {
    const core = mockCore();
    const { client } = await connect(core);
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "Which database did we select?", session_key: "codex:explicit" },
    });
    const payload = JSON.parse(resultText(result));

    expect(core.handleBeforeRecall).toHaveBeenCalledWith("Which database did we select?", "codex:explicit");
    expect(payload.context).toBe("dynamic memory\n\nstable memory");
    expect(payload.memory_count).toBe(1);
  });

  it("returns MCP tool errors without terminating the server", async () => {
    const core = mockCore();
    vi.mocked(core.searchMemories).mockRejectedValueOnce(new Error("store unavailable"));
    const { client } = await connect(core);
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "anything" },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("store unavailable");
  });

  it("derives a stable session key without exposing the workspace path", () => {
    const workspace = path.join("private", "customer", "project");
    const first = createDefaultCodexSessionKey(workspace);
    const second = createDefaultCodexSessionKey(workspace);

    expect(first).toBe(second);
    expect(first).toMatch(/^codex:[0-9a-f]{12}$/);
    expect(first).not.toContain("customer");
  });
});

describe("Codex MCP memory read/write", () => {
  it("captures an L0 exchange and finds it through conversation search", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-codex-mcp-"));
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const adapter = new CodexHostAdapter({
      dataDir,
      workspaceDir: dataDir,
      llmConfig: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o",
      },
      logger,
      sessionKey: "codex:e2e",
    });
    const config = parseConfig({
      extraction: { enabled: false },
      embedding: { enabled: false, provider: "none" },
      recall: { strategy: "keyword" },
    });
    const core = new TdaiCore({ hostAdapter: adapter, config });

    try {
      await core.initialize();
      const { client } = await connect(core, "codex:e2e");
      const capture = await client.callTool({
        name: "memory_capture",
        arguments: {
          user_content: "Use the aurora-codex marker for this integration test.",
          assistant_content: "Stored the aurora-codex marker in durable memory.",
        },
      });
      const search = await client.callTool({
        name: "conversation_search",
        arguments: { query: "aurora-codex", session_key: "codex:e2e" },
      });

      expect(JSON.parse(resultText(capture)).l0_recorded).toBeGreaterThan(0);
      const searchPayload = JSON.parse(resultText(search));
      expect(searchPayload.total).toBeGreaterThan(0);
      expect(searchPayload.text).toContain("aurora-codex");
    } finally {
      await core.destroy();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
