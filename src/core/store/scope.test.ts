/**
 * Project-scoping tests: memories tagged scope='project' must be invisible to
 * other projects, while global / legacy records stay visible everywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "./sqlite.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import { passesScope } from "../hooks/auto-recall.js";

const DIMS = 4;

function vec(seed: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
}

function mem(id: string, content: string, scope: "global" | "project", projectId: string): MemoryRecord {
  const now = new Date().toISOString();
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
    sessionKey: "cc-test",
    sessionId: "cc-test",
    projectId,
    scope,
  };
}

let dir: string;
let dbPath: string;
let store: VectorStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-scope-"));
  dbPath = path.join(dir, "vectors.db");
});

afterEach(() => {
  try { store?.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(): VectorStore {
  const s = new VectorStore(dbPath, DIMS);
  s.init();
  return s;
}

describe("project scoping", () => {
  it("hides foreign project memories from FTS and vector search, keeps global ones", () => {
    store = open();
    store.upsertL1(mem("m_a", "alpha widget deployment", "project", "/repo/a"), vec(0));
    store.upsertL1(mem("m_b", "alpha widget deployment", "project", "/repo/b"), vec(0));
    store.upsertL1(mem("m_g", "alpha widget deployment", "global", "/repo/b"), vec(0));

    const fts = store.searchL1Fts("alpha", 10, "/repo/a").map((r) => r.record_id).sort();
    expect(fts).toEqual(["m_a", "m_g"]);

    const vecHits = store.searchL1Vector(vec(0), 10, undefined, "/repo/a").map((r) => r.record_id).sort();
    expect(vecHits).toEqual(["m_a", "m_g"]);
  });

  it("returns everything when projectId is empty (filter disabled)", () => {
    store = open();
    store.upsertL1(mem("m_a", "alpha widget", "project", "/repo/a"), vec(0));
    store.upsertL1(mem("m_b", "alpha widget", "project", "/repo/b"), vec(0));

    expect(store.searchL1Fts("alpha", 10).length).toBe(2);
    expect(store.searchL1Vector(vec(0), 10).length).toBe(2);
  });

  it("migrates a pre-scoping database and grandfathers old rows as visible", () => {
    // Build an old-schema DB: l1_records without project_id / scope.
    store = open();
    store.upsertL1(mem("m_old", "legacy note", "global", ""), vec(0));
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP INDEX IF EXISTS idx_l1_scope_project");
    raw.exec("ALTER TABLE l1_records DROP COLUMN project_id");
    raw.exec("ALTER TABLE l1_records DROP COLUMN scope");
    raw.close();

    store = open(); // migration runs here
    expect(store.searchL1Fts("legacy", 10, "/repo/a").map((r) => r.record_id)).toEqual(["m_old"]);

    // Idempotent: re-opening an already-migrated DB must not throw or lose data.
    store.close();
    store = open();
    expect(store.searchL1Fts("legacy", 10, "/repo/a").length).toBe(1);
  });
});

describe("passesScope", () => {
  it("mirrors the SQL filter", () => {
    expect(passesScope({ scope: "project", project_id: "/a" }, "")).toBe(true);
    expect(passesScope({ scope: "project", project_id: "/a" }, "/a")).toBe(true);
    expect(passesScope({ scope: "project", project_id: "/a" }, "/b")).toBe(false);
    expect(passesScope({ scope: "global", project_id: "/a" }, "/b")).toBe(true);
    expect(passesScope({}, "/b")).toBe(true); // legacy / non-sqlite backend
  });
});
