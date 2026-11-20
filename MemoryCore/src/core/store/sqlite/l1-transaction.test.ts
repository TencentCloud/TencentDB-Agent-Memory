import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "./memory-store.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const original: MemoryRecord = {
  id: "memory-a",
  content: "original searchable memory",
  type: "work_fact",
  priority: 70,
  scene_name: "Atlas",
  source_message_ids: [],
  metadata: {},
  timestamps: ["2026-11-05T00:00:00Z"],
  createdAt: "2026-11-05T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
  teamId: "team-a",
  userId: "user-a",
  agentId: "agent-a",
  sessionKey: "session-a",
  sessionId: "session-a",
  taskId: "task-a",
};
const replacement = { ...original, content: "replacement searchable memory" };

describe("shared SQLite L1 transaction boundary", () => {
  let dir: string, store: VectorStore, reader: DatabaseSync | undefined;
  const db = () => store.getRawDb();
  const meta = () =>
    db()
      .prepare("SELECT record_id, content FROM l1_records ORDER BY record_id")
      .all();
  const fts = () =>
    db()
      .prepare(
        "SELECT record_id, content_original FROM l1_fts ORDER BY record_id",
      )
      .all();
  const vectors = () =>
    db()
      .prepare("SELECT record_id, embedding FROM l1_vec ORDER BY record_id")
      .all();
  beforeEach(() => {
    reader = undefined;
    dir = mkdtempSync(path.join(tmpdir(), "l1-transaction-"));
    const file = path.join(dir, "vectors.db");
    store = new VectorStore(file, 3);
    store.init();
    expect(store.isDegraded()).toBe(false);
    expect(store.upsertL1(original, new Float32Array([1, 0, 0]))).toBe(true);
    reader = new DatabaseSync(file, { readOnly: true });
  });
  afterEach(() => {
    try {
      db().exec("ROLLBACK");
    } catch {
      /* No open transaction. */
    }
    try {
      reader?.close();
    } finally {
      try {
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  const expectOriginal = (beforeVectors: unknown) => {
    expect(meta()).toEqual([
      { record_id: "memory-a", content: "original searchable memory" },
    ]);
    expect(fts()).toEqual([
      { record_id: "memory-a", content_original: "original searchable memory" },
    ]);
    expect(vectors()).toEqual(beforeVectors);
  };

  it("commits ordinary metadata, FTS and vector writes for another connection", () => {
    expect(store.upsertL1(replacement, new Float32Array([0, 1, 0]))).toBe(true);
    expect(
      reader!
        .prepare("SELECT content FROM l1_records WHERE record_id='memory-a'")
        .get()?.content,
    ).toBe("replacement searchable memory");
    expect(fts()).toEqual([
      {
        record_id: "memory-a",
        content_original: "replacement searchable memory",
      },
    ]);
    expect(
      new Float32Array((vectors()[0].embedding as Uint8Array).slice().buffer),
    ).toEqual(new Float32Array([0, 1, 0]));
  });

  it("restores metadata and the deleted vector when vector insertion fails outside replay", () => {
    const beforeVectors = vectors();
    // A real sqlite-vec dimension error occurs after metadata update and vector deletion.
    expect(store.upsertL1(replacement, new Float32Array([0, 1]))).toBe(false);
    expectOriginal(beforeVectors);
    expect(store.upsertL1(replacement, new Float32Array([0, 1, 0]))).toBe(true);
    expect(meta()[0].content).toBe("replacement searchable memory");
    // A leaked failed savepoint would keep this retry uncommitted even though
    // the write connection can read it. Verify visibility from another reader.
    expect(
      reader!
        .prepare("SELECT content FROM l1_records WHERE record_id='memory-a'")
        .get()?.content,
    ).toBe("replacement searchable memory");
  });

  it("keeps a successful inner upsert invisible until the caller commits and permits outer rollback", () => {
    const beforeVectors = vectors();
    db().exec("BEGIN IMMEDIATE");
    expect(store.upsertL1(replacement, new Float32Array([0, 1, 0]))).toBe(true);
    expect(meta()[0].content).toBe("replacement searchable memory");
    expect(
      reader!
        .prepare("SELECT content FROM l1_records WHERE record_id='memory-a'")
        .get()?.content,
    ).toBe("original searchable memory");
    db().exec("ROLLBACK");
    expectOriginal(beforeVectors);
  });

  it("rolls back only its failed write and lets the caller commit unrelated earlier work", () => {
    const beforeVectors = vectors();
    db().exec(
      "CREATE TABLE caller_work(value TEXT); BEGIN IMMEDIATE; INSERT INTO caller_work VALUES ('keep')",
    );
    expect(store.upsertL1(replacement, new Float32Array([0, 1]))).toBe(false);
    expectOriginal(beforeVectors);
    expect(db().prepare("SELECT value FROM caller_work").all()).toEqual([
      { value: "keep" },
    ]);
    expect(
      store.upsertL1(
        { ...original, id: "memory-b", content: "later valid write" },
        new Float32Array([0, 0, 1]),
      ),
    ).toBe(true);
    db().exec("COMMIT");
    expect(reader!.prepare("SELECT value FROM caller_work").all()).toEqual([
      { value: "keep" },
    ]);
    expect(
      reader!
        .prepare("SELECT content FROM l1_records WHERE record_id='memory-b'")
        .get()?.content,
    ).toBe("later valid write");
    expect(store.upsertL1(replacement, new Float32Array([0, 1, 0]))).toBe(true);
  });

  it("preserves ordinary best-effort FTS behavior and repairs the index on retry", () => {
    db().exec("ALTER TABLE l1_fts RENAME TO unavailable_l1_fts");
    expect(store.upsertL1(replacement, new Float32Array([0, 1, 0]))).toBe(true);
    expect(
      reader!
        .prepare("SELECT content FROM l1_records WHERE record_id='memory-a'")
        .get()?.content,
    ).toBe("replacement searchable memory");
    db().exec("ALTER TABLE unavailable_l1_fts RENAME TO l1_fts");
    expect(fts()[0].content_original).toBe("original searchable memory");
    expect(store.upsertL1(replacement, new Float32Array([0, 1, 0]))).toBe(true);
    expect(fts()[0].content_original).toBe("replacement searchable memory");
  });
});
