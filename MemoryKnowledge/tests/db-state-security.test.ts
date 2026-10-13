import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDb } from "../src/db/client.js";

describe("SQLite state protection", () => {
  it("creates private state and preserves existing records while restricting file modes", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-db-state-"));
    try {
      const path = join(root, "data", "memory.db");
      const first = createDb({ path });
      first.raw.exec("CREATE TABLE synthetic_memory (value TEXT); INSERT INTO synthetic_memory VALUES ('preserved')");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(path + "-wal").mode & 0o777).toBe(0o600);
      expect(statSync(path + "-shm").mode & 0o777).toBe(0o600);
      first.raw.close();
      const reopened = createDb({ path });
      expect(reopened.raw.prepare("SELECT value FROM synthetic_memory").get()).toEqual({ value: "preserved" });
      reopened.raw.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects symlink state before SQLite opens the target", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-db-link-"));
    try {
      const target = join(root, "target");
      writeFileSync(target, "synthetic-canary");
      symlinkSync(target, join(root, "db"));
      expect(() => createDb({ path: join(root, "db") })).toThrow("regular file");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses destructive migration and retains legacy credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-db-legacy-"));
    try {
      const path = join(root, "memory.db");
      const old = new Database(path);
      old.exec("CREATE TABLE knowledge_source_credential (user_id TEXT, cred_secret TEXT); INSERT INTO knowledge_source_credential VALUES ('synthetic-user', 'synthetic-secret')");
      old.close();
      expect(() => createDb({ path })).toThrow("explicit offline migration");
      const check = new Database(path, { readonly: true });
      expect(check.prepare("SELECT * FROM knowledge_source_credential").get()).toEqual({ user_id: "synthetic-user", cred_secret: "synthetic-secret" });
      check.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
