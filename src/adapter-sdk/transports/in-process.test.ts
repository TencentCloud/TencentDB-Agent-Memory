/**
 * InProcessMemoryClient unit tests.
 *
 * A fake `TdaiCoreLike` is injected in every test — the real TdaiCore (with
 * sqlite-vec / embedding / LLM machinery) is never constructed here, keeping
 * the suite offline and fast. Owned-core construction is covered indirectly
 * by the lazy-init gating test using an injectable fake as well.
 */

import { describe, expect, it, vi } from "vitest";

import { InProcessMemoryClient } from "./in-process.js";
import { MemoryClientError } from "../errors.js";
import type { TdaiCoreLike } from "../types.js";
import type { CompletedTurn } from "../../core/types.js";

// ============================
// Owned-core module mocks
// ============================
//
// The owned-core path (`new InProcessMemoryClient({})` without an injected
// core) dynamically imports gateway config + StandaloneHostAdapter + TdaiCore.
// We mock those modules so the lazy-construction gating can be tested without
// touching sqlite/embedding/filesystem. Plain counters (vi.hoisted) survive
// the global clearMocks/restoreMocks config.

const ownedCoreState = vi.hoisted(() => ({
  constructed: 0,
  initializeCalls: 0,
  destroyCalls: 0,
}));

vi.mock("../../gateway/config.js", () => ({
  loadGatewayConfig: () => ({
    server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
    data: { baseDir: "/tmp/tdai-fake-never-used" },
    llm: { baseUrl: "", apiKey: "", model: "", maxTokens: 1, timeoutMs: 1, disableThinking: false },
    memory: { capture: { excludeAgents: [] } },
  }),
}));

vi.mock("../../adapters/standalone/host-adapter.js", () => ({
  StandaloneHostAdapter: class {
    constructor(_opts: unknown) {}
  },
}));

vi.mock("../../utils/pipeline-factory.js", () => ({
  initDataDirectories: () => {},
}));

vi.mock("../../utils/session-filter.js", () => ({
  SessionFilter: class {
    constructor(_excludeAgents: unknown) {}
  },
}));

vi.mock("../../core/tdai-core.js", () => ({
  TdaiCore: class {
    constructor(_opts: unknown) {
      ownedCoreState.constructed++;
    }
    async initialize(): Promise<void> {
      ownedCoreState.initializeCalls++;
      // Yield across ticks so concurrent callers really race the gate.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    async destroy(): Promise<void> {
      ownedCoreState.destroyCalls++;
    }
    async handleBeforeRecall(): Promise<Record<string, never>> {
      return {};
    }
    async handleTurnCommitted(): Promise<unknown> {
      return { l0RecordedCount: 0, schedulerNotified: false, l0VectorsWritten: 0, filteredMessages: [] };
    }
    async searchMemories(): Promise<unknown> {
      return { text: "", total: 0, strategy: "none" };
    }
    async searchConversations(): Promise<unknown> {
      return { text: "", total: 0 };
    }
    async handleSessionEnd(): Promise<void> {}
    getVectorStore(): unknown {
      return {};
    }
    getEmbeddingService(): unknown {
      return undefined;
    }
  },
}));

// ============================
// Fake core factory
// ============================

function createFakeCore(overrides: Partial<TdaiCoreLike> = {}): TdaiCoreLike {
  return {
    initialize: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    handleBeforeRecall: vi.fn(async () => ({
      prependContext: "prepend",
      appendSystemContext: "system-ctx",
      recalledL1Memories: [
        { content: "m1", score: 0.9, type: "persona" },
        { content: "m2", score: 0.8, type: "episodic" },
      ],
      recallStrategy: "hybrid",
    })),
    handleTurnCommitted: vi.fn(async () => ({
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 2,
      filteredMessages: [],
    })),
    searchMemories: vi.fn(async () => ({ text: "facade-text", total: 1, strategy: "fts" })),
    searchConversations: vi.fn(async () => ({ text: "conv-facade", total: 1 })),
    handleSessionEnd: vi.fn(async () => {}),
    getVectorStore: vi.fn(() => ({})),
    getEmbeddingService: vi.fn(() => undefined),
    ...overrides,
  };
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// ============================
// Tests
// ============================

describe("InProcessMemoryClient", () => {
  it("recall: delegates to handleBeforeRecall and applies the gateway projection", async () => {
    const core = createFakeCore();
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    const outcome = await client.recall({ query: "hello", sessionKey: "s1" });

    expect(core.handleBeforeRecall).toHaveBeenCalledWith("hello", "s1");
    expect(outcome).toEqual({
      context: "system-ctx",
      prependContext: "prepend",
      strategy: "hybrid",
      memoryCount: 2,
    });
  });

  it("recall: empty RecallResult maps to empty context and zero count", async () => {
    const core = createFakeCore({ handleBeforeRecall: vi.fn(async () => ({})) });
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    const outcome = await client.recall({ query: "q", sessionKey: "s" });

    expect(outcome).toEqual({
      context: "",
      prependContext: undefined,
      strategy: undefined,
      memoryCount: 0,
    });
  });

  it("capture: builds a CompletedTurn with default two-message list (gateway parity)", async () => {
    const core = createFakeCore();
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    const outcome = await client.capture({
      userContent: "u-text",
      assistantContent: "a-text",
      sessionKey: "s1",
      sessionId: "sid",
    });

    expect(outcome).toEqual({ l0Recorded: 2, schedulerNotified: true });
    const turn = (core.handleTurnCommitted as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompletedTurn;
    expect(turn.userText).toBe("u-text");
    expect(turn.assistantText).toBe("a-text");
    expect(turn.sessionKey).toBe("s1");
    expect(turn.sessionId).toBe("sid");
    expect(turn.messages).toEqual([
      { role: "user", content: "u-text" },
      { role: "assistant", content: "a-text" },
    ]);
  });

  it("capture: passes explicit messages through untouched", async () => {
    const core = createFakeCore();
    const client = new InProcessMemoryClient({ core, logger: silentLogger });
    const messages = [{ role: "user", content: "u" }, { role: "tool", content: "t" }];

    await client.capture({ userContent: "u", assistantContent: "a", sessionKey: "s", messages });

    const turn = (core.handleTurnCommitted as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompletedTurn;
    expect(turn.messages).toBe(messages);
  });

  it("searchMemories: prefers the structured variant and formats its text", async () => {
    const structuredItems = [
      {
        id: "m1", content: "likes tea", type: "persona", priority: 1,
        scene_name: "", score: 0.42, created_at: "c", updated_at: "u",
      },
    ];
    const core = createFakeCore({
      searchMemoriesStructured: vi.fn(async () => ({
        results: structuredItems, total: 1, strategy: "hybrid",
      })),
    });
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    const outcome = await client.searchMemories({ query: "tea", limit: 5 });

    expect(core.searchMemoriesStructured).toHaveBeenCalledWith({ query: "tea", limit: 5 });
    expect(core.searchMemories).not.toHaveBeenCalled();
    expect(outcome.items).toEqual(structuredItems);
    expect(outcome.total).toBe(1);
    expect(outcome.strategy).toBe("hybrid");
    // Text is produced by the real formatter over the structured items.
    expect(outcome.text).toContain("likes tea");
    expect(outcome.text).toContain("persona");
  });

  it("searchMemories: falls back to the text facade when no structured variant exists", async () => {
    const core = createFakeCore(); // no searchMemoriesStructured
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    const outcome = await client.searchMemories({ query: "q" });

    expect(core.searchMemories).toHaveBeenCalledWith({ query: "q" });
    expect(outcome).toEqual({ text: "facade-text", total: 1, strategy: "fts", items: [] });
  });

  it("searchConversations: structured preference + fallback mirror searchMemories", async () => {
    const items = [
      { id: "c1", session_key: "s1", role: "user", content: "hi there", score: 0.5, recorded_at: "r" },
    ];
    const structuredCore = createFakeCore({
      searchConversationsStructured: vi.fn(async () => ({ results: items, total: 1, strategy: "fts" })),
    });
    const structuredClient = new InProcessMemoryClient({ core: structuredCore, logger: silentLogger });
    const structured = await structuredClient.searchConversations({ query: "hi", sessionKey: "s1" });
    expect(structuredCore.searchConversationsStructured).toHaveBeenCalledWith({ query: "hi", sessionKey: "s1" });
    expect(structured.items).toEqual(items);
    expect(structured.text).toContain("hi there");

    const facadeCore = createFakeCore();
    const facadeClient = new InProcessMemoryClient({ core: facadeCore, logger: silentLogger });
    const facade = await facadeClient.searchConversations({ query: "hi" });
    expect(facade).toEqual({ text: "conv-facade", total: 1, items: [] });
  });

  it("endSession: delegates to handleSessionEnd", async () => {
    const core = createFakeCore();
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    await client.endSession("s-end");

    expect(core.handleSessionEnd).toHaveBeenCalledWith("s-end");
  });

  it("health: derives status from store accessors", async () => {
    const healthy = new InProcessMemoryClient({ core: createFakeCore(), logger: silentLogger });
    expect(await healthy.health()).toEqual({
      status: "ok", vectorStore: true, embeddingService: false,
    });

    const degradedCore = createFakeCore({ getVectorStore: vi.fn(() => undefined) });
    const degraded = new InProcessMemoryClient({ core: degradedCore, logger: silentLogger });
    expect((await degraded.health()).status).toBe("degraded");
  });

  it("close(): does NOT destroy an injected core (caller owns lifecycle)", async () => {
    const core = createFakeCore();
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    await client.close();

    expect(core.destroy).not.toHaveBeenCalled();
  });

  it("rejects with 'unavailable' after close()", async () => {
    const client = new InProcessMemoryClient({ core: createFakeCore(), logger: silentLogger });
    await client.close();

    const err = await client.recall({ query: "q", sessionKey: "s" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemoryClientError);
    expect((err as MemoryClientError).code).toBe("unavailable");
  });

  it("normalizes core exceptions into MemoryClientError code 'transport'", async () => {
    const core = createFakeCore({
      handleBeforeRecall: vi.fn(async () => {
        throw new Error("sqlite exploded");
      }),
    });
    const client = new InProcessMemoryClient({ core, logger: silentLogger });

    const err = await client.recall({ query: "q", sessionKey: "s" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemoryClientError);
    expect((err as MemoryClientError).code).toBe("transport");
    expect((err as MemoryClientError).message).toContain("sqlite exploded");
  });
});

describe("InProcessMemoryClient — owned-core lazy construction (mocked core modules)", () => {
  it("concurrent first calls build and initialize exactly ONE core", async () => {
    ownedCoreState.constructed = 0;
    ownedCoreState.initializeCalls = 0;
    ownedCoreState.destroyCalls = 0;

    const client = new InProcessMemoryClient({ logger: silentLogger });

    await Promise.all([client.health(), client.health(), client.health()]);

    expect(ownedCoreState.constructed).toBe(1);
    expect(ownedCoreState.initializeCalls).toBe(1);
  });

  it("close() destroys the core when this client built it (owned lifecycle)", async () => {
    ownedCoreState.constructed = 0;
    ownedCoreState.initializeCalls = 0;
    ownedCoreState.destroyCalls = 0;

    const client = new InProcessMemoryClient({ logger: silentLogger });
    await client.health(); // trigger lazy build
    await client.close();

    expect(ownedCoreState.destroyCalls).toBe(1);
    // close() is idempotent
    await client.close();
    expect(ownedCoreState.destroyCalls).toBe(1);
  });

  it("close() during the in-flight lazy build destroys the late-landing core (no leak)", async () => {
    ownedCoreState.constructed = 0;
    ownedCoreState.initializeCalls = 0;
    ownedCoreState.destroyCalls = 0;

    const client = new InProcessMemoryClient({ logger: silentLogger });
    const inFlight = client.health(); // starts the (20ms) owned-core build
    await client.close(); // lands while the build is still running

    expect(ownedCoreState.constructed).toBe(1);
    expect(ownedCoreState.destroyCalls).toBe(1);
    await inFlight.catch(() => undefined); // in-flight call may resolve or reject
  });
});
