import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────
//
// We drive createL1Runner in isolation: the checkpoint manager is stubbed so
// we can observe whether the cursor was written, and extractL1Memories is
// stubbed so we can simulate the three outcomes that matter here.
const { markL1ExtractionComplete, extractL1Memories } = vi.hoisted(() => ({
  markL1ExtractionComplete: vi.fn(async () => {}),
  extractL1Memories: vi.fn(),
}));

vi.mock("./checkpoint.js", () => ({
  CheckpointManager: class {
    async read() {
      return {};
    }
    getRunnerState() {
      return { last_l1_cursor: 0, last_scene_name: undefined };
    }
    async markL1ExtractionComplete(...args: unknown[]) {
      return markL1ExtractionComplete(...args);
    }
  },
}));

vi.mock("../core/record/l1-extractor.js", () => ({
  extractL1Memories: (...args: unknown[]) => extractL1Memories(...args),
}));

vi.mock("../core/memory-prompt/resolver.js", () => ({
  memoryPromptResolveKey: () => "l1",
  resolveMemoryPrompts: async () => new Map(),
}));

import { createL1Runner } from "./pipeline-factory.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const SESSION_KEY = "session-under-test";

/** L0 rows as the vector store returns them: grouped by sessionId. */
function makeL0Groups(count = 4) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    timestamp: 1_000 + i,
    recordedAtMs: 1_700_000_000_000 + i,
    userId: "user-1",
    agentId: "agent-1",
  }));
  return [{ sessionId: "session-1", teamId: "team-1", taskId: "default", messages }];
}

function makeRunner() {
  return createL1Runner({
    pluginDataDir: "/tmp/does-not-matter",
    cfg: {
      extraction: {
        enableDedup: true,
        maxMemoriesPerSession: 10,
        model: "test-model",
        promptMode: "code",
      },
      embedding: { conflictRecallTopK: 3, captureTimeoutMs: 1000, timeoutMs: 1000 },
    },
    openclawConfig: { some: "config" },
    vectorStore: {
      isDegraded: () => false,
      queryL0GroupedBySessionId: async () => makeL0Groups(),
    },
    embeddingService: undefined,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getInstanceId: () => "test-instance",
    llmRunner: { run: vi.fn() },
    storage: undefined,
    checkpointLock: undefined,
  } as never);
}

const success = (over: Record<string, unknown> = {}) => ({
  success: true,
  extractedCount: 0,
  storedCount: 0,
  records: [],
  sceneNames: [],
  ...over,
});

beforeEach(() => {
  markL1ExtractionComplete.mockClear();
  extractL1Memories.mockReset();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("createL1Runner — cursor handling", () => {
  it("does not advance the cursor when the LLM extraction fails", async () => {
    // Regression test: a failed LLM call used to still advance the cursor,
    // which pushed it past rows that were never read. The next round's
    // `recorded_at_ms > cursor` filter then skipped them permanently, so a
    // transient upstream error silently discarded the whole batch.
    extractL1Memories.mockResolvedValue({
      success: false,
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames: [],
    });

    const result = await makeRunner()({ sessionKey: SESSION_KEY });

    expect(markL1ExtractionComplete).not.toHaveBeenCalled();
    // hasMore=true arms the l1Idle timer so the batch is retried; hasFullBacklog
    // stays false so a sustained outage doesn't become a tight retry loop.
    expect(result.hasMore).toBe(true);
    expect(result.hasFullBacklog).toBe(false);
  });

  it("still advances the cursor when extraction succeeds but finds nothing", async () => {
    // `success: true` with extractedCount === 0 means the LLM ran fine and
    // there was simply nothing worth remembering. That is not a failure and
    // must not hold the cursor back, or the same rows would be re-read forever.
    extractL1Memories.mockResolvedValue(success());

    const result = await makeRunner()({ sessionKey: SESSION_KEY });

    expect(markL1ExtractionComplete).toHaveBeenCalledTimes(1);
    expect(result.hasMore).toBe(false);
    expect(result.hasFullBacklog).toBe(false);
  });

  it("advances the cursor and reports stored memories on a normal run", async () => {
    extractL1Memories.mockResolvedValue(
      success({ extractedCount: 2, storedCount: 2, lastSceneName: "some-scene" }),
    );

    const result = await makeRunner()({ sessionKey: SESSION_KEY });

    expect(markL1ExtractionComplete).toHaveBeenCalledTimes(1);
    expect(result.storedCount).toBe(2);
    expect(result.hasMore).toBe(false);
  });
});
