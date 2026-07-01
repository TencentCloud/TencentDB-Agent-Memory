import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TdaiGateway } from "../../../src/gateway/server.js";
import { VectorStore } from "../../../src/core/store/sqlite.js";
import type { MemoryRecord } from "../../../src/core/record/l1-writer.js";
import { createMemoryAdapter, type MemoryPlatformAdapter } from "./index.js";

interface CodexLikeTurn {
  user: string;
  assistant: string;
  messages?: unknown[];
}

const sessionKey = "codex:sdk-integration";
const sessionId = "codex-sdk-session-1";

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not include ${needle}. Output:\n${haystack}`);
  }
}

async function seedL1Memory(dataDir: string, marker: string): Promise<void> {
  const store = new VectorStore(path.join(dataDir, "vectors.db"), 0, console);
  store.init({ provider: "none", model: "none", dimensions: 0 });
  const now = new Date().toISOString();
  const record: MemoryRecord = {
    id: `codex-sdk-l1-${marker}`,
    content: `Codex SDK integration recall marker: ${marker}. Use short bullet summaries in this project.`,
    type: "instruction",
    priority: 95,
    scene_name: "codex-sdk-integration",
    source_message_ids: [`seed:${marker}`],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey,
    sessionId,
  };
  const ok = store.upsertL1(record, undefined);
  store.close();
  if (!ok) throw new Error("failed to seed SDK L1 memory");
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "tdai-codex-sdk-full-"));
  const port = 18428;
  const configPath = path.join(dataDir, "tdai-gateway.json");
  const l0Marker = `codex-sdk-l0-${Date.now()}`;
  const l1Marker = `codex-sdk-l1-${Date.now()}`;

  writeFileSync(configPath, JSON.stringify({
    server: { port, host: "127.0.0.1" },
    data: { baseDir: dataDir },
    memory: {
      capture: { enabled: true },
      extraction: { enabled: false },
      recall: { enabled: true, strategy: "fts", maxResults: 5, scoreThreshold: 0 },
      embedding: { provider: "none", enabled: false },
      pipeline: { everyNConversations: 999999, enableWarmup: false },
      llm: { enabled: false },
    },
  }, null, 2));

  process.env.TDAI_GATEWAY_CONFIG = configPath;
  const gateway = new TdaiGateway();

  const platform: MemoryPlatformAdapter<CodexLikeTurn> = {
    getSession: () => ({
      platform: "codex",
      sessionKey,
      sessionId,
      userId: "codex-test-user",
      workspaceDir: process.cwd(),
    }),
    getUserText: (turn) => turn.user,
    getAssistantText: (turn) => turn.assistant,
    getMessages: (turn) => turn.messages,
  };

  const memory = createMemoryAdapter(platform, {
    gatewayUrl: `http://127.0.0.1:${port}`,
  });

  try {
    await seedL1Memory(dataDir, l1Marker);
    await gateway.start();

    const health = await memory.client.health() as { status?: string };
    if (health.status !== "ok") throw new Error(`gateway health failed: ${JSON.stringify(health)}`);
    console.log("sdk health ok");

    const recallTurn: CodexLikeTurn = { user: `What memory matches ${l1Marker}?`, assistant: "" };
    const recall = await memory.recallForTurn(recallTurn);
    assertIncludes(recall.context, l1Marker, "sdk recall context");
    if ((recall.memoryCount ?? 0) < 1) throw new Error(`expected recall memoryCount >= 1, got ${recall.memoryCount}`);
    console.log("sdk recall ok");

    const completedTurn: CodexLikeTurn = {
      user: `Please remember this SDK L0 marker: ${l0Marker}`,
      assistant: `Captured SDK L0 marker ${l0Marker}`,
      messages: [
        { role: "user", content: `Please remember this SDK L0 marker: ${l0Marker}` },
        { role: "assistant", content: `Captured SDK L0 marker ${l0Marker}` },
      ],
    };
    const capture = await memory.captureTurn(completedTurn);
    if (capture.l0Recorded !== 2) throw new Error(`expected 2 L0 records, got ${capture.l0Recorded}`);
    console.log("sdk capture ok");

    const conversationSearch = await memory.searchConversations({ query: l0Marker, limit: 5 });
    assertIncludes(conversationSearch.results, l0Marker, "sdk conversation-search");
    if (conversationSearch.total < 1) throw new Error(`expected conversation total >= 1, got ${conversationSearch.total}`);
    console.log("sdk conversation-search ok");

    const memorySearch = await memory.searchMemories({ query: l1Marker, limit: 5 });
    assertIncludes(memorySearch.results, l1Marker, "sdk memory-search");
    if (memorySearch.total < 1) throw new Error(`expected memory total >= 1, got ${memorySearch.total}`);
    console.log("sdk memory-search ok");

    const compacted = memory.compactContext({
      messages: [
        { role: "user", content: "start long Codex task" },
        ...Array.from({ length: 16 }, (_, index) => ({
          role: index % 2 === 0 ? "assistant" : "tool",
          content: `Codex short-term payload ${index} ${"z".repeat(1400)}`,
          toolCallId: `codex-tool-${index}`,
        })),
        { role: "user", content: "final Codex request must remain" },
      ],
      targetTokens: 700,
      systemPrompt: "Codex integration test",
      prompt: "final Codex request must remain",
    });
    if (!compacted.compacted || compacted.tokensAfter >= compacted.tokensBefore) {
      throw new Error(`expected short-term compaction, before=${compacted.tokensBefore}, after=${compacted.tokensAfter}`);
    }
    assertIncludes(JSON.stringify(compacted.messages), "final Codex request must remain", "sdk compacted context");
    console.log("sdk short-term compaction ok");

    console.log(JSON.stringify({
      ok: true,
      adapter: "adapter-sdk",
      platform: "codex",
      sessionKey,
      checks: ["health", "recall", "capture", "conversation-search", "memory-search", "short-term-compaction"],
      l0Marker,
      l1Marker,
    }, null, 2));
  } finally {
    await gateway.stop();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.TDAI_GATEWAY_CONFIG;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
