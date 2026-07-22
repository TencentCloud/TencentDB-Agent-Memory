import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../config.js";
import type {
  CaptureResult,
  CompletedTurn,
  HostAdapter,
  Logger,
} from "./types.js";
import type { Checkpoint, PipelineSessionState } from "../utils/checkpoint.js";
import { CheckpointManager } from "../utils/checkpoint.js";
import { createMemoryStoreMock, createMockLogger } from "../__tests__/helpers/checkpoint-fixtures.js";
import type { MemoryPipelineManager } from "../utils/pipeline-manager.js";

const moduleMocks = vi.hoisted(() => ({
  initDataDirectories: vi.fn(),
  initStores: vi.fn(),
  resetStores: vi.fn(),
  createPipelineManager: vi.fn(),
  createL1Runner: vi.fn(),
  createPersister: vi.fn(),
  createL2Runner: vi.fn(),
  createL3Runner: vi.fn(),
  performAutoCapture: vi.fn(),
}));

vi.mock("../utils/pipeline-factory.js", () => ({
  initDataDirectories: moduleMocks.initDataDirectories,
  initStores: moduleMocks.initStores,
  resetStores: moduleMocks.resetStores,
  createPipelineManager: moduleMocks.createPipelineManager,
  createL1Runner: moduleMocks.createL1Runner,
  createPersister: moduleMocks.createPersister,
  createL2Runner: moduleMocks.createL2Runner,
  createL3Runner: moduleMocks.createL3Runner,
}));

vi.mock("./hooks/auto-capture.js", () => ({
  performAutoCapture: moduleMocks.performAutoCapture,
}));

import { TdaiCore } from "./tdai-core.js";

interface SchedulerMock {
  start: ReturnType<typeof vi.fn>;
  setL1Runner: ReturnType<typeof vi.fn>;
  setL2Runner: ReturnType<typeof vi.fn>;
  setL3Runner: ReturnType<typeof vi.fn>;
  setPersister: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  flushSession: ReturnType<typeof vi.fn>;
}

const captureResult: CaptureResult = {
  l0RecordedCount: 0,
  schedulerNotified: false,
  l0VectorsWritten: 0,
  filteredMessages: [],
};

const turn: CompletedTurn = {
  userText: "hello",
  assistantText: "hi",
  messages: [],
  sessionKey: "session-a",
  sessionId: "conversation-a",
  startedAt: 123,
};

function createHostAdapter(logger: Logger): HostAdapter {
  return {
    hostType: "openclaw",
    getLogger: () => logger,
    getRuntimeContext: () => ({
      userId: "user",
      sessionId: "conversation-a",
      sessionKey: "session-a",
      platform: "openclaw",
      workspaceDir: "E:\\workspace",
      dataDir: "E:\\tdai-core-test-data",
    }),
    getLLMRunnerFactory: () => ({
      createRunner: () => ({ run: async () => "" }),
    }),
  };
}

function createSchedulerMock(events: string[]): SchedulerMock {
  return {
    start: vi.fn(() => { events.push("scheduler.start"); }),
    setL1Runner: vi.fn(),
    setL2Runner: vi.fn(),
    setL3Runner: vi.fn(),
    setPersister: vi.fn(),
    destroy: vi.fn(async () => {}),
    flushSession: vi.fn(async () => {}),
  };
}

function checkpointWithPipelineStates(
  pipelineStates: Record<string, PipelineSessionState>,
): Checkpoint {
  return {
    last_captured_timestamp: 0,
    total_processed: 0,
    last_persona_at: 0,
    last_persona_time: "",
    request_persona_update: false,
    persona_update_reason: "",
    memories_since_last_persona: 0,
    scenes_processed: 0,
    runner_states: {},
    pipeline_states: pipelineStates,
    l0_conversations_count: 0,
    total_memories_extracted: 0,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  moduleMocks.initStores.mockResolvedValue({
    vectorStore: undefined,
    embeddingService: undefined,
    needsReindex: false,
  });
  moduleMocks.createL1Runner.mockReturnValue(async () => ({ processedCount: 0 }));
  moduleMocks.createPersister.mockReturnValue(async () => {});
  moduleMocks.createL2Runner.mockReturnValue(async () => {});
  moduleMocks.createL3Runner.mockReturnValue(async () => {});
  moduleMocks.performAutoCapture.mockResolvedValue(captureResult);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TdaiCore checkpoint startup calibration", () => {
  it("calibrates checkpoint exactly once before scheduler state restoration", async () => {
    const events: string[] = [];
    const logger = createMockLogger();
    const scheduler = createSchedulerMock(events);
    const store = createMemoryStoreMock();
    moduleMocks.initStores.mockResolvedValue({
      vectorStore: store,
      embeddingService: undefined,
      needsReindex: false,
    });
    moduleMocks.createPipelineManager.mockReturnValue(scheduler as unknown as MemoryPipelineManager);

    const restoredStates: Record<string, PipelineSessionState> = {
      "session-a": {
        conversation_count: 2,
        last_extraction_time: "2026-01-01T00:00:00.000Z",
        last_extraction_updated_time: "2026-01-01T00:00:00.000Z",
        last_active_time: 10,
        l2_pending_l1_count: 1,
        warmup_threshold: 0,
        l2_last_extraction_time: "2026-01-01T00:00:00.000Z",
      },
    };
    const calibrationGate = deferred();
    const calibrationStarted = deferred();
    const recalibrate = vi
      .spyOn(CheckpointManager.prototype, "recalibrateFromStorage")
      .mockImplementation(async () => {
        events.push("calibration.start");
        calibrationStarted.resolve();
        await calibrationGate.promise;
        events.push("calibration.end");
        return {
          source: "store",
          status: "reconciled",
          l0: 4,
          l1: 2,
          memoriesSincePersona: 2,
          changed: true,
        };
      });
    const read = vi.spyOn(CheckpointManager.prototype, "read").mockImplementation(async () => {
      events.push("checkpoint.read");
      return checkpointWithPipelineStates(restoredStates);
    });
    const core = new TdaiCore({
      hostAdapter: createHostAdapter(logger),
      config: parseConfig({}),
    });

    const initialize = core.initialize();
    await calibrationStarted.promise;
    const starts = [core.handleTurnCommitted(turn), core.handleTurnCommitted(turn)];
    calibrationGate.resolve();
    await Promise.all([initialize, ...starts]);

    expect(recalibrate).toHaveBeenCalledTimes(1);
    expect(recalibrate).toHaveBeenCalledWith(store, "core-startup");
    expect(read).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledWith(restoredStates);
    expect(events.indexOf("calibration.end")).toBeLessThan(events.indexOf("checkpoint.read"));
    expect(events.indexOf("checkpoint.read")).toBeLessThan(events.indexOf("scheduler.start"));
  });

  it("continues startup in degraded mode when Store initialization fails", async () => {
    const events: string[] = [];
    const logger = createMockLogger();
    const scheduler = createSchedulerMock(events);
    moduleMocks.initStores.mockImplementation(async () => {
      events.push("store.failed");
      throw new Error("store unavailable");
    });
    moduleMocks.createPipelineManager.mockReturnValue(scheduler as unknown as MemoryPipelineManager);

    const restoredStates: Record<string, PipelineSessionState> = {
      "degraded-session": {
        conversation_count: 1,
        last_extraction_time: "",
        last_extraction_updated_time: "",
        last_active_time: 30,
        l2_pending_l1_count: 0,
        warmup_threshold: 1,
        l2_last_extraction_time: "",
      },
    };
    const recalibrate = vi
      .spyOn(CheckpointManager.prototype, "recalibrateFromStorage")
      .mockImplementation(async () => {
        events.push("calibration.end");
        return {
          source: "jsonl",
          status: "reconciled",
          l0: 2,
          l1: 1,
          memoriesSincePersona: 1,
          changed: true,
        };
      });
    const read = vi.spyOn(CheckpointManager.prototype, "read").mockImplementation(async () => {
      events.push("checkpoint.read");
      return checkpointWithPipelineStates(restoredStates);
    });
    const core = new TdaiCore({
      hostAdapter: createHostAdapter(logger),
      config: parseConfig({}),
    });

    const initialize = core.initialize();
    const starts = [core.handleTurnCommitted(turn), core.handleTurnCommitted(turn)];

    await expect(Promise.all([initialize, ...starts])).resolves.toHaveLength(3);
    expect(moduleMocks.createPipelineManager).toHaveBeenCalledTimes(1);
    expect(scheduler.setL1Runner).toHaveBeenCalledTimes(1);
    expect(scheduler.setPersister).toHaveBeenCalledTimes(1);
    expect(scheduler.setL2Runner).toHaveBeenCalledTimes(1);
    expect(scheduler.setL3Runner).toHaveBeenCalledTimes(1);
    expect(recalibrate).toHaveBeenCalledTimes(1);
    expect(recalibrate).toHaveBeenCalledWith(undefined, "core-startup");
    expect(read).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledWith(restoredStates);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("degraded mode"));
    expect(events.indexOf("store.failed")).toBeLessThan(events.indexOf("calibration.end"));
    expect(events.indexOf("calibration.end")).toBeLessThan(events.indexOf("checkpoint.read"));
    expect(events.indexOf("checkpoint.read")).toBeLessThan(events.indexOf("scheduler.start"));
  });

  it("continues scheduler startup when checkpoint recalibration fails", async () => {
    const events: string[] = [];
    const logger = createMockLogger();
    const scheduler = createSchedulerMock(events);
    moduleMocks.createPipelineManager.mockReturnValue(scheduler as unknown as MemoryPipelineManager);

    const restoredStates: Record<string, PipelineSessionState> = {
      "session-b": {
        conversation_count: 0,
        last_extraction_time: "",
        last_extraction_updated_time: "",
        last_active_time: 20,
        l2_pending_l1_count: 0,
        warmup_threshold: 1,
        l2_last_extraction_time: "",
      },
    };
    const calibrationGate = deferred();
    const calibrationStarted = deferred();
    const recalibrate = vi
      .spyOn(CheckpointManager.prototype, "recalibrateFromStorage")
      .mockImplementation(async () => {
        calibrationStarted.resolve();
        await calibrationGate.promise;
        return {
          source: "jsonl",
          status: "reconciled",
          l0: 0,
          l1: 0,
          memoriesSincePersona: 0,
          changed: false,
        };
      });
    vi.spyOn(CheckpointManager.prototype, "read").mockResolvedValue(
      checkpointWithPipelineStates(restoredStates),
    );
    const core = new TdaiCore({
      hostAdapter: createHostAdapter(logger),
      config: parseConfig({}),
    });

    const initialize = core.initialize();
    await calibrationStarted.promise;
    const starts = [core.handleTurnCommitted(turn), core.handleTurnCommitted(turn)];
    calibrationGate.reject(new Error("recalibration failed"));

    await expect(Promise.all([initialize, ...starts])).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("non-fatal"));
    expect(recalibrate).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledWith(restoredStates);
  });
});
