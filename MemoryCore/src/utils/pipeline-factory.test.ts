import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMemoryRecords = vi.fn();
const extract = vi.fn();

vi.mock("../core/record/l1-reader.js", () => ({ queryMemoryRecords }));
vi.mock("../core/memory-prompt/resolver.js", () => ({
  memoryPromptResolveKey: vi.fn(() => "prompt-key"),
  resolveMemoryPrompts: vi.fn(async () => new Map()),
}));
vi.mock("../core/scene/scene-extractor.js", () => ({
  SceneExtractor: class {
    extract = extract;
  },
}));
vi.mock("./checkpoint.js", () => ({
  CheckpointManager: class {
    read = vi.fn(async () => ({ scenes_processed: 0, total_processed: 0 }));
    repairMonotonicCounters = vi.fn(async () => false);
    incrementScenesProcessed = vi.fn(async () => undefined);
    incrementMemoriesSincePersona = vi.fn(async () => undefined);
  },
}));
vi.mock("../core/profile/profile-sync.js", () => ({
  listLocalProfiles: vi.fn(async () => []),
  pullProfilesToLocal: vi.fn(async () => new Map()),
  syncLocalProfilesToStore: vi.fn(async () => []),
}));

import { createL2Runner } from "./pipeline-factory.js";

describe("createL2Runner", () => {
  const vectorStore = {
    isDegraded: () => false,
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryMemoryRecords.mockReset();
    extract.mockReset();
    queryMemoryRecords.mockResolvedValue([{
      id: "l1-1",
      content: "memory",
      createdAt: "2026-10-17T00:00:00.000Z",
      updatedAt: "2026-10-17T00:00:01.000Z",
      teamId: "team-1",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
    }]);
  });

  it("propagates extraction failures instead of reporting no new data", async () => {
    extract.mockResolvedValue({
      memoriesProcessed: 0,
      success: false,
      error: "upstream request timed out",
    });

    const runner = createL2Runner({
      pluginDataDir: "test-data",
      cfg: {
        persona: {
          model: "test-model",
          promptMode: "default",
          maxScenes: 10,
          sceneBackupCount: 1,
        },
      } as never,
      openclawConfig: {},
      vectorStore: vectorStore as never,
      logger,
    });

    await expect(runner("profile:team:team-1|user:user-1|agent:agent-1"))
      .rejects.toThrow("upstream request timed out");
  });

  it("rejects without processing later groups when a group fails", async () => {
    queryMemoryRecords.mockResolvedValue([
      {
        id: "l1-1",
        content: "memory 1",
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:01.000Z",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
      },
      {
        id: "l1-2",
        content: "memory 2",
        createdAt: "2026-10-17T00:00:02.000Z",
        updatedAt: "2026-10-17T00:00:03.000Z",
        teamId: "team-2",
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
      },
      {
        id: "l1-3",
        content: "memory 3",
        createdAt: "2026-10-17T00:00:04.000Z",
        updatedAt: "2026-10-17T00:00:05.000Z",
        teamId: "team-3",
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
      },
    ]);
    extract
      .mockResolvedValueOnce({ memoriesProcessed: 1, success: true })
      .mockResolvedValueOnce({ memoriesProcessed: 0, success: false, error: "group failed" });

    const runner = createL2Runner({
      pluginDataDir: "test-data",
      cfg: {
        persona: {
          model: "test-model",
          promptMode: "default",
          maxScenes: 10,
          sceneBackupCount: 1,
        },
      } as never,
      openclawConfig: {},
      vectorStore: vectorStore as never,
      logger,
    });

    await expect(runner("profile:team:team-1|user:user-1|agent:agent-1"))
      .rejects.toThrow("group failed");
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("preserves the successful no-new-data result", async () => {
    queryMemoryRecords.mockResolvedValue([]);

    const runner = createL2Runner({
      pluginDataDir: "test-data",
      cfg: { persona: {} } as never,
      openclawConfig: {},
      vectorStore: vectorStore as never,
      logger,
    });

    await expect(runner("profile:team:team-1|user:user-1|agent:agent-1"))
      .resolves.toEqual({ skipped: true });
    expect(extract).not.toHaveBeenCalled();
  });

  it("preserves a successful extraction that processes no memories", async () => {
    extract.mockResolvedValue({ memoriesProcessed: 0, success: true });

    const runner = createL2Runner({
      pluginDataDir: "test-data",
      cfg: {
        persona: {
          model: "test-model",
          promptMode: "default",
          maxScenes: 10,
          sceneBackupCount: 1,
        },
      } as never,
      openclawConfig: {},
      vectorStore: vectorStore as never,
      logger,
    });

    await expect(runner("profile:team:team-1|user:user-1|agent:agent-1"))
      .resolves.toBeUndefined();
  });
});
