import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock only initStores — the rest of pipeline-factory (initDataDirectories,
// resetStores, ...) stays real so TdaiCore can run against a temp dataDir.
vi.mock("../utils/pipeline-factory.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/pipeline-factory.js")>();
  return { ...orig, initStores: vi.fn() };
});

import { initStores } from "../utils/pipeline-factory.js";
import { TdaiCore } from "./tdai-core.js";
import type { HostAdapter, Logger } from "./types.js";
import type { IMemoryStore } from "./store/types.js";
import { parseConfig } from "../config.js";
import { CheckpointManager, type Checkpoint } from "../utils/checkpoint.js";

const mockInitStores = vi.mocked(initStores);

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeHostAdapter(dataDir: string): HostAdapter {
  return {
    hostType: "standalone",
    getRuntimeContext: () => ({
      userId: "test-user",
      sessionId: "test-session",
      sessionKey: "test-session",
      platform: "cli",
      workspaceDir: dataDir,
      dataDir,
    }),
    getLogger: () => silentLogger,
    getLLMRunnerFactory: () => ({
      createRunner: () => {
        throw new Error("LLM runner not needed in this test");
      },
    }),
  };
}

function makeStore(overrides: Partial<IMemoryStore>): IMemoryStore {
  return {
    isDegraded: () => false,
    countL1: () => 0,
    countL0: () => 0,
    close: () => {},
    ...overrides,
  } as unknown as IMemoryStore;
}

/**
 * Startup recalibration of increment-only checkpoint counters (issue #157).
 * TdaiCore.initStores() must recalibrate from a healthy store, and must
 * leave the checkpoint untouched when the store is unavailable/degraded.
 */
describe("TdaiCore checkpoint recalibration on startup", () => {
  let dataDir: string;
  let core: TdaiCore | undefined;

  beforeEach(async () => {
    mockInitStores.mockReset();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-core-test-"));
  });

  afterEach(async () => {
    await core?.destroy().catch(() => {});
    core = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function seedCheckpoint(fields: Partial<Checkpoint>): Promise<void> {
    const mgr = new CheckpointManager(dataDir, silentLogger);
    const cp = await mgr.read();
    Object.assign(cp, fields);
    await mgr.write(cp);
  }

  async function readCheckpoint(): Promise<Checkpoint> {
    return new CheckpointManager(dataDir, silentLogger).read();
  }

  async function initializeCore(): Promise<void> {
    const cfg = parseConfig({});
    cfg.extraction.enabled = false; // no scheduler/timers in this test
    core = new TdaiCore({ hostAdapter: makeHostAdapter(dataDir), config: cfg });
    await core.initialize();
    // storeReady is assigned synchronously during initialize(); awaiting it
    // also awaits the recalibration that runs at the tail of initStores().
    await (core as unknown as { storeReady?: Promise<void> }).storeReady;
  }

  it("recalibrates counters from a healthy store at startup", async () => {
    await seedCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });
    mockInitStores.mockResolvedValue({
      vectorStore: makeStore({ countL1: () => 42, countL0: () => 25 }),
      embeddingService: undefined,
      needsReindex: false,
    });

    await initializeCore();

    const cp = await readCheckpoint();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(25);
    // drift = 8 → memories_since_last_persona = 10 - 8 = 2
    expect(cp.memories_since_last_persona).toBe(2);
  });

  it("does not touch the checkpoint when the store is unavailable", async () => {
    await seedCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });
    mockInitStores.mockResolvedValue({
      vectorStore: undefined,
      embeddingService: undefined,
      needsReindex: false,
    });

    await initializeCore();

    const cp = await readCheckpoint();
    expect(cp.total_memories_extracted).toBe(50);
    expect(cp.l0_conversations_count).toBe(30);
    expect(cp.memories_since_last_persona).toBe(10);
  });

  it("does not zero the checkpoint when the store is degraded", async () => {
    await seedCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });
    mockInitStores.mockResolvedValue({
      vectorStore: makeStore({ isDegraded: () => true, countL1: () => 0, countL0: () => 0 }),
      embeddingService: undefined,
      needsReindex: false,
    });

    await initializeCore();

    const cp = await readCheckpoint();
    expect(cp.total_memories_extracted).toBe(50);
    expect(cp.l0_conversations_count).toBe(30);
    expect(cp.memories_since_last_persona).toBe(10);
  });

  it("does not clear a non-empty checkpoint when healthy store counts both return zero", async () => {
    await seedCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });
    mockInitStores.mockResolvedValue({
      vectorStore: makeStore({ countL1: () => 0, countL0: () => 0 }),
      embeddingService: undefined,
      needsReindex: false,
    });

    await initializeCore();

    const cp = await readCheckpoint();
    expect(cp.total_memories_extracted).toBe(50);
    expect(cp.l0_conversations_count).toBe(30);
    expect(cp.memories_since_last_persona).toBe(10);
  });

  it("keeps the checkpoint when store init fails entirely", async () => {
    await seedCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });
    mockInitStores.mockRejectedValue(new Error("cannot open database"));

    await initializeCore();

    const cp = await readCheckpoint();
    expect(cp.total_memories_extracted).toBe(50);
    expect(cp.l0_conversations_count).toBe(30);
    expect(cp.memories_since_last_persona).toBe(10);
  });
});
