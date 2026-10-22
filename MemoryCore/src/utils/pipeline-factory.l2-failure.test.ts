import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config.js";
import type { IMemoryStore } from "../core/store/types.js";

const extractorState = vi.hoisted(() => ({
  result: {} as {
    success: boolean;
    memoriesProcessed: number;
    error?: string;
    emptyExtraction?: boolean;
  },
}));

vi.mock("../core/scene/scene-extractor.js", () => ({
  SceneExtractor: class {
    async extract() {
      return extractorState.result;
    }
  },
}));

vi.mock("../core/memory-prompt/resolver.js", () => ({
  resolveMemoryPrompts: vi.fn(async () => new Map()),
  memoryPromptResolveKey: vi.fn(() => "default"),
}));

const { createL2Runner } = await import("./pipeline-factory.js");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createL2Runner failure propagation", () => {
  function makeRunner() {
    const pluginDataDir = mkdtempSync(join(tmpdir(), "l2-failure-"));
    tempDirs.push(pluginDataDir);
    const vectorStore = {
      isDegraded: () => false,
      queryL1Records: vi.fn().mockResolvedValue([{
        record_id: "l1-1",
        content: "Durable memory",
        type: "event",
        priority: 0,
        scene_name: "",
        metadata_json: "{}",
        timestamp_str: "2026-10-22T00:00:00.000Z",
        timestamp_start: "2026-10-22T00:00:00.000Z",
        timestamp_end: "2026-10-22T00:00:00.000Z",
        created_time: "2026-10-22T00:00:00.000Z",
        updated_time: "2026-10-22T00:00:00.000Z",
        version: 1,
        session_key: "session-1",
        session_id: "session-1",
        task_id: "",
        team_id: "team-1",
        user_id: "user-1",
        agent_id: "agent-1",
      }]),
    } as unknown as IMemoryStore;
    return createL2Runner({
      pluginDataDir,
      cfg: parseConfig({}),
      openclawConfig: {},
      vectorStore,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
  }

  it("throws extractor failures instead of returning a skipped result", async () => {
    extractorState.result = {
      success: false,
      memoriesProcessed: 0,
      error: "upstream 503",
    };
    const runner = makeRunner();

    await expect(runner("session-1")).rejects.toThrow(
      "L2 extraction failed for session-1: upstream 503",
    );
  });

  it("preserves a successful empty extraction as a no-op", async () => {
    extractorState.result = {
      success: true,
      memoriesProcessed: 0,
      emptyExtraction: true,
    };
    const runner = makeRunner();

    await expect(runner("session-1")).resolves.toBeUndefined();
  });
});
