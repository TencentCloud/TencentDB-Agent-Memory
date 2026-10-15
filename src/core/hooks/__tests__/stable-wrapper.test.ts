import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../../config.js";
import { performAutoRecall } from "../auto-recall.js";
import type { IMemoryStore, L1FtsResult, StoreCapabilities } from "../../store/types.js";
import type { Logger } from "../../types.js";

const tempDirs: string[] = [];

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const capabilities: StoreCapabilities = {
  vectorSearch: false,
  ftsSearch: true,
  nativeHybridSearch: false,
  sparseVectors: false,
};

function makeStore(results: L1FtsResult[]): IMemoryStore {
  return {
    getCapabilities: () => capabilities,
    isFtsAvailable: () => true,
    searchL1Fts: () => results,
    searchL1Vector: () => [],
  } as unknown as IMemoryStore;
}

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-stable-wrapper-"));
  tempDirs.push(dir);
  return dir;
}

async function recall(results: L1FtsResult[], userText = "How is my prompt cache?") {
  return performAutoRecall({
    userText,
    actorId: "agent",
    sessionKey: "session",
    cfg: parseConfig({
      recall: {
        strategy: "keyword",
        scoreThreshold: 0,
      },
    }),
    pluginDataDir: await makeDataDir(),
    logger,
    vectorStore: makeStore(results),
  });
}

function ftsResult(content: string): L1FtsResult {
  return {
    record_id: `record-${content}`,
    content,
    type: "instruction",
    priority: 1,
    scene_name: "",
    score: 1,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "session",
    session_id: "session-id",
    metadata_json: "{}",
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("performAutoRecall stable wrapper", () => {
  it("keeps a relevant-memories wrapper when L1 search runs with zero hits", async () => {
    const result = await recall([]);

    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.prependContext).toContain("未召回相关记忆");
    expect(result?.prependContext).toContain("</relevant-memories>");
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
    expect(result?.recalledL1Memories).toEqual([]);
  });

  it("keeps real recalled memories instead of the empty placeholder", async () => {
    const result = await recall([ftsResult("User prefers concise answers")]);

    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.prependContext).toContain("User prefers concise answers");
    expect(result?.prependContext).not.toContain("未召回相关记忆");
  });

  it("does not inject the empty wrapper when recall search is skipped", async () => {
    const result = await recall([], "");

    expect(result).toBeUndefined();
  });
});
