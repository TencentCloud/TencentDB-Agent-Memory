import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { parseConfig } from "../config.js";
import type { QuotaManager } from "../core/quota/quota-manager.js";
import { SceneExtractor } from "../core/scene/scene-extractor.js";
import type { TaskPayload } from "../core/state/types.js";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import { TdaiCore } from "../core/tdai-core.js";
import type { HostAdapter, LLMRunner, LLMRunnerFactory } from "../core/types.js";
import { TdaiGateway } from "../gateway/server.js";
import type { TaskExecutor } from "../services/pipeline-worker.js";
import { createL2Runner } from "./pipeline-factory.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let dataDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "l2-error-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function makeL1Row(overrides: Partial<L1RecordRow> = {}): L1RecordRow {
  const timestamp = "2026-10-17T00:00:00.000Z";
  return {
    record_id: "l1-record-1",
    content: "A non-empty L1 memory for extraction",
    type: "episodic",
    priority: 1,
    scene_name: "",
    timestamp_str: timestamp,
    timestamp_start: timestamp,
    timestamp_end: timestamp,
    created_time: timestamp,
    updated_time: timestamp,
    version: 1,
    session_key: "session-1",
    session_id: "session-1",
    team_id: "team-1",
    task_id: "task-1",
    user_id: "user-1",
    agent_id: "agent-1",
    metadata_json: "{}",
    ...overrides,
  };
}

function makeStore(rows: L1RecordRow[] = [makeL1Row()]) {
  return {
    isDegraded: () => false,
    queryL1Records: vi.fn(async () => rows),
  } as unknown as IMemoryStore;
}

describe("createL2Runner extraction outcomes", () => {
  let extractorExtract: MockInstance<SceneExtractor["extract"]>;

  beforeEach(() => {
    // Restore after each test so the credit suite uses the real extractor.
    extractorExtract = vi.spyOn(SceneExtractor.prototype, "extract");
  });

  function makeRunner(rows?: L1RecordRow[]) {
    return createL2Runner({
      pluginDataDir: dataDir,
      cfg: parseConfig({}),
      openclawConfig: {},
      vectorStore: makeStore(rows),
      logger,
    });
  }

  it("skips an empty L1 query without calling the extractor", async () => {
    await expect(makeRunner([])("session-1", "old-cursor")).resolves.toEqual({ skipped: true });
    expect(extractorExtract).not.toHaveBeenCalled();
  });

  it("preserves successful zero-memory extraction as undefined", async () => {
    extractorExtract.mockResolvedValue({ success: true, memoriesProcessed: 0 });

    await expect(makeRunner()("session-1")).resolves.toBeUndefined();
    expect(extractorExtract).toHaveBeenCalledOnce();
  });

  it("skips a successful extraction with no scene changes", async () => {
    extractorExtract.mockResolvedValue({ success: true, memoriesProcessed: 1, emptyExtraction: true });

    await expect(makeRunner()("session-1")).resolves.toEqual({ skipped: true });
    expect(extractorExtract).toHaveBeenCalledOnce();
  });

  it("stops at a failed group and returns the cursor after a successful rerun", async () => {
    const rows = [0, 1, 2].map((index) => makeL1Row({
      record_id: `l1-${index}`,
      agent_id: `agent-${index}`,
      updated_time: `2026-10-17T00:0${index}:00.000Z`,
    }));
    extractorExtract.mockImplementation(async (memories) => {
      const success = memories[0].id !== rows[1].record_id;
      return { success, memoriesProcessed: success ? 1 : 0, error: "group extraction failed" };
    });

    const runner = makeRunner(rows);
    await expect(runner("session-1")).rejects.toThrow("group extraction failed");
    expect(extractorExtract).toHaveBeenCalledTimes(2);
    expect(extractorExtract).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: rows[1].record_id }),
    ]);

    extractorExtract.mockResolvedValue({ success: true, memoriesProcessed: 1 });
    await expect(runner("session-1")).resolves.toMatchObject({ latestCursor: rows[2].updated_time });
    expect(extractorExtract).toHaveBeenCalledTimes(5);
  });
});

type LlmStep = "write-scene" | "fail-503";

function makeHarness(
  steps: LlmStep[],
  { provider = "openai", groupCount = 2 }: { provider?: "openai" | "proxy"; groupCount?: 1 | 2 } = {},
) {
  const rows = [1, 2].slice(0, groupCount).map((index) => makeL1Row({
    record_id: `l1-${index}`,
    agent_id: `agent-${index}`,
    updated_time: `2026-10-17T00:0${index}:00.000Z`,
  }));
  const store = makeStore(rows);
  const behavior = { calls: 0, steps: [...steps] };
  const factory: LLMRunnerFactory = {
    createRunner: () => {
      const inner: LLMRunner & { lastUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } } = {
        async run(params) {
          behavior.calls++;
          const step = behavior.steps.shift();
          if (step === undefined) throw new Error("Unexpected LLM call");
          if (step === "write-scene") {
            await mkdir(params.workspaceDir!, { recursive: true });
            await writeFile(
              path.join(params.workspaceDir!, `scene-credit-${behavior.calls}.md`),
              "# Work style\n\nA scene created by a successful group.\n",
              "utf8",
            );
            this.lastUsage = { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 };
            return "scene created";
          }
          this.lastUsage = undefined;
          throw new Error("upstream HTTP 503");
        },
      };
      return inner;
    },
  };
  const hostAdapter = {
    hostType: "standalone",
    getRuntimeContext: () => ({ dataDir }),
    getLogger: () => logger,
    getLLMRunnerFactory: () => factory,
  } as unknown as HostAdapter;
  const core = new TdaiCore({ hostAdapter, config: parseConfig({}), instanceId: "credit-test" });
  const reportUsage = vi.fn<QuotaManager["reportUsage"]>().mockResolvedValue(undefined);
  const gateway = new TdaiGateway({
    deployMode: "standalone",
    instanceId: "default",
    data: { baseDir: path.join(dataDir, "gateway"), fileStore: "local" },
    llm: { provider, baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-key", model: "test-model" },
  });
  // Isolate infrastructure here while exercising the native core, extractor, and executor.
  const harnessGateway = gateway as unknown as {
    core: TdaiCore;
    storePool: { getStore: () => Promise<{ store: IMemoryStore }> };
    quotaManager: { checkCreditQuota: () => Promise<{ allowed: boolean }>; reportUsage: typeof reportUsage };
    resolveStoreBackendConfigs: () => Promise<{ vdbConfig: undefined; mongoConfig: undefined }>;
    resolveStorageForInstance: () => Promise<undefined>;
    buildTaskExecutor: () => TaskExecutor;
  };
  harnessGateway.core = core;
  harnessGateway.storePool = { getStore: async () => ({ store }) };
  harnessGateway.quotaManager = { checkCreditQuota: async () => ({ allowed: true }), reportUsage };
  harnessGateway.resolveStoreBackendConfigs = async () => ({ vdbConfig: undefined, mongoConfig: undefined });
  harnessGateway.resolveStorageForInstance = async () => undefined;
  return { executor: harnessGateway.buildTaskExecutor(), reportUsage, behavior };
}

function makeTask(id: string): TaskPayload {
  return {
    id,
    type: "L2",
    instanceId: "default",
    sessionId: "session-1",
    teamId: "team-1",
    agentId: "agent-1",
    priority: 0,
    createdAt: Date.now(),
    data: {
      instanceId: "default",
      userId: "user-1",
      teamId: "team-1",
      agentId: "agent-1",
      sessionId: "session-1",
    },
  };
}

describe("L2 credit reporting on extraction failure", () => {
  it("propagates a zero-credit extraction failure without skipping", async () => {
    const { executor, reportUsage, behavior } = makeHarness(["fail-503"], { groupCount: 1 });
    const task = makeTask("l2-all-fail");

    await expect(executor.executeL2(task)).rejects.toMatchObject({
      name: "L2ExtractionError",
      creditUsed: 0,
      message: expect.stringContaining("(scope=team:team-1|agent:agent-1): upstream HTTP 503"),
      cause: expect.objectContaining({ message: expect.stringContaining("upstream HTTP 503") }),
    });

    expect(reportUsage).not.toHaveBeenCalled();
    expect(task).not.toHaveProperty("_l2Skipped");
    expect(behavior.calls).toBe(1);
  });

  it("does not duplicate proxy-reported credit when a later group fails", async () => {
    const { executor, reportUsage, behavior } = makeHarness(["write-scene", "fail-503"], { provider: "proxy" });

    await expect(executor.executeL2(makeTask("l2-proxy-fail"))).rejects.toMatchObject({
      name: "L2ExtractionError",
      creditUsed: 0.14,
    });

    expect(reportUsage).not.toHaveBeenCalled();
    expect(behavior.calls).toBe(2);
  });

  it("preserves failure credit and cause, then reports a successful rerun independently", async () => {
    const { executor, reportUsage, behavior } = makeHarness(["write-scene", "fail-503", "write-scene", "write-scene"]);
    const failedTask = makeTask("l2-attempt-1");

    await expect(executor.executeL2(failedTask)).rejects.toMatchObject({
      name: "L2ExtractionError",
      creditUsed: 0.14,
      message: expect.stringContaining("HTTP 503"),
      cause: expect.objectContaining({ message: expect.stringContaining("HTTP 503") }),
    });
    expect(reportUsage.mock.calls).toEqual([["default", 0, 0.14, "L2"]]);
    expect(failedTask).not.toHaveProperty("_l2Skipped");
    expect(behavior.calls).toBe(2);
    const task = makeTask("l2-attempt-2");
    await expect(executor.executeL2(task)).resolves.toBeUndefined();

    expect(reportUsage.mock.calls).toEqual([
      ["default", 0, 0.14, "L2"],
      ["default", 0, 0.28, "L2"],
    ]);
    expect(task).not.toHaveProperty("_l2Skipped");
    expect(behavior.calls).toBe(4);
  });

  it("preserves the extraction error when async usage reporting fails", async () => {
    const { executor, reportUsage } = makeHarness(["write-scene", "fail-503"]);
    reportUsage.mockRejectedValue(new Error("quota reporting failure"));

    await expect(executor.executeL2(makeTask("l2-report-failure"))).rejects.toMatchObject({
      name: "L2ExtractionError",
      creditUsed: 0.14,
      message: expect.stringContaining("HTTP 503"),
      cause: expect.objectContaining({ message: expect.stringContaining("HTTP 503") }),
    });

    expect(reportUsage).toHaveBeenCalledOnce();
  });
});
