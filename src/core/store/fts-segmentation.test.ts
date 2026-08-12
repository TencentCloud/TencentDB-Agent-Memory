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
  _resetJiebaForTest,
  _setJiebaForTest,
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

function l0(id: string, messageText: string) {
  return {
    id,
    sessionKey: "fts-test",
    sessionId: "fts-test",
    role: "user",
    messageText,
    recordedAt: new Date().toISOString(),
    timestamp: Date.now(),
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

  it("keeps words whole in the other scripts jieba has no dictionary for", () => {
    // Korean writes spaces; Japanese does not. Both used to go to jieba,
    // which returned one token per codepoint, so a Korean query for a word
    // nobody wrote matched documents the same way a Russian one did.
    expect(segmentForFts("한국어 문서입니다")).toEqual([
      "한국어",
      "문서입니다",
    ]);
    expect(segmentForFts("日本語のテストです")).toContain("テスト");
    // Prefix or not, three syllables borrowed from three different words are
    // still one token, not three — the corpus leg below is what pins the rest.
    expect(buildFtsQuery("어사고")).toContain('"어사고"');
  });

  it("does not find a Korean word nobody wrote", () => {
    store = open();
    store.upsertL1(mem("m1", "한국어 문서입니다"), vec());
    store.upsertL1(mem("m2", "고양이 사진 저장"), vec());

    expect(find("문서")).toEqual(["m1"]);
    expect(find("문서입니다")).toEqual(["m1"]);
    expect(find("고양이")).toEqual(["m2"]);
    // Three syllables borrowed from three different words.
    expect(find("어사고")).toEqual([]);
  });

  it("does not find a Japanese phrase nobody wrote", () => {
    // The kanji islands of a Japanese sentence used to go to jieba, which has
    // no Japanese dictionary and returned them one character at a time
    // ("検索" → "検", "索"), while the kana particles between them survived as
    // one-character tokens. "パンを食べる" — bread, eaten, in a corpus about
    // neither — then matched both documents through "を" and "食".
    store = open();
    store.upsertL1(mem("m1", "日本語のテキストを検索する"), vec());
    store.upsertL1(mem("m2", "猫の写真を保存した"), vec());

    expect(find("パンを食べる")).toEqual([]);
    expect(find("検索")).toEqual(["m1"]);
    expect(find("日本語")).toEqual(["m1"]);
    expect(find("写真")).toEqual(["m2"]);
  });

  it("drops the lone kana particles that match everything", () => {
    const tokens = segmentForFts("日本語のテキストを検索する");
    expect(tokens).toContain("検索");
    expect(tokens).toContain("テキスト");
    expect(tokens).not.toContain("の");
    expect(tokens).not.toContain("を");
    // …and a kanji word stays whole instead of becoming its own characters.
    expect(tokens).not.toContain("検");
  });

  it("indexes the same way it queries even without jieba", () => {
    // The index used to keep raw runs when jieba was missing while the query
    // still asked for pieces of them: a search that answers nothing, quietly.
    _setJiebaForTest(null);
    try {
      const text = "日本語のテストです";
      expect(tokenizeForFts(text).split(" ")).toEqual(segmentForFts(text));
      expect(tokenizeForFts(text)).toContain("テスト");
    } finally {
      _resetJiebaForTest();
    }
  });

  it("offers prefixes to Korean, which inflects at the end like Russian", () => {
    // Hangul and kana are cut by the word breaker, not by jieba, so their
    // tokens are words and a prefix of one is a stem — unlike Han, where a
    // "word" is a character or two and a prefix would be half of it.
    expect(buildFtsQuery("문서입니다")).toBe('"문서입니다"*');
    // Two syllables are already a word in Korean, where two Cyrillic letters
    // are not — the stem a reader types has to reach the inflected form.
    expect(buildFtsQuery("문서")).toBe('"문서"*');
    expect(buildFtsQuery("на")).toBe('"на"');
    expect(buildFtsQuery("用户喜欢编程")).not.toContain("*");
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

  /** The state a build without fts5, or a crash before the rebuild, leaves. */
  function dropFtsTablesAndVersion(): void {
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE IF EXISTS l1_fts");
    db.exec("DROP TABLE IF EXISTS l0_fts");
    db.exec("DELETE FROM embedding_meta WHERE key = 'fts_schema_version'");
    db.close();
  }

  function ftsRowCounts(): { l1: number; l0: number } {
    const db = new DatabaseSync(dbPath);
    const count = (table: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
        .n;
    const counts = { l1: count("l1_fts"), l0: count("l0_fts") };
    db.close();
    return counts;
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

  it("rebuilds a conversation-only database, which has no L1 rows at all", () => {
    // Extraction disabled or no model configured: l1_records stays empty while
    // /capture and /memory/note keep filling l0_conversations. Looking at L1
    // alone would call that "nothing to rebuild" and mark the index current,
    // leaving conversation search dead for good.
    store = open();
    store.upsertL0(
      l0("c1", "Пользователь спрашивал про границу памяти"),
      undefined,
    );
    store.close();

    dropFtsTablesAndVersion();

    store = open();
    expect(schemaVersion()).toBe("4");
    const hits = store.searchL0Fts(buildFtsQuery("памяти")!, 10);
    expect(hits.map((r) => r.record_id)).toEqual(["c1"]);
  });

  it("repairs one FTS table that went missing while the other stayed", () => {
    store = open();
    store.upsertL1(mem("m1", "Пользователь проверяет границу памяти"), vec());
    store.upsertL0(l0("c1", "Пользователь спрашивал про отпуск"), undefined);
    store.close();

    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE l0_fts");
    db.close();

    // l1_fts is present and marked current, so a check that looks only at it
    // would skip the repair and l0_fts would stay empty forever.
    store = open();
    expect(ftsRowCounts()).toEqual({ l1: 1, l0: 1 });
    expect(
      store.searchL0Fts(buildFtsQuery("отпуск")!, 10).map((r) => r.record_id),
    ).toEqual(["c1"]);
    expect(find("памяти")).toEqual(["m1"]);
  });

  it("repairs a table of the old shape even when the other one is gone", () => {
    // The state a build without fts5, or an interrupted migration, leaves: an
    // l1_fts of the v1 shape and no l0_fts. The insert names a column the old
    // table does not have, so leaving it in place fails init on EVERY open —
    // keyword search dead, and no marker to tell anyone why.
    store = open();
    store.upsertL1(mem("m1", "Пользователь проверяет границу памяти"), vec());
    store.close();

    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE l1_fts");
    db.exec("DROP TABLE l0_fts");
    db.exec("CREATE VIRTUAL TABLE l1_fts USING fts5(content, record_id)");
    db.exec("DELETE FROM embedding_meta WHERE key = 'fts_schema_version'");
    db.close();

    store = open();
    expect(schemaVersion()).toBe("4");
    expect(find("памяти")).toEqual(["m1"]);
  });

  it("rebuilds when the runtime's own segmenters have changed", () => {
    store = open();
    store.upsertL1(mem("m1", "Пользователь проверяет границу памяти"), vec());
    store.close();

    // An index written elsewhere — another Node build, a missing jieba — is
    // not this runtime's index: the two sides would disagree on every word.
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO embedding_meta (key, value) VALUES ('fts_tokenizer', 'jieba=off,words=regex') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
    db.exec("DELETE FROM l1_fts");
    db.close();

    store = open();
    expect(ftsRowCounts().l1).toBe(1);
    expect(find("памяти")).toEqual(["m1"]);
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
    expect(schemaVersion()).toBe("4");
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
