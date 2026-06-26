import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("performAutoRecall recall budget", () => {
  it("limits each injected L1 memory by configured character count", async () => {
    const dataDir = await makeTempDir();
    const longContent = `alpha ${"x".repeat(240)}`;
    const store = fakeFtsStore([
      makeFtsResult("m1", longContent),
    ]);
    const cfg = parseConfig({
      recall: {
        strategy: "keyword",
        maxResults: 1,
        maxCharsPerMemory: 120,
        maxTotalRecallChars: 0,
      },
    });

    const result = await performAutoRecall({
      userText: "alpha query",
      actorId: "agent",
      sessionKey: "session",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: store,
    });

    expect(result?.prependContext).toContain("已截断");
    expect(result?.prependContext).not.toContain("x".repeat(180));
    expect(result?.recalledL1Memories?.[0]?.content).toContain("已截断");
  });

  it("stops adding L1 memories after the total recall budget is exhausted", async () => {
    const dataDir = await makeTempDir();
    const store = fakeFtsStore([
      makeFtsResult("m1", `alpha ${"a".repeat(160)}`),
      makeFtsResult("m2", `beta ${"b".repeat(160)}`),
    ]);
    const cfg = parseConfig({
      recall: {
        strategy: "keyword",
        maxResults: 2,
        maxCharsPerMemory: 0,
        maxTotalRecallChars: 150,
      },
    });

    const result = await performAutoRecall({
      userText: "alpha beta",
      actorId: "agent",
      sessionKey: "session",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: store,
    });

    expect(result?.prependContext).toContain("alpha");
    expect(result?.prependContext).toContain("已截断");
    expect(result?.prependContext).not.toContain("beta");
    expect(result?.recalledL1Memories).toHaveLength(1);
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tdai-auto-recall-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeFtsResult(recordId: string, content: string): L1FtsResult {
  return {
    record_id: recordId,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "test scene",
    score: 1,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "session",
    session_id: "session-id",
    metadata_json: "{}",
  };
}

function fakeFtsStore(results: L1FtsResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    searchL1Fts: async (_query, limit) => results.slice(0, limit),
    getCapabilities: () => ({
      vectorSearch: false,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    }),
  } as Partial<IMemoryStore> as IMemoryStore;
}
