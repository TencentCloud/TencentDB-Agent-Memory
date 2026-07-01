import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer.js";
import type { L0Record } from "./types.js";
import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery, VectorStore } from "./sqlite.js";

const SECURITY_CASES: Array<{ input: string; expected: string | null }> = [
  { input: 'alpha" OR "beta', expected: '"alpha" OR "beta"' },
  { input: "alpha' OR 'beta", expected: '"alpha" OR "beta"' },
  { input: 'alpha "" beta', expected: '"alpha" OR "beta"' },
  { input: "(alpha) OR (beta)", expected: '"alpha" OR "beta"' },
  { input: "{alpha beta} AND gamma", expected: '"alpha" OR "beta" OR "gamma"' },
  { input: "alpha AND beta", expected: '"alpha" OR "beta"' },
  { input: "alpha or beta", expected: '"alpha" OR "beta"' },
  { input: "alpha ＯＲ beta", expected: '"alpha" OR "beta"' },
  { input: "alpha NOT beta", expected: '"alpha" OR "beta"' },
  { input: "(alpha OR beta) AND NOT gamma", expected: '"alpha" OR "beta" OR "gamma"' },
  { input: "NEAR(alpha beta, 5)", expected: '"alpha" OR "beta"' },
  { input: "alpha NEAR/5 beta", expected: '"alpha" OR "beta"' },
  { input: "ＮＥＡＲ（alpha beta，５）", expected: '"alpha" OR "beta"' },
  { input: "alpha ＮＥＡＲ／５ beta", expected: '"alpha" OR "beta"' },
  { input: "alpha*", expected: '"alpha"' },
  { input: "^alpha", expected: '"alpha"' },
  { input: "content:alpha", expected: '"content" OR "alpha"' },
  { input: "-content:alpha", expected: '"content" OR "alpha"' },
  { input: "{content metadata}:alpha", expected: '"content" OR "metadata" OR "alpha"' },
  { input: "title:alpha OR body:beta", expected: '"title" OR "alpha" OR "body" OR "beta"' },
  { input: "AND OR NOT NEAR", expected: null },
  { input: "near and or not", expected: null },
  { input: '"" \'\' () {} : * - ^', expected: null },
  { input: "   *** ((())) :::   ", expected: null },
  { input: "alpha alpha OR beta", expected: '"alpha" OR "beta"' },
  { input: "android nearshore notary OR", expected: '"android" OR "nearshore" OR "notary"' },
  { input: "foo_bar v2", expected: '"foo_bar" OR "v2"' },
  { input: "ＡＰＩ ＡＮＤ version２", expected: '"API" OR "version2"' },
  { input: "mañana café 用户 １２３", expected: '"mañana" OR "café" OR "用户" OR "123"' },
  { input: "C++ OR C#", expected: '"C"' },
  { input: "alpha\tAND\nbeta", expected: '"alpha" OR "beta"' },
];

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  describe("advanced FTS5 syntax sanitization", () => {
    it("builds deterministic OR queries for ordinary fallback tokens", () => {
      _setJiebaForTest(null);

      expect(buildFtsQuery("travel plan API")).toBe('"travel" OR "plan" OR "API"');
      expect(buildFtsQuery("用户喜欢编程 TypeScript")).toBe('"用户喜欢编程" OR "TypeScript"');
    });

    it.each(SECURITY_CASES)("sanitizes fallback input %j", ({ input, expected }) => {
      _setJiebaForTest(null);

      expect(buildFtsQuery(input)).toBe(expected);
    });

    it("returns executable MATCH expressions for every non-empty sanitized security case", () => {
      _setJiebaForTest(null);
      const db = createExecutionFixtureDb();

      try {
        for (const { input, expected } of SECURITY_CASES) {
          const ftsQuery = buildFtsQuery(input);
          expect(ftsQuery).toBe(expected);

          if (ftsQuery === null) {
            continue;
          }

          expect(() => searchDocIds(db, ftsQuery)).not.toThrow();
        }
      } finally {
        db.close();
      }
    });

    it.each([
      {
        tokens: ["foo:bar", " ", "AND", "C++", "的", "用户", "NEAR", "用户"],
        expected: '"foo" OR "bar" OR "C" OR "用户"',
      },
      {
        tokens: ["title:alpha", "-body:beta", "{metadata}", "NOT", "gamma*"],
        expected: '"title" OR "alpha" OR "body" OR "beta" OR "metadata" OR "gamma"',
      },
      {
        tokens: ["ＡＰＩ", "ＯＲ", "version２", "nearshore", "一个"],
        expected: '"API" OR "version2" OR "nearshore"',
      },
    ])("applies the same sanitizer to jieba-produced tokens %#", ({ tokens, expected }) => {
      _setJiebaForTest({
        cutForSearch: () => tokens,
      });

      expect(buildFtsQuery("ignored by fake jieba")).toBe(expected);
    });

    it("produces an executable FTS5 query whose semantics are not controlled by boolean operators", () => {
      _setJiebaForTest(null);
      const db = new DatabaseSync(":memory:");

      try {
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
      } finally {
        db.close();
      }
    });
  });

  describe("deep recall stability", () => {
    it("keeps ordinary keyword recall stable against the previous token OR strategy", () => {
      _setJiebaForTest(null);
      const db = createRecallFixtureDb();

      try {
        const cases: Array<{ input: string; expectedIds: number[] }> = [
          { input: "travel plan hotel", expectedIds: [1] },
          { input: "TypeScript memory", expectedIds: [2, 5] },
          { input: "coffee beans", expectedIds: [3] },
          { input: "project roadmap", expectedIds: [4] },
          { input: "用户 编程 TypeScript", expectedIds: [2, 5] },
          { input: "release_2026 v2", expectedIds: [6] },
          { input: "backend compatibility v2", expectedIds: [6] },
          { input: "android nearshore notary", expectedIds: [8] },
        ];

        for (const { input, expectedIds } of cases) {
          const legacyIds = searchDocIds(db, buildLegacyUnsafeFtsQueryForTest(input));
          const ftsQuery = buildFtsQuery(input);
          expect(ftsQuery).not.toBeNull();
          const sanitizedIds = searchDocIds(db, ftsQuery!);

          expect(legacyIds).toEqual(expectedIds);
          expect(sanitizedIds).toEqual(legacyIds);
        }
      } finally {
        db.close();
      }
    });

    it("keeps noisy FTS5 syntax queries recall-equivalent to their clean keyword forms", () => {
      _setJiebaForTest(null);
      const db = createRecallFixtureDb();

      try {
        const cases: Array<{ clean: string; noisy: string; expectedIds: number[] }> = [
          { clean: "travel API", noisy: "travel AND API", expectedIds: [1, 6] },
          { clean: "TypeScript memory", noisy: "TypeScript OR memory", expectedIds: [2, 5] },
          { clean: "coffee beans", noisy: "coffee NOT beans", expectedIds: [3] },
          { clean: "project roadmap", noisy: "NEAR(project roadmap, 5)", expectedIds: [4] },
          { clean: "用户 编程", noisy: '"用户" OR "编程"', expectedIds: [5] },
          { clean: "release_2026 v2", noisy: "release_2026 ＯＲ v2", expectedIds: [6] },
          { clean: "content metadata alpha", noisy: "{content metadata}:alpha", expectedIds: [7] },
          { clean: "android nearshore notary", noisy: "android OR nearshore NOT notary", expectedIds: [8] },
        ];

        for (const { clean, noisy, expectedIds } of cases) {
          const cleanQuery = buildFtsQuery(clean);
          const noisyQuery = buildFtsQuery(noisy);
          expect(cleanQuery).not.toBeNull();
          expect(noisyQuery).not.toBeNull();

          const cleanIds = searchDocIds(db, cleanQuery!);
          const noisyIds = searchDocIds(db, noisyQuery!);

          expect(cleanIds).toEqual(expectedIds);
          expect(noisyIds).toEqual(cleanIds);
        }
      } finally {
        db.close();
      }
    });
  });
});

describe("VectorStore FTS query sanitization", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("keeps L1 FTS fallback searches executable and recall-equivalent for clean and noisy queries", async () => {
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

      const cleanQuery = buildFtsQuery("alpha beta");
      const noisyQuery = buildFtsQuery("alpha AND NOT beta");
      expect(cleanQuery).toBe('"alpha" OR "beta"');
      expect(noisyQuery).toBe(cleanQuery);

      const cleanIds = store.searchL1Fts(cleanQuery!, 10)
        .map((result) => result.record_id)
        .sort();
      const noisyIds = store.searchL1Fts(noisyQuery!, 10)
        .map((result) => result.record_id)
        .sort();

      expect(cleanIds).toEqual(["l1-alpha", "l1-alpha-beta", "l1-beta"]);
      expect(noisyIds).toEqual(cleanIds);
    } finally {
      store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps L0 FTS fallback searches executable and recall-equivalent for clean and noisy queries", async () => {
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

      const cleanQuery = buildFtsQuery("alpha beta");
      const noisyQuery = buildFtsQuery("alpha AND NOT beta");
      expect(cleanQuery).toBe('"alpha" OR "beta"');
      expect(noisyQuery).toBe(cleanQuery);

      const cleanIds = store.searchL0Fts(cleanQuery!, 10)
        .map((result) => result.record_id)
        .sort();
      const noisyIds = store.searchL0Fts(noisyQuery!, 10)
        .map((result) => result.record_id)
        .sort();

      expect(cleanIds).toEqual(["l0-alpha", "l0-alpha-beta", "l0-beta"]);
      expect(noisyIds).toEqual(cleanIds);
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

function createExecutionFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
  db.exec(`
    INSERT INTO docs(rowid, content) VALUES
      (1, 'alpha beta gamma content metadata title body foo_bar v2 API version2 manana cafe 用户 123 android nearshore notary C'),
      (2, 'travel plan hotel TypeScript memory coffee beans project roadmap release_2026 backend');
  `);
  return db;
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
  insert.run(6, "release_2026 v2 API backend compatibility");
  insert.run(7, "content metadata alpha archive");
  insert.run(8, "android nearshore notary terms");
  insert.run(9, "unrelated cooking recipe");
  insert.run(10, "5 distance marker only");

  return db;
}

function searchDocIds(db: DatabaseSync, ftsQuery: string): number[] {
  const rows = db
    .prepare("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid")
    .all(ftsQuery) as Array<{ rowid: number }>;
  return rows.map((row) => row.rowid);
}
