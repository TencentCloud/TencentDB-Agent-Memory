/**
 * tz-09 S4 live scenario: an apply that mutates and then aborts leaves the run
 * parked and the journal readable, and the next dispatch cannot pick it up.
 *
 * The `prepared` row is the operation the process died inside: the mutation
 * was announced and never returned, which is precisely the state that must
 * NOT be resolvable by reading the journal alone.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import {
  createRun,
  readRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { listOps, recordOp } from "../../src/gateway/control-plane/oplog.js";
import { finalizeRunOutcome } from "../../src/gateway/consolidation/run-outcome.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const DIMS = 4;
const RUN = "run-s4";
const DIGEST = "cand-s4";

const vec = (seed: number) => {
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
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`  WARN ${m}`),
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
  recursive: true,
});
fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });

const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
store.init();
for (const id of ["m_a", "m_b", "m_c"]) {
  store.upsertL1(
    {
      id,
      content: `content of ${id}`,
      type: "episodic",
      priority: 50,
      scene_name: "test",
      source_message_ids: [],
      metadata: {},
      timestamps: ["2026-08-01T00:00:00Z"],
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
      sessionKey: "probe",
      sessionId: "probe",
      projectId: "",
      scope: "global",
    } as never,
    vec(id.length),
  );
}

createRun(
  dataDir,
  {
    runId: RUN,
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: JSON.stringify({
      policy: {
        opsSubset: ["merge", "deleteL1"],
        caps: { deletePerRun: 5, rewritePerRun: 5 },
      },
    }),
    binding: "{}",
  },
  new Date().toISOString(),
);

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
  runRepo: true,
});

console.log(`records before: ${store.countL1()}`);
const res = await executor.apply(
  {
    diff: {
      merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "AB" }],
      // drifted updatedAt → aborts AFTER the merge landed
      deleteL1: [{ id: "m_c", updatedAt: "2026-07-01T00:00:00Z" }],
    },
    manifest: { baseline: {} },
    context: { presentedRecordIds: ["m_a", "m_b", "m_c"] },
  },
  { runId: RUN, candidateDigest: DIGEST, gateMode: "enforce" },
);
console.log(
  `apply: status=${res.status} partial=${res.partial} records after: ${store.countL1()}`,
);

// The operation the process died inside: announced, never returned.
recordOp(
  dataDir,
  {
    runId: RUN,
    candidateDigest: DIGEST,
    opIndex: 1,
    opType: "deleteL1",
    state: "prepared",
    targetKey: "m_c",
  },
  new Date().toISOString(),
);

const ctx = {
  dataDir,
  logger,
  now: () => Date.now(),
} as unknown as OrchestratorContext;
const cls = finalizeRunOutcome(ctx, { runId: RUN, partial: res.partial }, {
  role: "memory-keeper",
  status: "failed",
  error: res.error,
  child: {},
} as never);

const ops = listOps(dataDir, RUN);
const counts = ops.reduce<Record<string, number>>((acc, o) => {
  acc[o.state] = (acc[o.state] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `class=${cls} run.state=${readRun(dataDir, RUN)?.state} journal=${JSON.stringify(counts)}`,
);

const next = claimRun(dataDir, RUN, "next-dispatch", {
  nowMs: Date.now(),
  ttlMs: 60_000,
});
console.log(`next dispatch: ok=${next.ok} reason=${next.reason ?? "-"}`);

store.close();
sbx.cleanup();
