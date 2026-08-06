import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer.js";
import type { L0Record } from "./types.js";
import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery, VectorStore } from "./sqlite.js";

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("builds deterministic OR queries for ordinary text in fallback mode", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("travel plan API")).toBe('"travel" OR "plan" OR "API"');
  });

  it("removes FTS5 operators and special syntax from fallback tokens", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('"alpha" OR (beta*) NOT NEAR(gamma delta, 5)')).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta" OR "5"',
    );
  });

  it.each([
    { input: 'alpha" OR "beta', expected: '"alpha" OR "beta"' },
    { input: "alpha' OR 'beta", expected: '"alpha" OR "beta"' },
    { input: "(alpha) OR (beta)", expected: '"alpha" OR "beta"' },
    { input: "alpha AND beta", expected: '"alpha" OR "beta"' },
    { input: "alpha OR beta", expected: '"alpha" OR "beta"' },
    { input: "alpha NOT beta", expected: '"alpha" OR "beta"' },
    { input: "NEAR(alpha beta, 5)", expected: '"alpha" OR "beta" OR "5"' },
    { input: "alpha NEAR/5 beta", expected: '"alpha" OR "5" OR "beta"' },
    { input: "alpha*", expected: '"alpha"' },
    { input: "content:alpha", expected: '"content" OR "alpha"' },
    { input: "-content:alpha", expected: '"content" OR "alpha"' },
    { input: "near and or not", expected: null },
    { input: "   *** ((())) :::   ", expected: null },
    { input: "alpha alpha OR beta", expected: '"alpha" OR "beta"' },
    { input: "foo_bar v2", expected: '"foo_bar" OR "v2"' },
  ])("sanitizes FTS5 syntax in %j", ({ input, expected }) => {
    _setJiebaForTest(null);

    expect(buildFtsQuery(input)).toBe(expected);
  });

  it("returns null when input contains only FTS5 syntax and operators", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('AND OR NOT NEAR * ^ : " \' ( )')).toBeNull();
  });

  it("applies the same sanitizer to jieba-produced tokens", () => {
    _setJiebaForTest({
      cutForSearch: () => ["foo:bar", " ", "AND", "C++", "的", "用户", "NEAR"],
    });

    expect(buildFtsQuery("ignored by fake jieba")).toBe('"foo" OR "bar" OR "C" OR "用户"');
  });

  it("produces an executable FTS5 query whose semantics are not controlled by payload operators", () => {
    _setJiebaForTest(null);
    const db = new DatabaseSync(":memory:");

    db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
    const insert = db.prepare("INSERT INTO docs(rowid, content) VALUES (?, ?)");
    insert.run(1, "alpha beta");
    insert.run(2, "alpha");
    insert.run(3, "beta");

    const ftsQuery = buildFtsQuery("alpha AND NOT beta");
    expect(ftsQuery).toBe('"alpha" OR "beta"');

    const rows = db
      .prepare("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid")
      .all(ftsQuery) as Array<{ rowid: number }>;

    expect(rows.map((row) => row.rowid)).toEqual([1, 2, 3]);
  });

  it("keeps ordinary recall comparable to the previous token OR strategy", () => {
    _setJiebaForTest(null);
    const db = createRecallFixtureDb();
    const ordinaryQueries = [
      "travel plan API",
      "TypeScript memory",
      "coffee beans",
      "project roadmap",
      "用户 编程 TypeScript",
    ];

    for (const query of ordinaryQueries) {
      const legacyIds = searchDocIds(db, buildLegacyUnsafeFtsQueryForTest(query));
      const sanitized = buildFtsQuery(query);
      expect(sanitized).not.toBeNull();

      const sanitizedIds = searchDocIds(db, sanitized!);
      expect(sanitizedIds).toEqual(legacyIds);
    }
  });
});

describe("VectorStore FTS query sanitization", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("keeps L1 FTS fallback searches executable and operator-neutral", async () => {
    _setJiebaForTest(null);
    const tempDir = await mkdtemp(path.join(tmpdir(), "tdai-fts-l1-"));
    const store = new VectorStore(path.join(tempDir, "memory.db"), 0);

    try {
      const init = store.init();
      expect(init.needsReindex).toBe(false);
      expect(store.isDegraded()).toBe(false);
      expect(store.isFtsAvailable()).toBe(true);

      expect(store.upsertL1(makeMemoryRecord("l1-alpha-beta", "alpha beta memory"), undefined)).toBe(true);
      expect(store.upsertL1(makeMemoryRecord("l1-alpha", "alpha memory"), undefined)).toBe(true);
      expect(store.upsertL1(makeMemoryRecord("l1-beta", "beta memory"), undefined)).toBe(true);

      const ftsQuery = buildFtsQuery("alpha AND NOT beta");
      expect(ftsQuery).toBe('"alpha" OR "beta"');

      const ids = store.searchL1Fts(ftsQuery!, 10)
        .map((result) => result.record_id)
        .sort();

      expect(ids).toEqual(["l1-alpha", "l1-alpha-beta", "l1-beta"]);
    } finally {
      store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps L0 FTS fallback searches executable and operator-neutral", async () => {
    _setJiebaForTest(null);
    const tempDir = await mkdtemp(path.join(tmpdir(), "tdai-fts-l0-"));
    const store = new VectorStore(path.join(tempDir, "memory.db"), 0);

    try {
      const init = store.init();
      expect(init.needsReindex).toBe(false);
      expect(store.isDegraded()).toBe(false);
      expect(store.isFtsAvailable()).toBe(true);

      expect(store.upsertL0(makeL0Record("l0-alpha-beta", "alpha beta message"), undefined)).toBe(true);
      expect(store.upsertL0(makeL0Record("l0-alpha", "alpha message"), undefined)).toBe(true);
      expect(store.upsertL0(makeL0Record("l0-beta", "beta message"), undefined)).toBe(true);

      const ftsQuery = buildFtsQuery("alpha AND NOT beta");
      expect(ftsQuery).toBe('"alpha" OR "beta"');

      const ids = store.searchL0Fts(ftsQuery!, 10)
        .map((result) => result.record_id)
        .sort();

      expect(ids).toEqual(["l0-alpha", "l0-alpha-beta", "l0-beta"]);
    } finally {
      store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function makeMemoryRecord(id: string, content: string): MemoryRecord {
  const now = "2026-06-30T00:00:00.000Z";
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "test-session-key",
    sessionId: "test-session-id",
  };
}

function makeL0Record(id: string, messageText: string): L0Record {
  return {
    id,
    sessionKey: "test-session-key",
    sessionId: "test-session-id",
    role: "user",
    messageText,
    recordedAt: "2026-06-30T00:00:00.000Z",
    timestamp: Date.parse("2026-06-30T00:00:00.000Z"),
  };
}

function buildLegacyUnsafeFtsQueryForTest(input: string): string {
  return input.split(/\s+/).filter(Boolean).join(" OR ");
}

function createRecallFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
  const insert = db.prepare("INSERT INTO docs(rowid, content) VALUES (?, ?)");

  insert.run(1, "travel plan API itinerary hotel booking");
  insert.run(2, "TypeScript memory search sqlite fts");
  insert.run(3, "coffee beans espresso grinder");
  insert.run(4, "project roadmap milestone release");
  insert.run(5, "用户 编程 TypeScript 记忆 搜索");
  insert.run(6, "unrelated cooking recipe");

  return db;
}

function searchDocIds(db: DatabaseSync, ftsQuery: string): number[] {
  const rows = db
    .prepare("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid")
    .all(ftsQuery) as Array<{ rowid: number }>;
  return rows.map((row) => row.rowid);
}
