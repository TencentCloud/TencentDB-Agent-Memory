import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

const ftsMemory: L1FtsResult = {
  record_id: "l1-1",
  content: "User prefers stable prompt prefixes for cache efficiency.",
  type: "preference",
  priority: 5,
  scene_name: "",
  score: 0.9,
  timestamp_str: "",
  timestamp_start: "",
  timestamp_end: "",
  session_key: "session-1",
  session_id: "session-1",
  metadata_json: "{}",
};

function createFtsStore(results: L1FtsResult[]): IMemoryStore {
  return {
    init: () => ({ needsReindex: false }),
    isDegraded: () => false,
    getCapabilities: () => ({
      vectorSearch: false,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    }),
    close: () => {},
    upsertL1: () => true,
    deleteL1: () => true,
    deleteL1Batch: () => true,
    deleteL1Expired: () => 0,
    countL1: () => results.length,
    queryL1Records: () => [],
    getAllL1Texts: () => [],
    searchL1Vector: () => [],
    searchL1Fts: () => results,
    upsertL0: () => true,
    deleteL0: () => true,
    deleteL0Expired: () => 0,
    countL0: () => 0,
    queryL0ForL1: () => [],
    queryL0GroupedBySessionId: () => [],
    getAllL0Texts: () => [],
    searchL0Vector: () => [],
    searchL0Fts: () => [],
    reindexAll: async () => ({ l1Count: 0, l0Count: 0 }),
    isFtsAvailable: () => true,
  };
}

describe("performAutoRecall injection placement", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function createDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "memory-tdai-recall-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("keeps dynamic L1 memories in prependContext by default for compatibility", async () => {
    const cfg = parseConfig({ recall: { strategy: "keyword" } });
    const result = await performAutoRecall({
      userText: "How should we improve prompt cache?",
      actorId: "default_user",
      sessionKey: "session-1",
      cfg,
      pluginDataDir: await createDataDir(),
      vectorStore: createFtsStore([ftsMemory]),
    });

    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.appendContext).toBeUndefined();
  });

  it("can append dynamic L1 memories after the user prompt to preserve prefix cache stability", async () => {
    const cfg = parseConfig({ recall: { strategy: "keyword", injectionMode: "append" } });
    const result = await performAutoRecall({
      userText: "How should we improve prompt cache?",
      actorId: "default_user",
      sessionKey: "session-1",
      cfg,
      pluginDataDir: await createDataDir(),
      vectorStore: createFtsStore([ftsMemory]),
    });

    expect(result?.prependContext).toBeUndefined();
    expect(result?.appendContext).toContain("<relevant-memories>");
    expect(result?.appendContext).toContain("stable prompt prefixes");
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
  });
});
