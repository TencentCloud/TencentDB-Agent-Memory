import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";
import { performAutoRecall } from "./auto-recall.js";
import { VectorStore } from "../store/sqlite.js";
import type { IMemoryStore, L1FtsResult, StoreCapabilities } from "../store/types.js";
import type { MemoryRecord } from "../record/l1-writer.js";

const tempDirs: string[] = [];

describe("performAutoRecall prompt-cache stability", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps stable persona and scene context separate from dynamic L1 recall", async () => {
    const dataDir = await makeTempDataDir();
    await writeStableProfileData(dataDir);
    const store = new FakeRecallStore([
      ftsResult("m1", "Use concise TypeScript examples.", "instruction"),
    ]);
    const cfg = parseConfig({
      recall: {
        strategy: "keyword",
        scoreThreshold: 0,
        maxResults: 5,
      },
    });

    const first = await performAutoRecall({
      userText: "Please summarize TypeScript task style.",
      actorId: "default_user",
      sessionKey: "session-a",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: store as unknown as IMemoryStore,
    });

    expect(first?.appendSystemContext).toContain("<user-persona>");
    expect(first?.appendSystemContext).toContain("Prefers short status updates.");
    expect(first?.appendSystemContext).toContain("<scene-navigation>");
    expect(first?.appendSystemContext).toContain("Scene Navigation");
    expect(first?.appendSystemContext).toContain("<memory-tools-guide>");
    expect(first?.appendSystemContext).not.toContain("<relevant-memories>");
    expect(first?.prependContext).toContain("<relevant-memories>");
    expect(first?.prependContext).toContain("Use concise TypeScript examples.");

    store.results = [
      ftsResult("m2", "Prefers implementation notes before PR text.", "instruction"),
    ];
    const second = await performAutoRecall({
      userText: "What should I do before drafting the PR?",
      actorId: "default_user",
      sessionKey: "session-a",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: store as unknown as IMemoryStore,
    });

    expect(second?.appendSystemContext).toBe(first?.appendSystemContext);
    expect(second?.prependContext).not.toBe(first?.prependContext);
    expect(second?.prependContext).toContain("Prefers implementation notes before PR text.");
  });

  it("recalls real SQLite L1 records while keeping dynamic recall out of stable system context", async () => {
    const dataDir = await makeTempDataDir();
    await writeStableProfileData(dataDir);
    const store = new VectorStore(path.join(dataDir, "vectors.db"), 0, silentLogger);
    store.init();

    try {
      expect(store.isDegraded()).toBe(false);
      expect(store.isFtsAvailable()).toBe(true);

      expect(store.upsertL1(memoryRecord({
        id: "m-cache",
        content: "TypeScript prompt cache tests should keep stable persona and scene context separate.",
        type: "instruction",
      }))).toBe(true);
      expect(store.upsertL1(memoryRecord({
        id: "m-unrelated",
        content: "Coffee beans should be stored in an airtight container.",
        type: "episodic",
      }))).toBe(true);

      const cfg = parseConfig({
        recall: {
          strategy: "keyword",
          scoreThreshold: 0,
          maxResults: 5,
        },
      });

      const result = await performAutoRecall({
        userText: "Please check the TypeScript prompt cache implementation.",
        actorId: "default_user",
        sessionKey: "session-real",
        cfg,
        pluginDataDir: dataDir,
        vectorStore: store,
      });

      expect(result?.appendSystemContext).toContain("<user-persona>");
      expect(result?.appendSystemContext).toContain("<scene-navigation>");
      expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
      expect(result?.appendSystemContext).not.toContain("<relevant-memories>");
      expect(result?.prependContext).toContain("<relevant-memories>");
      expect(result?.prependContext).toContain("TypeScript prompt cache tests should keep stable persona");
      expect(result?.prependContext).not.toContain("Coffee beans");
    } finally {
      store.close();
    }
  });
});

async function makeTempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tdai-recall-cache-"));
  tempDirs.push(dir);
  return dir;
}

async function writeStableProfileData(dataDir: string): Promise<void> {
  await mkdir(path.join(dataDir, ".metadata"), { recursive: true });
  await mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  await writeFile(
    path.join(dataDir, "persona.md"),
    [
      "# Persona",
      "",
      "- Prefers short status updates.",
      "",
      "---",
      "## 🗺️ Scene Navigation (Scene Index)",
      "stale embedded navigation should be stripped",
    ].join("\n"),
  );
  await writeFile(
    path.join(dataDir, ".metadata", "scene_index.json"),
    JSON.stringify([
      {
        filename: "work.md",
        summary: "Current project implementation context",
        heat: 10,
        created: "2026-06-01T00:00:00.000Z",
        updated: "2026-06-30T00:00:00.000Z",
      },
    ]),
  );
  await writeFile(path.join(dataDir, "scene_blocks", "work.md"), "# Work scene\n");
}

function ftsResult(recordId: string, content: string, type: string): L1FtsResult {
  return {
    record_id: recordId,
    content,
    type,
    priority: 50,
    scene_name: "work",
    score: 1,
    timestamp_str: "2026-06-30T00:00:00.000Z",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "session-a",
    session_id: "sid",
    metadata_json: "{}",
  };
}

function memoryRecord(overrides: Pick<MemoryRecord, "id" | "content" | "type">): MemoryRecord {
  const now = "2026-06-30T00:00:00.000Z";
  return {
    id: overrides.id,
    content: overrides.content,
    type: overrides.type,
    priority: 50,
    scene_name: "work",
    source_message_ids: ["msg-1"],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "session-real",
    sessionId: "sid-real",
  };
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeRecallStore implements Partial<IMemoryStore> {
  constructor(public results: L1FtsResult[]) {}

  isFtsAvailable(): boolean {
    return true;
  }

  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: false,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  async searchL1Fts(): Promise<L1FtsResult[]> {
    return this.results;
  }
}
