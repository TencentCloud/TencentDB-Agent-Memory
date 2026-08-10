/**
 * tz-09 Ф0 — characterization of the PRE-tz-09 apply behaviour.
 *
 * These tests do not describe desired behaviour: they pin down what the
 * executor does TODAY, so every later phase can point at the exact line that
 * changed. Each `it` names the gap it characterizes and the phase that closes
 * it. When a phase flips one of these, the test moves WITH that phase — never
 * silently.
 *
 * Runs against a real VectorStore on a scratch dir with 4-dim fake vectors,
 * same harness style as apply-executor.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { VectorStore } from "../core/store/sqlite.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";
import { ApplyExecutor, assertOpsSubset } from "./apply-executor.js";

const DIMS = 4;

function fakeVec(seed = 0): Float32Array {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
}

const fakeEmbedding: EmbeddingService = {
  embed: async (text: string) => fakeVec(text.length),
  embedBatch: async (texts: string[]) => texts.map((t) => fakeVec(t.length)),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const META_BLOCK = [
  "-----META-START-----",
  "created: 2026-08-02T00:00:00Z",
  "updated: 2026-08-02T00:00:00Z",
  "summary: characterization block",
  "heat: 1",
  "-----META-END-----",
].join("\n");

function mem(
  id: string,
  content: string,
  updatedAt = "2026-08-01T00:00:00Z",
): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt,
    sessionKey: "cc-test",
    sessionId: "cc-test",
    projectId: "",
    scope: "global",
  };
}

function body(
  diff: Record<string, unknown>,
  baselineMap: Record<string, string> = {},
  presented: string[] = [],
): unknown {
  return {
    diff,
    manifest: { baseline: baselineMap },
    context: { presentedRecordIds: presented },
  };
}

describe("apply characterization (pre-tz-09)", () => {
  let dir: string;
  let dataDir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-char-"));
    dataDir = path.join(dir, "tdai");
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });
    store = new VectorStore(
      path.join(dataDir, "vectors.db"),
      DIMS,
      silentLogger,
    );
    store.init();
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function executor(): ApplyExecutor {
    return new ApplyExecutor({
      dataDir,
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
    });
  }

  function seed(id: string, content: string, updatedAt?: string): void {
    store.upsertL1(mem(id, content, updatedAt), fakeVec(id.length));
  }

  // Gap 1 (closed by Ф3): assertOpsSubset exists and works, but apply() never
  // calls it — a diff carrying an op the role may not perform is applied.
  it("gap: an op outside any ops_subset is applied (assertOpsSubset unreachable)", async () => {
    seed("m_a", "alpha");

    // The gate itself is functional when called directly …
    expect(() =>
      assertOpsSubset({ deleteL1: [{ id: "m_a", updatedAt: "x" }] }, new Set()),
    ).toThrow(/not in role ops_subset/);

    // … but the executor has no way to receive a subset, so the same op runs.
    const r = await executor().apply(
      body(
        { deleteL1: [{ id: "m_a", updatedAt: "2026-08-01T00:00:00Z" }] },
        {},
        ["m_a"],
      ),
    );
    expect(r.status).toBe("applied");
    expect(r.applied.deletes).toEqual(["m_a"]);
    expect(store.countL1()).toBe(0);
  });

  // Gap 2 (closed by Ф5): a partial apply reports partial=true in the RESPONSE
  // only. Nothing is persisted, so a crash right here leaves no trace of which
  // operations landed and no state that blocks the next run.
  it("gap: partial apply leaves no persisted marker", async () => {
    seed("m_a", "alpha");
    seed("m_b", "beta");
    seed("m_c", "gamma");

    const r = await executor().apply(
      body(
        {
          merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "AB" }],
          // drifted updatedAt → aborts AFTER the merge has been applied
          deleteL1: [{ id: "m_c", updatedAt: "2026-07-01T00:00:00Z" }],
        },
        {},
        ["m_a", "m_b", "m_c"],
      ),
    );
    expect(r.status).toBe("aborted");
    expect(r.partial).toBe(true);
    expect(r.applied.merges).toEqual(["m_a"]);

    // The store mutated, and the only record of it is the in-memory response.
    expect(store.countL1()).toBe(2); // m_b merged away, m_c untouched
    const metadataFiles = fs.readdirSync(path.join(dataDir, ".metadata"));
    expect(metadataFiles).not.toContain("control-plane.db");
  });

  // Gap 3 (closed by Ф1/Ф2/Ф6): the payload carries no run identity, so a body
  // replayed by anyone — a cancelled attempt, a stale child — is applied again
  // with no way to tell it apart from the live one.
  it("gap: a replayed body from an unknown run is applied", async () => {
    const scenePath = "scene_blocks/_global/ok.md";
    const abs = path.join(dataDir, scenePath);
    fs.writeFileSync(abs, `${META_BLOCK}\n\noriginal`, "utf-8");
    const sha = createHash("sha256")
      .update(fs.readFileSync(abs, "utf-8"))
      .digest("hex");

    const payload = body(
      {
        rewriteBlock: [
          { path: scenePath, content: `${META_BLOCK}\n\nfrom run A` },
        ],
      },
      { [scenePath]: sha },
      [],
    );

    const first = await executor().apply(payload);
    expect(first.status).toBe("applied");

    // Same payload again. It is ACCEPTED: the manifest recheck tolerates a
    // file whose content already equals this diff's rewrite target
    // (manifest.ts:48-51, the heal path), so nothing rejects the replay. It is
    // harmless here only because the write happens to be idempotent — no run
    // identity was consulted at any point.
    const replay = await executor().apply(payload);
    expect(replay.status).toBe("applied");
    expect(replay.error).toBeUndefined();
    expect(replay.skipped.rewrites).toEqual([scenePath]);
  });
});
