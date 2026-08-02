/**
 * P10 — feedback loop (#4): key validation, startsWith matching, capped bump.
 * DB-level tests create a throwaway vectors.db via the runtime SQLite loader.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  matchFeedbackKeys,
  validateFeedbackBody,
  bumpFeedbackPriorities,
  FEEDBACK_CAP_PER_RECORD,
} from "./feedback.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const require = createRequire(import.meta.url);

function openSqlite(dbPath: string): {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void; get(...params: unknown[]): unknown };
  close(): void;
} {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite") as { Database: new (p: string) => unknown };
    return new Database(dbPath) as unknown as ReturnType<typeof openSqlite>;
  }
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => unknown };
  return new DatabaseSync(dbPath) as unknown as ReturnType<typeof openSqlite>;
}

let tmp: string;
let dbPath: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-feedback-"));
  dbPath = path.join(tmp, "vectors.db");
  const db = openSqlite(dbPath);
  db.exec(
    "CREATE TABLE l1_records (" +
      "record_id TEXT PRIMARY KEY, content TEXT, type TEXT, priority INTEGER, scene_name TEXT, " +
      "session_key TEXT, session_id TEXT, timestamp_str TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT)",
  );
  // Near-duplicate cluster members (diverge in first 80 chars), a short
  // record (< 80 chars), and a non-matching record.
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES (?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
  ).run("m1", "Alpha cluster member one with a long enough prefix to be a full dedup key", "episodic", 50);
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES (?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
  ).run("m2", "Beta cluster member two starting differently", "episodic", 50);
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES (?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
  ).run("m3", "short", "instruction", 60);
  db.prepare(
    "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) VALUES (?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
  ).run("m4", "totally unrelated content here", "episodic", 40);
  db.close();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function priorityOf(recordId: string): number {
  const db = openSqlite(dbPath);
  try {
    const row = db.prepare("SELECT priority FROM l1_records WHERE record_id = ?").get(recordId) as
      | { priority: number }
      | undefined;
    return row?.priority ?? -1;
  } finally {
    db.close();
  }
}

describe("matchFeedbackKeys (pure)", () => {
  it("matches on trimmed content startsWith key", () => {
    const rows = [
      { record_id: "a", content: "  Alpha cluster member one with a long enough prefix to be a full dedup key" },
      { record_id: "b", content: "short" },
    ];
    const matched = matchFeedbackKeys(rows, ["Alpha cluster member one with a long enough prefix to be a full dedup key"]);
    expect(matched).toEqual(["a"]);
  });

  it("a key can match several records (cluster members)", () => {
    const rows = [
      { record_id: "a", content: "shared prefix xyz ... one" },
      { record_id: "b", content: "shared prefix xyz ... two" },
    ];
    const matched = matchFeedbackKeys(rows, ["shared prefix xyz"]);
    expect(matched.sort()).toEqual(["a", "b"]);
  });

  it("content < 80 chars still matches by startsWith", () => {
    const rows = [{ record_id: "m3", content: "short" }];
    expect(matchFeedbackKeys(rows, ["short"])).toEqual(["m3"]);
  });
});

describe("validateFeedbackBody", () => {
  it("accepts a valid keys array", () => {
    const r = validateFeedbackBody({ keys: ["abc", " def "] });
    expect(typeof r).not.toBe("string");
    expect((r as { keys: string[] }).keys).toEqual(["abc", "def"]);
  });

  it("rejects missing keys", () => {
    expect(typeof validateFeedbackBody({})).toBe("string");
    expect(typeof validateFeedbackBody(null)).toBe("string");
  });

  it("rejects non-array keys and non-string members", () => {
    expect(typeof validateFeedbackBody({ keys: "x" })).toBe("string");
    expect(typeof validateFeedbackBody({ keys: [1, 2] })).toBe("string");
  });

  it("rejects over-long keys", () => {
    expect(typeof validateFeedbackBody({ keys: ["x".repeat(300)] })).toBe("string");
  });
});

describe("bumpFeedbackPriorities (sqlite)", () => {
  it("bumps matched records, leaves unmatched untouched", () => {
    const r = bumpFeedbackPriorities(dbPath, ["Alpha cluster member one with a long enough prefix to be a full dedup key"]);
    expect(r.matched).toBe(1);
    expect(r.bumped).toBe(1);
    expect(priorityOf("m1")).toBe(51);
    expect(priorityOf("m4")).toBe(40);
  });

  it("cluster bump: ANY member key matching bumps the member record", () => {
    const r = bumpFeedbackPriorities(dbPath, ["Beta cluster member two starting differently"]);
    expect(r.bumped).toBe(1);
    expect(priorityOf("m2")).toBe(51);
  });

  it("cap: a record matched by several keys bumps at most +1 per run", () => {
    // Both keys match m1's content prefix ("Alpha" and the full prefix).
    const r = bumpFeedbackPriorities(dbPath, [
      "Alpha",
      "Alpha cluster member one with a long enough prefix to be a full dedup key",
    ]);
    expect(r.matched).toBe(1);
    expect(r.bumped).toBe(1);
    expect(priorityOf("m1")).toBe(52); // +1 from the previous test, +1 now — not +2
  });

  it("respects the cap parameter", () => {
    const r = bumpFeedbackPriorities(dbPath, ["Alpha"], 2);
    expect(r.bumped).toBe(1);
    expect(priorityOf("m1")).toBe(54);
  });

  it("no matching keys → no bump", () => {
    const r = bumpFeedbackPriorities(dbPath, ["no such content anywhere"]);
    expect(r.matched).toBe(0);
    expect(r.bumped).toBe(0);
  });

  it("empty keys → no-op", () => {
    const r = bumpFeedbackPriorities(dbPath, []);
    expect(r).toEqual({ matched: 0, bumped: 0 });
  });

  it("only positive — priority never decreases", () => {
    const before = priorityOf("m4");
    bumpFeedbackPriorities(dbPath, ["no match"]);
    expect(priorityOf("m4")).toBe(before);
    expect(FEEDBACK_CAP_PER_RECORD).toBe(1);
  });
});
