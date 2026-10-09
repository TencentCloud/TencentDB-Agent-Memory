import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NormalizedInput } from "./types.js";

const mocks = vi.hoisted(() => ({
  createPipeline: vi.fn(),
  createL2Runner: vi.fn(() => vi.fn()),
  createL3Runner: vi.fn(() => vi.fn()),
  performAutoCapture: vi.fn(),
  readManifest: vi.fn(() => null),
  writeManifest: vi.fn(),
}));

vi.mock("../../utils/pipeline-factory.js", () => ({
  createPipeline: mocks.createPipeline,
  createL2Runner: mocks.createL2Runner,
  createL3Runner: mocks.createL3Runner,
}));

vi.mock("../hooks/auto-capture.js", () => ({
  performAutoCapture: mocks.performAutoCapture,
}));

vi.mock("../../utils/manifest.js", () => ({
  readManifest: mocks.readManifest,
  writeManifest: mocks.writeManifest,
}));

vi.mock("../../adapters/standalone/llm-runner.js", () => ({
  StandaloneLLMRunnerFactory: class {
    createRunner() {
      return undefined;
    }
  },
}));

import { executeSeed } from "./seed-runtime.js";

function createInput(rounds: number): NormalizedInput {
  const conversations = Array.from({ length: rounds }, (_, i) => ({
    messages: [
      { role: "user", content: `user ${i + 1}`, timestamp: 1_700_000_000_000 + i * 2 },
      { role: "assistant", content: `assistant ${i + 1}`, timestamp: 1_700_000_000_001 + i * 2 },
    ],
  }));

  return {
    sessions: [{
      sessionKey: "test-migration",
      sessionId: "seed-session-id",
      rounds: conversations,
      sourceIndex: 0,
    }],
    totalRounds: rounds,
    totalMessages: rounds * 2,
    hasTimestamps: true,
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("executeSeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flushes L1 at seed batch boundaries and flushes the tail round without waiting for idle timeout", async () => {
    const scheduler = {
      start: vi.fn(),
      setL2Runner: vi.fn(),
      setL3Runner: vi.fn(),
      flushSession: vi.fn(async () => undefined),
    };
    const pipeline = {
      scheduler,
      vectorStore: undefined,
      embeddingService: undefined,
      destroy: vi.fn(async () => undefined),
    };
    const captureWarmupValues: boolean[] = [];

    mocks.createPipeline.mockResolvedValue(pipeline);
    mocks.performAutoCapture.mockImplementation(async (params: { cfg: { pipeline: { enableWarmup: boolean } }; messages: unknown[] }) => {
      captureWarmupValues.push(params.cfg.pipeline.enableWarmup);
      return {
        schedulerNotified: true,
        l0RecordedCount: params.messages.length,
        l0VectorsWritten: 0,
        filteredMessages: [],
      };
    });

    const summary = await executeSeed(createInput(6), {
      outputDir: "seed-output",
      openclawConfig: {},
      pluginConfig: {
        pipeline: {
          everyNConversations: 5,
          enableWarmup: true,
          l1IdleTimeoutSeconds: 600,
        },
      },
      logger: createLogger(),
    });

    expect(mocks.performAutoCapture).toHaveBeenCalledTimes(6);
    expect(captureWarmupValues).toEqual([false, false, false, false, false, false]);
    expect(scheduler.flushSession).toHaveBeenCalledTimes(2);
    expect(scheduler.flushSession).toHaveBeenNthCalledWith(1, "test-migration");
    expect(scheduler.flushSession).toHaveBeenNthCalledWith(2, "test-migration");
    expect(pipeline.destroy).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      sessionsProcessed: 1,
      roundsProcessed: 6,
      messagesProcessed: 12,
      l0RecordedCount: 12,
      outputDir: "seed-output",
    });
  });
});
