import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer.js";
import type { L0Record } from "./types.js";
import {
  buildFts5LiteralOrQuery,
  quoteFts5Literal,
} from "./fts5-query.js";
import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  VectorStore,
} from "./sqlite.js";

describe("quoteFts5Literal", () => {
  it("escapes quotes according to the FTS5 string grammar", () => {
    expect(quoteFts5Literal('alpha"beta')).toBe('"alpha""beta"');
  });
});

describe("buildFts5LiteralOrQuery", () => {
  it.each([
    ["travel plan API", '"travel" OR "plan" OR "API"'],
    ['alpha" OR "beta', '"alpha" OR "OR" OR "beta"'],
    ["(alpha) AND beta*", '"alpha" OR "AND" OR "beta"'],
    ["NEAR(alpha beta, 5)", '"NEAR" OR "alpha" OR "beta" OR "5"'],
    ["content:alpha -beta", '"content" OR "alpha" OR "beta"'],
    ["foo_bar v2", '"foo_bar" OR "v2"'],
    ["用户 编程 TypeScript", '"用户" OR "编程" OR "TypeScript"'],
    ["*** ((())) :::", null],
  ])("encodes %j as a literal-only query", (input, expected) => {
    expect(buildFts5LiteralOrQuery([input])).toBe(expected);
  });

  it("preserves reserved words as searchable literals", () => {
    expect(buildFts5LiteralOrQuery(["near and or not"])).toBe(
      '"near" OR "and" OR "or" OR "not"',
    );
  });

  it("deduplicates case-insensitively while preserving first spelling", () => {
    expect(buildFts5LiteralOrQuery(["Alpha alpha ALPHA beta"])).toBe(
      '"Alpha" OR "beta"',
    );
  });

  it("applies stop words after token extraction", () => {
    expect(
      buildFts5LiteralOrQuery(["用户:的 编程"], {
        stopWords: new Set(["的"]),
      }),
    ).toBe('"用户" OR "编程"');
  });

  it("does not introduce an unrelated query-length policy", () => {
    const input = Array.from({ length: 100 }, (_, index) => `t${index}`).join(" ");
    const query = buildFts5LiteralOrQuery([input]);

    expect(query?.split(" OR ")).toHaveLength(100);
    expect(query).toContain('"t0"');
    expect(query).toContain('"t99"');
  });

  it("does not normalize query text differently from the existing index", () => {
    expect(buildFts5LiteralOrQuery(["ＮＥＡＲ ａｉｒｐｏｒｔ"])).toBe(
      '"ＮＥＡＲ" OR "ａｉｒｐｏｒｔ"',
    );
  });
});

describe("buildFtsQuery integration", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("uses the same encoder in fallback mode", () => {
    _setJiebaForTest(null);
    expect(buildFtsQuery('alpha AND NOT beta*')).toBe(
      '"alpha" OR "AND" OR "NOT" OR "beta"',
    );
  });

  it("uses the same encoder for jieba candidates", () => {
    _setJiebaForTest({
      cutForSearch: () => ["foo:bar", "AND", "用户", "的", "foo"],
    });
    expect(buildFtsQuery("ignored")).toBe(
      '"foo" OR "bar" OR "AND" OR "用户"',
    );
  });

  it("keeps benign fallback behavior byte-for-byte compatible", () => {
    _setJiebaForTest(null);
    const inputs = [
      "travel plan API",
      "TypeScript memory",
      "coffee beans",
      "project roadmap",
      "用户 编程 TypeScript",
    ];

    for (const input of inputs) {
      expect(buildFtsQuery(input)).toBe(legacyFallbackQuery(input));
    }
  });
});

describe("real SQLite FTS5 execution", () => {
  it("treats reserved words as literals and retains their recall value", () => {
    const db = createFixture();

    expect(searchIds(db, buildFts5LiteralOrQuery(["near airport"])!)).toContain(1);
    expect(searchIds(db, buildFts5LiteralOrQuery(["research and development"])!)).toContain(2);
    expect(searchIds(db, buildFts5LiteralOrQuery(["logical or operator"])!)).toContain(3);
    expect(searchIds(db, buildFts5LiteralOrQuery(["not available"])!)).toContain(4);
  });

  it("keeps query normalization symmetric with already-indexed text", () => {
    const db = createFixture();
    expect(searchIds(db, buildFts5LiteralOrQuery(["ＮＥＡＲ ａｉｒｐｏｒｔ"])!)).toContain(6);
    expect(searchIds(db, buildFts5LiteralOrQuery(["NEAR airport"])!)).not.toContain(6);
  });

  it("executes deterministic fuzz payloads without syntax errors", () => {
    const db = createFixture();
    const alphabet = 'abcXYZ019_ "\'():*+-/^\t\nANDORNOTNEAR用户';
    const random = mulberry32(0x160);

    for (let sample = 0; sample < 2_000; sample += 1) {
      const length = Math.floor(random() * 160);
      let payload = "";
      for (let index = 0; index < length; index += 1) {
        payload += alphabet[Math.floor(random() * alphabet.length)];
      }

      const query = buildFts5LiteralOrQuery([payload]);
      if (!query) continue;

      expect(query).toMatch(
        /^"[\p{L}\p{N}_]+"(?: OR "[\p{L}\p{N}_]+")*$/u,
      );
      expect(() => searchIds(db, query)).not.toThrow();
    }
  });

  it.each([
    ["C++ templates", 7],
    [".NET runtime", 8],
    ["node.js streams", 9],
    ["dev@example.com", 10],
  ])("mirrors unicode61 tokenization for technical query %j", (queryText, expectedId) => {
    const db = createFixture();
    const query = buildFts5LiteralOrQuery([queryText]);

    expect(query).not.toBeNull();
    expect(searchIds(db, query!)).toContain(expectedId);
  });

  it("executes a directly quoted value containing a double quote", () => {
    const db = createFixture();
    expect(() => searchIds(db, quoteFts5Literal('alpha"beta'))).not.toThrow();
  });
});

describe("VectorStore production paths", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("uses literal semantics for both L1 and L0 FTS searches", async () => {
    _setJiebaForTest(null);
    const dir = await mkdtemp(path.join(tmpdir(), "tdai-fts5-query-"));
    const store = new VectorStore(path.join(dir, "memory.db"), 0);

    try {
      store.init();
      expect(store.upsertL1(memoryRecord("l1-near", "near airport"), undefined)).toBe(true);
      expect(store.upsertL1(memoryRecord("l1-far", "far station"), undefined)).toBe(true);
      expect(store.upsertL0(l0Record("l0-near", "near airport"), undefined)).toBe(true);
      expect(store.upsertL0(l0Record("l0-far", "far station"), undefined)).toBe(true);
      expect(store.upsertL1(memoryRecord("l1-cpp", "C++ templates"), undefined)).toBe(true);
      expect(store.upsertL0(l0Record("l0-dotnet", ".NET runtime"), undefined)).toBe(true);

      const query = buildFtsQuery("near airport");
      expect(query).toBe('"near" OR "airport"');
      expect(store.searchL1Fts(query!, 10).map((row) => row.record_id)).toContain("l1-near");
      expect(store.searchL0Fts(query!, 10).map((row) => row.record_id)).toContain("l0-near");

      const cppQuery = buildFtsQuery("C++ templates");
      const dotnetQuery = buildFtsQuery(".NET runtime");
      expect(store.searchL1Fts(cppQuery!, 10).map((row) => row.record_id)).toContain("l1-cpp");
      expect(store.searchL0Fts(dotnetQuery!, 10).map((row) => row.record_id)).toContain("l0-dotnet");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function legacyFallbackQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.length > 0 ? tokens.map((token) => `"${token}"`).join(" OR ") : null;
}

function createFixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
  const insert = db.prepare("INSERT INTO docs(rowid, content) VALUES (?, ?)");
  insert.run(1, "near airport hotel");
  insert.run(2, "research and development roadmap");
  insert.run(3, "logical or operator");
  insert.run(4, "service not available");
  insert.run(5, "unrelated document");
  insert.run(6, "ＮＥＡＲ ａｉｒｐｏｒｔ");
  insert.run(7, "C++ templates and concepts");
  insert.run(8, ".NET runtime internals");
  insert.run(9, "node.js streams guide");
  insert.run(10, "contact dev@example.com");
  return db;
}

function searchIds(db: DatabaseSync, query: string): number[] {
  return (db.prepare("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid").all(query) as Array<{ rowid: number }>)
    .map((row) => row.rowid);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function memoryRecord(id: string, content: string): MemoryRecord {
  const now = "2026-07-01T00:00:00.000Z";
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
    sessionKey: "test-session",
    sessionId: "test-session-id",
  };
}

function l0Record(id: string, messageText: string): L0Record {
  return {
    id,
    sessionKey: "test-session",
    sessionId: "test-session-id",
    role: "user",
    messageText,
    recordedAt: "2026-07-01T00:00:00.000Z",
    timestamp: Date.parse("2026-07-01T00:00:00.000Z"),
  };
}
