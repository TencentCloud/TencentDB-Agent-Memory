import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

const ftsMemory: L1FtsResult = {
  record_id: "mem-1",
  content: "User prefers cache-safe prompt layouts",
  type: "instruction",
  priority: 1,
  scene_name: "",
  score: 1,
  timestamp_str: "",
  timestamp_start: "",
  timestamp_end: "",
  session_key: "s",
  session_id: "s",
  metadata_json: "{}",
};

function createKeywordStore(): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    searchL1Fts: () => [ftsMemory],
  } as unknown as IMemoryStore;
}

describe("performAutoRecall", () => {
  let pluginDataDir: string | undefined;

  afterEach(async () => {
    if (pluginDataDir) {
      await rm(pluginDataDir, { recursive: true, force: true });
      pluginDataDir = undefined;
    }
  });

  async function recallWithConfig(rawConfig: Record<string, unknown>) {
    pluginDataDir = await mkdtemp(path.join(tmpdir(), "tdai-recall-"));
    return performAutoRecall({
      userText: "cache layout",
      actorId: "user",
      sessionKey: "session",
      cfg: parseConfig({
        recall: { strategy: "keyword", ...rawConfig },
        embedding: { provider: "none" },
      }),
      pluginDataDir,
      vectorStore: createKeywordStore(),
    });
  }

  it("populates prependContext with dynamic L1 recall (host-neutral)", async () => {
    const result = await recallWithConfig({});

    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.prependContext).toContain(ftsMemory.content);
  });
});
