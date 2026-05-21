import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

describe("performAutoRecall recall budget", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it("truncates individual L1 memories and caps total injected recall text", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "memory-tdai-recall-"));
    const store = {
      isFtsAvailable: () => true,
      getCapabilities: () => ({ nativeHybridSearch: false }),
      searchL1Fts: vi.fn(async (): Promise<L1FtsResult[]> => [
        makeFtsResult("a", "A".repeat(180), 0.92),
        makeFtsResult("b", "B".repeat(180), 0.91),
        makeFtsResult("c", "C".repeat(180), 0.9),
      ]),
    } as unknown as IMemoryStore;

    const cfg = parseConfig({
      recall: {
        strategy: "keyword",
        maxResults: 3,
        scoreThreshold: 0,
        maxCharsPerMemory: 90,
        maxTotalRecallChars: 150,
      },
    });

    const result = await performAutoRecall({
      userText: "alpha",
      actorId: "user",
      sessionKey: "session",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: store,
    });

    const injected = extractRelevantMemoryLines(result?.prependContext);
    expect(injected.length).toBeLessThanOrEqual(150);
    expect(injected).toContain("已截断");
    expect(injected).not.toContain("A".repeat(120));
    expect(injected).not.toContain("C".repeat(120));
  });
});

function makeFtsResult(id: string, content: string, score: number): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 80,
    scene_name: "test",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "session",
    session_id: "session-1",
    metadata_json: "{}",
  };
}

function extractRelevantMemoryLines(prependContext: string | undefined): string {
  const match = prependContext?.match(
    /<relevant-memories>[\s\S]*?\n\n([\s\S]*?)\n<\/relevant-memories>/,
  );
  return match?.[1] ?? "";
}
