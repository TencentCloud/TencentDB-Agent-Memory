/**
 * FTS segmentation: a search must not match a word that is not there.
 *
 * jieba is a Chinese segmenter, and it used to be applied to every script on
 * BOTH sides of FTS. For a script it has no dictionary for it returns one
 * token per LETTER, so Russian documents were indexed as loose letters and a
 * Russian query became `"п" OR "о" OR "т" …` — matching nearly every Russian
 * document, with BM25 ranking noise. Found while probing tz-08's search path:
 * the query "квазимодо", a word absent from the corpus, returned a memory.
 *
 * These tests pin both halves: segmentation per script, and the one-time
 * rebuild that repairs an index written by the old one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  VectorStore,
  buildFtsQuery,
  segmentForFts,
  shouldWriteFtsMarker,
  tokenizeForFts,
} from "./sqlite.js";
import type { MemoryRecord } from "../record/l1-writer.js";

const DIMS = 4;

function vec(): Float32Array {
  const v = new Float32Array(DIMS);
  v[0] = 1;
  return v;
}

function mem(id: string, content: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "сцена",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "fts-test",
    sessionId: "fts-test",
    projectId: "",
    scope: "global",
  };
}

let dir: string;
let dbPath: string;
let store: VectorStore | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-fts-"));
  dbPath = path.join(dir, "vectors.db");
});

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* already closed */
  }
  store = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(): VectorStore {
  const s = new VectorStore(dbPath, DIMS);
  s.init();
  return s;
}

/** Search the way the product does: user text → buildFtsQuery → MATCH. */
function find(text: string): string[] {
  const query = buildFtsQuery(text);
  if (!query) return [];
  return store!.searchL1Fts(query, 10, "").map((r) => r.record_id);
}

describe("segmentation per script", () => {
  it("keeps words whole in scripts jieba has no dictionary for", () => {
    expect(segmentForFts("Пользователь любит книги")).toEqual([
      "Пользователь",
      "любит",
      "книги",
    ]);
    expect(segmentForFts("user likes books")).toEqual([
      "user",
      "likes",
      "books",
    ]);
  });

  it("still segments Chinese, including sub-words", () => {
    const tokens = segmentForFts("用户喜欢编程");
    expect(tokens).toContain("用户");
    expect(tokens).toContain("编程");
    expect(tokens.every((t) => t.length > 0)).toBe(true);
  });

  it("handles a mixed sentence without shattering either half", () => {
    expect(segmentForFts("Пользователь любит 编程 и TypeScript")).toEqual([
      "Пользователь",
      "любит",
      "编程",
      "и",
      "TypeScript",
    ]);
  });

  it("asks for whole words, not letters", () => {
    expect(buildFtsQuery("потребитель памяти")).toBe(
      '"потребитель"* OR "памяти"*',
    );
    expect(tokenizeForFts("потребитель памяти")).toBe("потребитель памяти");
  });

  it("keeps short tokens exact, so no clause matches half the corpus", () => {
    // "и"* would match every word starting with и; a two-letter prefix is not
    // a stem. Long CJK phrases stay exact too — jieba already cut them.
    expect(buildFtsQuery("и на 用户喜欢编程")).not.toContain("*");
  });

  it("has nothing to ask for when the text holds no word characters", () => {
    expect(buildFtsQuery("!!! ???")).toBeNull();
  });
});

describe("searching a Russian corpus", () => {
  it("finds a word that is there and not one that is absent", () => {
    store = open();
    store.upsertL1(
      mem("m1", "Пользователь проверяет границу потребителя памяти"),
      vec(),
    );
    store.upsertL1(mem("m2", "Обсуждали расписание отпуска"), vec());

    expect(find("потребителя")).toEqual(["m1"]);
    expect(find("отпуска")).toEqual(["m2"]);
    // The word that started this: absent from the corpus, so absent from the
    // answer. Under the old segmentation it matched both rows.
    expect(find("квазимодо")).toEqual([]);
  });

  it("finds an inflected form through its stem", () => {
    store = open();
    store.upsertL1(
      mem("m1", "Пользователь проверяет потребителя памяти"),
      vec(),
    );

    // The corpus says "потребителя"; a session asks for "потребител".
    expect(find("потребител")).toEqual(["m1"]);
    // …but a prefix is still a prefix: an unrelated stem matches nothing.
    expect(find("квазимод")).toEqual([]);
  });
});

describe("repairing an index written by the old segmentation", () => {
  /** The query pre-v3 code built for a Russian word: one clause per letter. */
  const LETTER_QUERY = [..."квазимодо"].map((c) => `"${c}"`).join(" OR ");

  /** Rewrite the FTS content the way pre-v3 code wrote it: letter by letter. */
  function shatterIndexAndForgetVersion(): void {
    const db = new DatabaseSync(dbPath);
    const rows = db
      .prepare("SELECT record_id, content_original FROM l1_fts")
      .all() as Array<{ record_id: string; content_original: string }>;
    const update = db.prepare(
      "UPDATE l1_fts SET content = ? WHERE record_id = ?",
    );
    for (const row of rows)
      update.run([...row.content_original].join(" "), row.record_id);
    db.exec("DELETE FROM embedding_meta WHERE key = 'fts_schema_version'");
    db.close();
  }

  /** Rows the old-style letter query matches, read straight from the table. */
  function letterQueryHits(): number {
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT count(*) AS n FROM l1_fts WHERE l1_fts MATCH ?")
      .get(LETTER_QUERY) as { n: number };
    db.close();
    return row.n;
  }

  function schemaVersion(): string | undefined {
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare(
        "SELECT value FROM embedding_meta WHERE key = 'fts_schema_version'",
      )
      .get() as { value: string } | undefined;
    db.close();
    return row?.value;
  }

  it("does not mark an index it could not rebuild", () => {
    // The marker is the only thing that orders the repair, so it must follow
    // what actually happened. A rebuild that failed leaves the FTS tables
    // dropped and empty; a marker over that emptiness tells every later open
    // there is nothing to repair, and the memory stays unsearchable forever.
    expect(shouldWriteFtsMarker("current", false)).toBe(true);
    expect(shouldWriteFtsMarker("rebuild-needed", true)).toBe(true);
    expect(shouldWriteFtsMarker("rebuild-needed", false)).toBe(false);
    // A check that could not run knows nothing about the index.
    expect(shouldWriteFtsMarker("unknown", false)).toBe(false);
    expect(shouldWriteFtsMarker("unknown", true)).toBe(false);
  });

  it("reports a rebuild it could not carry out", () => {
    store = open();
    store.upsertL1(mem("m1", "Пользователь проверяет границу памяти"), vec());

    // The source table disappearing mid-flight is the shape every real
    // failure takes here (a full disk, a locked database): the rebuild has
    // already cleared the FTS tables when it fails.
    const other = new DatabaseSync(dbPath);
    other.exec("ALTER TABLE l1_records RENAME TO l1_records_hidden");
    expect(store.rebuildFtsIndex()).toBe(false);

    other.exec("ALTER TABLE l1_records_hidden RENAME TO l1_records");
    other.close();
    expect(store.rebuildFtsIndex()).toBe(true);
    expect(find("памяти")).toEqual(["m1"]);
  });

  it("rebuilds once on open, then leaves the index alone", () => {
    store = open();
    store.upsertL1(mem("m1", "Пользователь проверяет границу памяти"), vec());
    store.close();

    shatterIndexAndForgetVersion();
    // The damage is observed, not assumed: with letter-shattered content the
    // old-style query for a word nobody wrote matches the row.
    expect(letterQueryHits()).toBe(1);

    store = open();
    expect(schemaVersion()).toBe("3");
    expect(letterQueryHits()).toBe(0);
    expect(find("квазимодо")).toEqual([]);
    expect(find("памяти")).toEqual(["m1"]);
    store.close();

    // Second open must NOT rebuild again: the marker is what stops a
    // full-index rebuild from happening on every single start.
    const rebuilt: string[] = [];
    const again = new VectorStore(dbPath, DIMS, {
      debug: () => undefined,
      info: (m: string) => void (m.includes("Rebuilding") && rebuilt.push(m)),
      warn: () => undefined,
      error: () => undefined,
    });
    again.init();
    store = again;
    expect(rebuilt).toEqual([]);
    expect(find("памяти")).toEqual(["m1"]);
  });
});
