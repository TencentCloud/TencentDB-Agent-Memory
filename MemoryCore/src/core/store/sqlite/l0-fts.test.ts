import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { VectorStore } from "./memory-store.js";
import type { L0Record } from "../types.js";

let dir: string;
let store: VectorStore;

function open() {
  const instance = new VectorStore(join(dir, "test.db"), 0);
  instance.init();
  expect(instance.isFtsAvailable()).toBe(true);
  return instance;
}

function write(id: string, text: string, fields: Partial<L0Record> = {}) {
  const record: L0Record = {
    id, sessionKey: "s", sessionId: "s", role: "user", messageText: text,
    recordedAt: "2026-01-05", timestamp: 0, teamId: "t", agentId: "a", ...fields,
  };
  expect(store.upsertL0(record, undefined)).toBe(true);
}

function matches(term: string) {
  return store.searchL0Fts(term, 10).map(hit => hit.record_id).sort();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-l0-search-"));
  store = open();
});
afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

it("locates the search document by its unique record ID and preserves its docid on update", () => {
  const db = store.getRawDb();
  write("one", "orchard");
  const docid = db.prepare("SELECT docid FROM l0_fts_documents WHERE record_id = ?");
  const original = docid.get("one");
  expect(original).toBeDefined();
  write("one", "harbor");
  expect(docid.get("one")).toEqual(original);
  const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM l0_fts_documents WHERE record_id = ?").all("one");
  expect(plan.map(row => row.detail).join(" ")).toMatch(/SEARCH .*INDEX .*record_id=/);
  expect(matches("orchard")).toEqual([]);
  expect(matches("harbor")).toEqual(["one"]);
});

it("rolls back a failed search-document write and permits a clean retry and deletion", () => {
  const db = store.getRawDb();
  const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'l0_search_insert'").get();
  db.exec(`
    DROP TRIGGER l0_search_insert;
    CREATE TRIGGER l0_search_insert AFTER INSERT ON l0_fts_documents BEGIN
      INSERT INTO l0_fts(rowid, message_text) VALUES (new.docid, new.message_text);
      SELECT RAISE(ABORT, 'injected failure after indexing');
    END;
  `);
  write("retry", "orchard");
  expect(db.prepare("SELECT record_id FROM l0_conversations").get()?.record_id).toBe("retry");
  expect(db.prepare("SELECT docid FROM l0_fts_documents").get()).toBeUndefined();
  expect(matches("orchard")).toEqual([]);
  db.exec("INSERT INTO l0_fts(l0_fts, rank) VALUES ('integrity-check', 1)");
  db.exec("DROP TRIGGER l0_search_insert");
  db.exec(String(trigger?.sql));
  write("retry", "harbor");
  expect(matches("harbor")).toEqual(["retry"]);
  expect(store.deleteL0("retry")).toBe(true);
  expect(matches("harbor")).toEqual([]);
  db.exec("INSERT INTO l0_fts(l0_fts, rank) VALUES ('integrity-check', 1)");
});

it("does not serve the old text or identity after an indexing failure on update", () => {
  write("move", "orchard");
  const db = store.getRawDb();
  db.exec(`CREATE TEMP TRIGGER reject_edit BEFORE UPDATE ON l0_fts_documents
    BEGIN SELECT RAISE(ABORT, 'injected update error'); END`);
  write("move", "harbor", { agentId: "b" });
  expect(matches("orchard")).toEqual([]);
  expect(matches("harbor")).toEqual([]);
  db.exec("DROP TRIGGER reject_edit");
  write("move", "harbor", { agentId: "b" });
  expect(store.searchL0Fts("harbor", 10, { agentId: "a" })).toEqual([]);
  expect(store.searchL0Fts("harbor", 10, { agentId: "b" }).map(hit => hit.record_id)).toEqual(["move"]);
});

it("removes only the matching documents during expiry, session deletion and scoped clear", () => {
  write("old", "maple", { recordedAt: "2025-12-01" });
  write("session", "maple", { sessionKey: "other", sessionId: "other" });
  write("clear", "maple");
  write("keep", "maple", { agentId: "b" });
  expect(store.deleteL0Expired("2026-01-01")).toBe(1);
  expect(matches("maple")).toEqual(["clear", "keep", "session"]);
  expect(store.deleteL0BySession("other")).toBe(1);
  store.clearMemoryContent({ teamId: "t", agentId: "a" });
  expect(matches("maple")).toEqual(["keep"]);
  store.rebuildFtsIndex();
  expect(matches("maple")).toEqual(["keep"]);
});

it("upgrades a standalone FTS index using the canonical messages and survives reopening", () => {
  write("one", "orchard harvest");
  const db = store.getRawDb();
  // Legacy indexes may contain duplicates or expired documents with no metadata.
  db.exec(`
    DROP TABLE IF EXISTS l0_fts_documents;
    DROP TABLE l0_fts;
    CREATE VIRTUAL TABLE l0_fts USING fts5(message_text, message_text_original UNINDEXED,
      record_id UNINDEXED, session_key UNINDEXED, session_id UNINDEXED, team_id UNINDEXED,
      task_id UNINDEXED, user_id UNINDEXED, agent_id UNINDEXED, role UNINDEXED,
      recorded_at UNINDEXED, timestamp UNINDEXED);
    INSERT INTO l0_fts(message_text, record_id) VALUES ('obsolete', 'one'), ('obsolete', 'one'), ('orphan', 'missing');
  `);
  store.close();
  store = open();
  expect(matches("orchard")).toEqual(["one"]);
  expect(matches("obsolete")).toEqual([]);
  expect(matches("orphan")).toEqual([]);
  store.close();
  store = open();
  write("one", "harbor");
  expect(matches("harbor")).toEqual(["one"]);
  expect(matches("orchard")).toEqual([]);
});

it("restores the previous index if upgrade fails, then retries on the next open", () => {
  write("m", "cedar");
  const db = store.getRawDb();
  db.exec(`
    DROP TABLE l0_fts_documents;
    DROP TABLE l0_fts;
    CREATE VIRTUAL TABLE l0_fts USING fts5(message_text, record_id UNINDEXED);
    INSERT INTO l0_fts VALUES ('cedar', 'm');
    CREATE TRIGGER l0_search_update AFTER UPDATE ON l0_conversations BEGIN SELECT 1; END;
  `);
  store.close();
  store = new VectorStore(join(dir, "test.db"), 0);
  store.init();
  expect(store.isFtsAvailable()).toBe(false);
  const rolledBack = store.getRawDb();
  expect(rolledBack.prepare("SELECT record_id FROM l0_fts WHERE l0_fts MATCH 'cedar'").get()?.record_id).toBe("m");
  expect(rolledBack.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'l0_fts_documents'").get()).toBeUndefined();
  rolledBack.exec("DROP TRIGGER l0_search_update");
  store.close();
  store = open();
  expect(matches("cedar")).toEqual(["m"]);
});
