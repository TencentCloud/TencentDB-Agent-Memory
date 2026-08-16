/**
 * End-to-end: one unusable operation costs the diff that operation, not the run.
 *
 * The production path is the one exercised here — the orchestrator applies
 * IN PROCESS (runner.ts → runner-helpers.defaultApplyDiff → ApplyExecutor)
 * against a real store with `runRepo: true`. That is the path run f947be67
 * died on: 362 presented records, 16 minutes of model time, nothing applied,
 * because the result carried `"rewritePersona": null`.
 *
 * Each case opens its OWN run: an apply closes the run it names (run-hooks.ts
 * `closesRun ?? true`), and `applied`/`failed` are both terminal in
 * run-policy.ts — a reused runId would be refused for the wrong reason.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { EventEmitter } from "node:events";
import { VectorStore } from "../../core/store/sqlite.js";
import { ApplyExecutor } from "../apply-executor.js";
import { handleMemoryApply } from "./apply-route.js";
import { createRun } from "../control-plane/run-repo.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { Logger } from "../../core/types.js";
import type { GatewayConfig } from "../config.js";

const DIMS = 4;
const NOW = "2026-08-15T04:00:00.000Z";
const UPDATED = "2026-08-01T00:00:00Z";

const vec = (seed: number): Float32Array => {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
};
const embedding: EmbeddingService = {
  embed: async (t: string) => vec(t.length),
  embedBatch: async (ts: string[]) => ts.map((t) => vec(t.length)),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};

function collectingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warns.push(m),
      error: () => undefined,
    },
  };
}

describe("an apply refuses operations, not batches", () => {
  let dir: string;
  let dataDir: string;
  let store: VectorStore;
  let warns: string[];
  let logger: Logger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-partial-"));
    dataDir = path.join(dir, "tdai");
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "persona.md"), "real persona", "utf-8");
    store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
    store.init();
    ({ logger, warns } = collectingLogger());
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(id: string): void {
    store.upsertL1(
      {
        id,
        content: `content of ${id}`,
        type: "episodic",
        priority: 50,
        scene_name: "test",
        source_message_ids: [],
        metadata: {},
        timestamps: [UPDATED],
        createdAt: UPDATED,
        updatedAt: UPDATED,
        sessionKey: "test",
        sessionId: "test",
        projectId: "",
        scope: "global",
      } as never,
      vec(id.length),
    );
  }

  /** A live, non-terminal run — without one `resolveRunPolicy` refuses. */
  function openRun(runId: string): { runId: string } {
    createRun(
      dataDir,
      {
        runId,
        roleId: "night-keeper",
        contractHash: "h",
        contractJson: JSON.stringify({
          policy: {
            opsSubset: ["deleteL1", "merge", "rewriteRecord", "rewritePersona"],
            caps: { deletePerRun: 10, rewritePerRun: 10 },
          },
        }),
        binding: "{}",
      },
      NOW,
    );
    return { runId };
  }

  const executor = (): ApplyExecutor =>
    new ApplyExecutor({
      dataDir,
      logger,
      vectorStore: store,
      embeddingService: embedding,
      runRepo: true,
    });

  const body = (
    diff: Record<string, unknown>,
    presented: string[],
  ): Record<string, unknown> => ({
    diff,
    manifest: { baseline: {} },
    context: { presentedRecordIds: presented },
  });

  // The literal reproduction of f947be67.
  it("applies the batch that carries a null persona", async () => {
    seed("m_1");
    const r = await executor().apply(
      body(
        {
          deleteL1: [{ id: "m_1", updatedAt: UPDATED }],
          rewritePersona: null,
        },
        ["m_1"],
      ),
      openRun("run-null-persona"),
    );
    expect(r.status, JSON.stringify(r)).toBe("applied");
    expect(r.applied.deletes).toEqual(["m_1"]);
    expect(r.rejected).toEqual([]);
    expect(store.countL1()).toBe(0);
  });

  it("applies the presented delete and refuses the unpresented one", async () => {
    seed("m_1");
    seed("m_2");
    const r = await executor().apply(
      body(
        {
          deleteL1: [
            { id: "m_1", updatedAt: UPDATED },
            { id: "m_ghost", updatedAt: UPDATED },
          ],
        },
        ["m_1"],
      ),
      openRun("run-one-ghost"),
    );
    expect(r.status, JSON.stringify(r)).toBe("applied");
    expect(r.applied.deletes).toEqual(["m_1"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.ref).toBe("m_ghost");
    expect(r.rejected[0]!.reason).toMatch(/was not presented/);
    // m_2 was never named by the diff and is untouched.
    expect(store.countL1()).toBe(1);
    expect(warns.some((w) => w.includes("op refused deleteL1[m_ghost]"))).toBe(
      true,
    );
  });

  it("fails loudly when EVERY operation is refused", async () => {
    seed("m_1");
    const r = await executor().apply(
      body({ deleteL1: [{ id: "m_ghost", updatedAt: UPDATED }] }, []),
      openRun("run-all-refused"),
    );
    expect(r.status).toBe("aborted");
    expect(r.statusCode).toBe(400);
    expect(r.error).toMatch(/^every operation in the diff was refused/);
    expect(r.error).toMatch(/was not presented/);
    expect(r.rejected).toHaveLength(1);
    expect(store.countL1()).toBe(1);
  });

  // A refusal must never become a deletion: an id claimed by two sections
  // takes BOTH claims down, and the record stays alive.
  it("refuses both sides of an id claimed twice", async () => {
    seed("m_1");
    const r = await executor().apply(
      body(
        {
          deleteL1: [{ id: "m_1", updatedAt: UPDATED }],
          rewriteRecord: [
            { id: "m_1", updatedAt: UPDATED, content: "rewritten" },
          ],
        },
        ["m_1"],
      ),
      openRun("run-double-claim"),
    );
    expect(r.status).toBe("aborted");
    expect(r.error).toMatch(/id-set intersection forbidden/);
    expect(store.countL1()).toBe(1);
  });

  // Pass order: the merge dies on the id collision, and the delete of its
  // member has to die with it — otherwise m_a goes and m_b merges nowhere.
  it("refuses a delete orphaned by a merge the collision pass killed", async () => {
    seed("m_a");
    seed("m_b");
    const r = await executor().apply(
      body(
        {
          merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "AB" }],
          rewriteRecord: [
            { id: "m_b", updatedAt: UPDATED, content: "rewritten" },
          ],
          deleteL1: [{ id: "m_a", updatedAt: UPDATED }],
        },
        ["m_a", "m_b"],
      ),
      openRun("run-orphan-delete"),
    );
    expect(r.status).toBe("aborted");
    expect(r.error).toMatch(/never merged/);
    expect(store.countL1()).toBe(2);
  });

  it("puts the refusals in the HTTP response body", async () => {
    seed("m_1");
    const { res, status, out } = resStub();
    await handleMemoryApply(
      routeCtx() as never,
      makeReq(
        JSON.stringify({
          ...body(
            {
              deleteL1: [
                { id: "m_1", updatedAt: UPDATED },
                { id: "m_ghost", updatedAt: UPDATED },
              ],
            },
            ["m_1"],
          ),
        }),
      ),
      res,
    );
    expect(status()).toBe(200);
    expect((out() as { rejected: unknown[] }).rejected).toHaveLength(1);
  });

  function routeCtx(): {
    core: {
      getVectorStore: () => IMemoryStore;
      getEmbeddingService: () => EmbeddingService;
    };
    config: GatewayConfig;
    logger: Logger;
  } {
    return {
      core: {
        getVectorStore: () => store,
        getEmbeddingService: () => embedding,
      } as never,
      // The route reads applyRunRepo from the config; off here, so the HTTP
      // case tests the response shape, not the run policy (covered above).
      config: { data: { baseDir: dataDir } } as GatewayConfig,
      logger,
    };
  }
});

function makeReq(bodyText: string): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  (req as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
  };
  queueMicrotask(() => {
    req.emit("data", Buffer.from(bodyText, "utf-8"));
    req.emit("end");
  });
  return req;
}

function resStub(): {
  res: http.ServerResponse;
  status: () => number | undefined;
  out: () => unknown;
} {
  let status: number | undefined;
  let bodyText = "";
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (payload?: unknown) => {
      bodyText = typeof payload === "string" ? payload : "";
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    status: () => status,
    out: () => (bodyText ? JSON.parse(bodyText) : null),
  };
}
