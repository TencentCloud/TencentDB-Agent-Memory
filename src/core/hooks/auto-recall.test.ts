import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import { performAutoRecall } from "./auto-recall.js";
import type { IMemoryStore, L1FtsResult, StoreCapabilities } from "../store/types.js";

function createFtsStore(results: L1FtsResult[]): IMemoryStore {
  const capabilities: StoreCapabilities = {
    vectorSearch: false,
    ftsSearch: true,
    nativeHybridSearch: false,
    sparseVectors: false,
  };

  return {
    init: () => ({ needsReindex: false }),
    isDegraded: () => false,
    getCapabilities: () => capabilities,
    close: () => {},
    isFtsAvailable: () => true,
    searchL1Fts: () => results,
  } as unknown as IMemoryStore;
}

describe("performAutoRecall prompt-cache layout", () => {
  it("keeps stable persona context separate from dynamic L1 recall context", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "memory-recall-layout-"));

    try {
      writeFileSync(
        join(dataDir, "persona.md"),
        [
          "# Persona",
          "",
          "The user prefers concise implementation notes.",
        ].join("\n"),
      );

      const cfg = parseConfig({
        recall: {
          strategy: "keyword",
          maxResults: 1,
          scoreThreshold: 0.1,
        },
      });

      const result = await performAutoRecall({
        userText: "How should I write the implementation note?",
        actorId: "agent",
        sessionKey: "session-1",
        cfg,
        pluginDataDir: dataDir,
        vectorStore: createFtsStore([
          {
            record_id: "m1",
            content: "User wants implementation notes to include verification commands.",
            type: "instruction",
            priority: 80,
            scene_name: "code review",
            score: 0.9,
            timestamp_str: "2026-07-01T01:00:00.000Z",
            timestamp_start: "2026-07-01T01:00:00.000Z",
            timestamp_end: "2026-07-01T01:00:00.000Z",
            session_key: "session-1",
            session_id: "session-1",
            metadata_json: "{}",
          },
        ]),
      });

      expect(result?.appendSystemContext).toContain("<user-persona>");
      expect(result?.appendSystemContext).toContain("The user prefers concise implementation notes.");
      expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
      expect(result?.appendSystemContext).not.toContain("<relevant-memories>");

      expect(result?.prependContext).toContain("<relevant-memories>");
      expect(result?.prependContext).toContain("verification commands");
      expect(result?.prependContext).not.toContain("<user-persona>");
      expect(result?.prependContext).not.toContain("<memory-tools-guide>");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
