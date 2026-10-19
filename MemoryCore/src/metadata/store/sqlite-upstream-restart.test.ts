/**
 * Upstream groups must survive a Memory Core restart in sqlite mode.
 * A restart re-runs the schema setup on the same database file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

describe("SqliteMetadataStore restart", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meta-upstream-restart-"));
    dbPath = path.join(dir, "metadata.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a custom upstream group after the store is closed and opened again", () => {
    const first = new SqliteMetadataStore(dbPath);
    first.init();
    const created = first.createInstanceUpstreamGroup({
      group_type: "custom",
      name: "team-group",
      agents: ["claude-code"],
      mode: "custom_unified",
      base_url: "https://upstream.example.test",
      api_key: "test-key",
      model_id: "test-model",
    });
    first.close();

    const second = new SqliteMetadataStore(dbPath);
    second.init();
    try {
      const reloaded = second.getInstanceUpstreamGroup(created.group_id);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.name).toBe("team-group");
      expect(reloaded?.agents).toEqual(["claude-code"]);
      expect(reloaded?.mode).toBe("custom_unified");
      expect(reloaded?.api_key).toBe("test-key");
      expect(second.listInstanceUpstreamGroups().map((g) => g.group_id)).toContain(created.group_id);
    } finally {
      second.close();
    }
  });

  it("replaces a table that still has the old v1 shape", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE meta_instance_upstream_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_source TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO meta_instance_upstream_config (agent_source, base_url) VALUES ('claude-code', 'https://old.example.test');
    `);
    raw.close();

    const store = new SqliteMetadataStore(dbPath);
    store.init();
    try {
      expect(store.listInstanceUpstreamGroups()).toEqual([]);
      const created = store.createInstanceUpstreamGroup({
        group_type: "custom",
        name: "after-upgrade",
        mode: "custom_unified",
      });
      expect(store.getInstanceUpstreamGroup(created.group_id)?.name).toBe("after-upgrade");
    } finally {
      store.close();
    }
  });
});
