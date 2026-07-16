import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer.js";
import type { L0Record } from "./types.js";
import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery, tokenizeForFts, VectorStore } from "./sqlite.js";

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-memory-sqlite-"));
  return { dir, dbPath: path.join(dir, "memory.db") };
}

function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function sqliteDb(store: VectorStore): { exec(sql: string): void } {
  return (store as unknown as { db: { exec(sql: string): void } }).db;
}

function l1Record(id: string, content: string): MemoryRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    content,
    type: "persona",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "session-key",
    sessionId: "session-id",
  };
}

function l0Record(id: string, messageText: string): L0Record {
  return {
    id,
    sessionKey: "session-key",
    sessionId: "session-id",
    role: "user",
    messageText,
    recordedAt: "2026-01-01T00:00:00.000Z",
    timestamp: 1_767_225_600_000,
  };
}

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("removes FTS5 syntax characters while preserving normal keyword search", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('TypeScript (SQLite) AND memory*')).toBe('"TypeScript" OR "SQLite" OR "memory"');
  });

  it("removes all FTS5 operators without treating them as searchable tokens", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta or gamma Not delta near epsilon")).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta" OR "epsilon"',
    );
  });

  it("does not remove operator text embedded inside ordinary words", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("candy ordinary oracle northeast")).toBe(
      '"candy" OR "ordinary" OR "oracle" OR "northeast"',
    );
  });

  it("returns null when input only contains FTS5 operators and syntax", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('"(" AND or NOT near - : \\ , ， 🍎 *)"')).toBeNull();
  });

  it("removes field filters, exclusion operators, backslashes, commas, CJK punctuation, and emoji", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('title:苹果 -香蕉 \\路径,测试，emoji🍎 "连续""引号"')).toBe(
      '"title" OR "苹果" OR "香蕉" OR "路径" OR "测试" OR "emoji" OR "连续" OR "引号"',
    );
  });

  it("sanitizes raw text before jieba tokenization", () => {
    const seen: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string) {
        seen.push(text);
        return text.split(/\s+/).filter(Boolean);
      },
    });

    expect(buildFtsQuery("北京 AND 烤鸭 (TypeScript*)")).toBe('"北京" OR "烤鸭" OR "TypeScript"');
    expect(seen).toEqual(["北京   烤鸭  TypeScript  "]);
  });

  it("keeps recall-relevant tokens equivalent after operator sanitization", () => {
    _setJiebaForTest(null);

    const normal = buildFtsQuery("TypeScript SQLite memory");
    const withOperators = buildFtsQuery('"TypeScript" AND (SQLite OR memory*)');

    expect(withOperators).toBe(normal);
  });
});

describe("VectorStore FTS search", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("executes sanitized L1 FTS queries through SQLite MATCH and returns raw content", () => {
    _setJiebaForTest(null);
    const { dir, dbPath } = tempDbPath();
    const store = new VectorStore(dbPath, 3);

    try {
      store.init();
      expect(store.isDegraded()).toBe(false);
      expect(store.isFtsAvailable()).toBe(true);

      expect(store.upsertL1(l1Record("l1-apple", "用户喜欢 苹果 TypeScript"), undefined)).toBe(true);
      expect(store.upsertL1(l1Record("l1-banana", "用户讨厌 香蕉"), undefined)).toBe(true);

      const results = store.searchL1Fts('title:苹果 -香蕉 or TypeScript \\路径,测试，emoji🍎 "连续""引号"', 10);

      expect(results.map((r) => r.record_id)).toContain("l1-apple");
      expect(results.find((r) => r.record_id === "l1-apple")?.content).toBe("用户喜欢 苹果 TypeScript");
    } finally {
      store.close();
      cleanupTempDir(dir);
    }
  });

  it("executes sanitized L0 FTS queries through SQLite MATCH and returns raw message text", () => {
    _setJiebaForTest(null);
    const { dir, dbPath } = tempDbPath();
    const store = new VectorStore(dbPath, 3);

    try {
      store.init();
      expect(store.isDegraded()).toBe(false);
      expect(store.isFtsAvailable()).toBe(true);

      expect(store.upsertL0(l0Record("l0-sqlite", "SQLite FTS5 可以搜索 原始消息"), undefined)).toBe(true);

      const results = store.searchL0Fts("message:SQLite and FTS5 -ignored", 10);

      expect(results).toHaveLength(1);
      expect(results[0].record_id).toBe("l0-sqlite");
      expect(results[0].message_text).toBe("SQLite FTS5 可以搜索 原始消息");
    } finally {
      store.close();
      cleanupTempDir(dir);
    }
  });

  it("keeps write-side and query-side fallback tokenization compatible", () => {
    _setJiebaForTest(null);

    const indexed = tokenizeForFts("TypeScript SQLite memory");
    const query = buildFtsQuery(indexed);

    expect(query).toBe('"TypeScript" OR "SQLite" OR "memory"');
  });

  it("keeps write-side and query-side jieba tokenization compatible", () => {
    _setJiebaForTest({
      cutForSearch(text: string) {
        if (text === "北京烤鸭 TypeScript") return ["北京", "烤鸭", "北京烤鸭", "TypeScript"];
        return text.split(/\s+/).filter(Boolean);
      },
    });

    const indexed = tokenizeForFts("北京烤鸭 TypeScript");
    const query = buildFtsQuery(indexed);

    expect(indexed).toBe("北京 烤鸭 北京烤鸭 TypeScript");
    expect(query).toBe('"北京" OR "烤鸭" OR "北京烤鸭" OR "TypeScript"');
  });

  it("rebuilds FTS indexes from L1 and L0 metadata tables", () => {
    _setJiebaForTest(null);
    const { dir, dbPath } = tempDbPath();
    const store = new VectorStore(dbPath, 3);

    try {
      store.init();
      expect(store.isFtsAvailable()).toBe(true);
      expect(store.upsertL1(l1Record("l1-rebuild", "rebuild keyword memory"), undefined)).toBe(true);
      expect(store.upsertL0(l0Record("l0-rebuild", "rebuild keyword conversation"), undefined)).toBe(true);

      sqliteDb(store).exec("DELETE FROM l1_fts");
      sqliteDb(store).exec("DELETE FROM l0_fts");
      expect(store.searchL1Fts("rebuild", 10)).toHaveLength(0);
      expect(store.searchL0Fts("rebuild", 10)).toHaveLength(0);

      store.rebuildFtsIndex();

      expect(store.searchL1Fts("rebuild", 10).map((r) => r.record_id)).toEqual(["l1-rebuild"]);
      expect(store.searchL0Fts("rebuild", 10).map((r) => r.record_id)).toEqual(["l0-rebuild"]);
    } finally {
      store.close();
      cleanupTempDir(dir);
    }
  });

  it("migrates old FTS v1 tables and rebuilds searchable v2 indexes", () => {
    _setJiebaForTest(null);
    const { dir, dbPath } = tempDbPath();
    const firstStore = new VectorStore(dbPath, 3);
    let firstStoreClosed = false;

    try {
      firstStore.init();
      expect(firstStore.isFtsAvailable()).toBe(true);
      expect(firstStore.upsertL1(l1Record("l1-migrate", "migration keyword memory"), undefined)).toBe(true);
      expect(firstStore.upsertL0(l0Record("l0-migrate", "migration keyword conversation"), undefined)).toBe(true);
      firstStore.close();
      firstStoreClosed = true;

      const db = new DatabaseSync(dbPath);
      try {
        db.exec("DROP TABLE IF EXISTS l1_fts");
        db.exec("DROP TABLE IF EXISTS l0_fts");
        db.exec(`
          CREATE VIRTUAL TABLE l1_fts USING fts5(
            content,
            record_id UNINDEXED
          )
        `);
        db.exec(`
          CREATE VIRTUAL TABLE l0_fts USING fts5(
            message_text,
            record_id UNINDEXED
          )
        `);
      } finally {
        db.close();
      }

      const migratedStore = new VectorStore(dbPath, 3);
      try {
        migratedStore.init();
        expect(migratedStore.isFtsAvailable()).toBe(true);
        expect(migratedStore.searchL1Fts("migration", 10).map((r) => r.record_id)).toEqual(["l1-migrate"]);
        expect(migratedStore.searchL0Fts("migration", 10).map((r) => r.record_id)).toEqual(["l0-migrate"]);
      } finally {
        migratedStore.close();
      }
    } finally {
      if (!firstStoreClosed) firstStore.close();
      cleanupTempDir(dir);
    }
  });
});
