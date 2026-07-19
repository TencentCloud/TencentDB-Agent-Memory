import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer.js";
import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  VectorStore,
} from "./sqlite.js";

const FULL_TEXT = "\u6211\u559c\u6b22\u5317\u4eac\u70e4\u9e2d";
const SUBWORD = "\u70e4\u9e2d";

function fakeJiebaTokens(text: string): string[] {
  if (text === FULL_TEXT) {
    return ["\u6211", "\u559c\u6b22", "\u5317\u4eac", SUBWORD, "\u5317\u4eac\u70e4\u9e2d"];
  }
  return [text];
}

function makeL1Record(id: string): MemoryRecord {
  return {
    id,
    content: FULL_TEXT,
    type: "episodic",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-07-13T00:00:00.000Z"],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    sessionKey: "session-key",
    sessionId: "session-id",
  };
}

describe("FTS tokenizer fingerprint", () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "tdai-fts-tokenizer-"));
    dbPath = join(testDir, "memory.db");
  });

  afterEach(async () => {
    _resetJiebaForTest();
    await rm(testDir, { recursive: true, force: true });
  });

  it("rebuilds fallback-indexed L1 text when jieba becomes available", () => {
    _setJiebaForTest(null);
    const fallbackStore = new VectorStore(dbPath, 0);
    fallbackStore.init();
    expect(
      fallbackStore.upsertL1(makeL1Record("l1-tokenizer-drift"), undefined),
    ).toBe(true);
    expect(fallbackStore.searchL1Fts(`"${SUBWORD}"`)).toHaveLength(0);
    fallbackStore.close();

    _setJiebaForTest({ cutForSearch: fakeJiebaTokens });
    const jiebaStore = new VectorStore(dbPath, 0);
    jiebaStore.init();

    const query = buildFtsQuery(SUBWORD);
    expect(query).not.toBeNull();
    expect(jiebaStore.searchL1Fts(query!)).toHaveLength(1);
    jiebaStore.close();
  });

  it("rebuilds jieba-indexed L0 text when fallback becomes active", () => {
    _setJiebaForTest({ cutForSearch: fakeJiebaTokens });
    const jiebaStore = new VectorStore(dbPath, 0);
    jiebaStore.init();
    expect(
      jiebaStore.upsertL0(
        {
          id: "l0-tokenizer-drift",
          sessionKey: "session-key",
          sessionId: "session-id",
          role: "user",
          messageText: FULL_TEXT,
          recordedAt: "2026-07-13T00:00:00.000Z",
          timestamp: 1,
        },
        undefined,
      ),
    ).toBe(true);
    expect(jiebaStore.searchL0Fts(`"${FULL_TEXT}"`)).toHaveLength(0);
    jiebaStore.close();

    _setJiebaForTest(null);
    const fallbackStore = new VectorStore(dbPath, 0);
    fallbackStore.init();

    const query = buildFtsQuery(FULL_TEXT);
    expect(query).not.toBeNull();
    expect(fallbackStore.searchL0Fts(query!)).toHaveLength(1);
    fallbackStore.close();
  });

  it("rebuilds an existing index when the tokenizer fingerprint is missing", () => {
    _setJiebaForTest(null);
    const originalStore = new VectorStore(dbPath, 0);
    originalStore.init();
    expect(
      originalStore.upsertL1(makeL1Record("l1-legacy-index"), undefined),
    ).toBe(true);
    originalStore.close();

    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM l1_fts; DELETE FROM fts_meta");
    db.close();

    const reopenedStore = new VectorStore(dbPath, 0);
    reopenedStore.init();

    const query = buildFtsQuery(FULL_TEXT);
    expect(query).not.toBeNull();
    expect(reopenedStore.searchL1Fts(query!)).toHaveLength(1);
    reopenedStore.close();
  });
});
