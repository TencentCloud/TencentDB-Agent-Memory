/**
 * tz-03b: every mutation path announces itself. One test per path — the
 * package's claim is "all mutations pass through one point", and that is only
 * true if each writer is actually wired, not if the port merely exists.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openWritableSqlite } from "./http-utils.js";
import { bumpFeedbackPriorities } from "./feedback.js";
import { LocalMemoryCleaner } from "../utils/memory-cleaner.js";
import {
  setCommitObserver,
  type MemoryMutation,
} from "../core/record/commit-port.js";
import type { IMemoryStore } from "../core/store/types.js";

let dir: string;
let seen: MemoryMutation[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-paths-"));
  seen = [];
  setCommitObserver({ onCommitted: (m) => void seen.push(m) });
});
afterEach(() => {
  setCommitObserver(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedL1(dbPath: string): void {
  const db = openWritableSqlite(dbPath);
  try {
    db.exec(
      "CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT, priority INTEGER)",
    );
    db.prepare(
      "INSERT INTO l1_records (record_id, content, priority) VALUES ('a', 'hello world', 10)",
    ).run();
  } finally {
    db.close();
  }
}

describe("commit paths", () => {
  it("feedback announces its direct SQL mutation", () => {
    const dbPath = path.join(dir, "vectors.db");
    seedL1(dbPath);
    const result = bumpFeedbackPriorities(dbPath, ["hello"]);
    expect(result.bumped).toBe(1);
    expect(seen.map((m) => m.source)).toEqual(["feedback"]);
  });

  it("feedback stays silent when nothing matched — no mutation, no event", () => {
    const dbPath = path.join(dir, "vectors.db");
    seedL1(dbPath);
    bumpFeedbackPriorities(dbPath, ["nothing matches this"]);
    expect(seen).toEqual([]);
  });

  it("the TTL cleaner announces its deletes", async () => {
    const store = {
      countL0: () => 1000,
      countL1: () => 1000,
      deleteL0Expired: () => 5,
      deleteL1Expired: () => 3,
    } as unknown as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir: dir,
      retentionDays: 3,
      cleanTime: "04:00",
      vectorStore: store,
    });
    await cleaner.runOnce();
    cleaner.destroy();
    expect(seen.map((m) => m.source)).toEqual(["cleaner"]);
    expect(seen[0]?.affected).toBe(8);
  });

  it("the cleaner stays silent when the retention guard skipped everything", async () => {
    const store = {
      countL0: () => 1,
      countL1: () => 1,
      deleteL0Expired: () => 0,
      deleteL1Expired: () => 0,
    } as unknown as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir: dir,
      retentionDays: 3,
      cleanTime: "04:00",
      vectorStore: store,
    });
    await cleaner.runOnce();
    cleaner.destroy();
    expect(seen).toEqual([]);
  });
});

describe("scene extraction failure path", () => {
  it("announces the carrier after a failed LLM run restored the tree", async () => {
    const { SceneExtractor } = await import("../core/scene/scene-extractor.js");
    const extractor = new SceneExtractor({
      dataDir: dir,
      config: {},
      llmRunner: {
        run: () => Promise.reject(new Error("LLM unavailable")),
      } as never,
    });
    const result = await extractor.extract([
      { content: "нечто", created_at: "2026-08-01T00:00:00.000Z" },
    ]);
    expect(result.success).toBe(false);
    expect(seen.map((m) => m.source)).toContain("scene-extract-restore");
  });
});
