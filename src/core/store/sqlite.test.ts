import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery, VectorStore } from "./sqlite.js";
import type { MemoryRecord } from "../record/l1-writer.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-sqlite-fts-"));
  tempDirs.push(dir);
  return dir;
}

function makeMemory(id: string, content: string): MemoryRecord {
  const now = "2026-07-05T00:00:00+08:00";
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "search",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "session",
    sessionId: "session-id",
  };
}

function buildLegacyFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`).filter((t) => t !== '""');
  if (quoted.length === 0) return null;
  return quoted.join(" OR ");
}

afterEach(async () => {
  _resetJiebaForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildFtsQuery", () => {
  it("keeps ordinary recall queries unchanged after sanitization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("memory sqlite user preference")).toBe(
      '"memory" OR "sqlite" OR "user" OR "preference"',
    );
    expect(buildFtsQuery("旅行计划 API TypeScript")).toBe(
      '"旅行计划" OR "API" OR "TypeScript"',
    );
  });

  it("removes FTS5 boolean operators before tokenizing user text", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("apple OR banana AND NOT cherry NEAR date")).toBe(
      '"apple" OR "banana" OR "cherry" OR "date"',
    );
  });

  it("removes FTS5 operator distance syntax and control characters", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('alpha NEAR/5 beta title:gamma -delta "quoted" (group)*')).toBe(
      '"alpha" OR "beta" OR "title" OR "gamma" OR "delta" OR "quoted" OR "group"',
    );
  });

  it("sanitizes input before jieba tokenization", () => {
    const seenInputs: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string) {
        seenInputs.push(text);
        return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
      },
    });

    expect(buildFtsQuery('memory AND sqlite NEAR/3 "injection"*')).toBe(
      '"memory" OR "sqlite" OR "injection"',
    );
    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).not.toMatch(/\b(?:AND|OR|NOT|NEAR)\b/i);
    expect(seenInputs[0]).not.toMatch(/["'()*:^{}\[\]-]/);
  });

  it("preserves words that only contain operator substrings", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("ANDROID scanner ordinary nearby")).toBe(
      '"ANDROID" OR "scanner" OR "ordinary" OR "nearby"',
    );
  });

  it("returns null when input contains only FTS5 syntax", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery('AND OR NOT NEAR/10 "()" * -')).toBeNull();
  });

  it("recalls expected FTS memories after sanitizing operator-heavy input", async () => {
    _setJiebaForTest(null);
    const dataDir = await makeTempDir();
    const store = new VectorStore(path.join(dataDir, "memory.sqlite"), 0);
    store.init({ provider: "none", model: "none", dimensions: 0 });
    try {
      store.upsertL1(makeMemory("mem-1", "memory sqlite user preference"), undefined);
      store.upsertL1(makeMemory("mem-2", "旅行计划 API TypeScript"), undefined);
      store.upsertL1(makeMemory("mem-3", "ANDROID scanner ordinary nearby"), undefined);

      const normalQuery = buildFtsQuery("memory sqlite user preference");
      const noisyQuery = buildFtsQuery('memory AND sqlite NEAR/3 user "preference"*');
      const mixedLanguageQuery = buildFtsQuery("旅行计划 API TypeScript");
      const operatorSubstringQuery = buildFtsQuery("ANDROID scanner ordinary nearby");

      expect(normalQuery).toBe('"memory" OR "sqlite" OR "user" OR "preference"');
      expect(noisyQuery).toBe('"memory" OR "sqlite" OR "user" OR "preference"');
      expect(mixedLanguageQuery).toBe('"旅行计划" OR "API" OR "TypeScript"');
      expect(operatorSubstringQuery).toBe('"ANDROID" OR "scanner" OR "ordinary" OR "nearby"');

      expect(store.searchL1Fts(normalQuery!, 5).map((r) => r.record_id)).toEqual(["mem-1"]);
      expect(store.searchL1Fts(noisyQuery!, 5).map((r) => r.record_id)).toEqual(["mem-1"]);
      expect(store.searchL1Fts(mixedLanguageQuery!, 5).map((r) => r.record_id)).toEqual(["mem-2"]);
      expect(store.searchL1Fts(operatorSubstringQuery!, 5).map((r) => r.record_id)).toEqual(["mem-3"]);
    } finally {
      store.close();
    }
  });

  it("prints real recall output parity between legacy and sanitized FTS query builders", async () => {
    _setJiebaForTest(null);
    const dataDir = await makeTempDir();
    const store = new VectorStore(path.join(dataDir, "memory.sqlite"), 0);
    store.init({ provider: "none", model: "none", dimensions: 0 });
    try {
      const memories = [
        makeMemory("mem-1", "memory sqlite user preference"),
        makeMemory("mem-2", "旅行计划 API TypeScript"),
        makeMemory("mem-3", "ANDROID scanner ordinary nearby"),
        makeMemory("mem-4", "project issue recall screenshot comparison"),
      ];
      for (const memory of memories) {
        store.upsertL1(memory, undefined);
      }

      const cases = [
        "memory sqlite user preference",
        "旅行计划 API TypeScript",
        "ANDROID scanner ordinary nearby",
        "project recall screenshot comparison",
        'memory AND sqlite NEAR/3 user "preference"*',
      ];

      const comparison = cases.map((rawQuery) => {
        const legacyQuery = buildLegacyFtsQuery(rawQuery);
        const sanitizedQuery = buildFtsQuery(rawQuery);
        const legacyRows = legacyQuery ? store.searchL1Fts(legacyQuery, 10) : [];
        const sanitizedRows = sanitizedQuery ? store.searchL1Fts(sanitizedQuery, 10) : [];
        return {
          rawQuery,
          legacyQuery,
          sanitizedQuery,
          legacyRecall: legacyRows.map((r) => ({ id: r.record_id, content: r.content })),
          sanitizedRecall: sanitizedRows.map((r) => ({ id: r.record_id, content: r.content })),
        };
      });

      console.log("\nFTS recall parity: legacy vs sanitized");
      console.log(JSON.stringify(comparison, null, 2));

      for (const item of comparison) {
        expect(item.sanitizedRecall.map((r) => r.id)).toEqual(item.legacyRecall.map((r) => r.id));
        expect(item.sanitizedRecall.map((r) => r.content)).toEqual(item.legacyRecall.map((r) => r.content));
      }
    } finally {
      store.close();
    }
  });
});
