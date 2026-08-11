/**
 * tz-05 Ф4 — the scope predicate exists three times: `passesScope` in JS, the
 * SQL mirror inside the FTS statement, and the post-KNN filter on the vector
 * path. They are only useful while they agree, so this table drives all three
 * from one set of expectations.
 *
 * The record that separates the modes is the one with no scope at all: `hidden`
 * lets it through as global (today's behaviour, the rollback path), `strict`
 * does not (критерий 5).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "./sqlite.js";
import { passesScope, type ScopeMode } from "../hooks/auto-recall/scope.js";
import type { MemoryRecord } from "../record/l1-writer.js";

const DIMS = 8;
const PROJECT = "/repo/own";
const OTHER = "/repo/other";
const TEXT = "deployment checklist alpha";

/** One vector per record; identical, so the KNN cannot reorder the outcome. */
const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);

const CLASSES = [
  { id: "own", scope: "project", project_id: PROJECT },
  { id: "other", scope: "project", project_id: OTHER },
  { id: "global", scope: "global", project_id: OTHER },
  { id: "unset", scope: undefined, project_id: PROJECT },
] as const;

/** Expected visibility from the query project, per mode. */
const EXPECTED: Record<ScopeMode, string[]> = {
  hidden: ["own", "global", "unset"],
  strict: ["own", "global"],
  decay: ["own", "other", "global", "unset"],
};

function record(
  id: string,
  scope: string | undefined,
  projectId: string,
): MemoryRecord {
  return {
    id,
    content: TEXT,
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-12T00:00:00.000Z"],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    sessionKey: "test",
    sessionId: "test",
    projectId,
    ...(scope ? { scope } : {}),
  } as MemoryRecord;
}

describe("scope predicate agrees across its three implementations", () => {
  let tmp: string;
  let store: VectorStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scope-sync-"));
    store = new VectorStore(path.join(tmp, "vectors.db"), DIMS);
    await store.init();
    for (const c of CLASSES)
      await store.upsertL1(record(c.id, c.scope, c.project_id), VEC);
    // The writer defaults a missing scope to 'global' (sqlite.ts:1178), so the
    // legacy class cannot be produced through it — and the live DB indeed holds
    // none (45 global + 327 project, measured 2026-08-12). It only exists as a
    // row written before the column did, which is reproduced here directly.
    const raw = new DatabaseSync(path.join(tmp, "vectors.db"));
    raw
      .prepare("UPDATE l1_records SET scope = NULL WHERE record_id = 'unset'")
      .run();
    raw.close();
  });

  afterEach(async () => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(["hidden", "strict", "decay"] as const)(
    "JS predicate matches the table in %s",
    (mode) => {
      const visible = CLASSES.filter((c) => passesScope(c, PROJECT, mode)).map(
        (c) => c.id,
      );
      expect(visible.sort()).toEqual([...EXPECTED[mode]].sort());
    },
  );

  it.each(["hidden", "strict", "decay"] as const)(
    "SQL mirror matches the table in %s",
    async (mode) => {
      const hits = await store.searchL1Fts("alpha", 20, PROJECT, mode);
      expect(hits.map((h) => h.record_id).sort()).toEqual(
        [...EXPECTED[mode]].sort(),
      );
    },
  );

  it.each(["hidden", "strict", "decay"] as const)(
    "vector path matches the table in %s",
    async (mode) => {
      const hits = await store.searchL1Vector(VEC, 20, TEXT, PROJECT, mode);
      expect(hits.map((h) => h.record_id).sort()).toEqual(
        [...EXPECTED[mode]].sort(),
      );
    },
  );

  it("an empty project id disables filtering in every mode", async () => {
    for (const mode of ["hidden", "strict", "decay"] as const) {
      const hits = await store.searchL1Fts("alpha", 20, "", mode);
      expect([mode, hits.length]).toEqual([mode, CLASSES.length]);
    }
  });
});
