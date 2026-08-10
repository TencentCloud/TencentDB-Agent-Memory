/**
 * tz-09 Ф5 live probe: a REAL partial apply leaves a journal, and
 * reconciliation reads the store back to say exactly how far it got.
 *
 * Same scenario the Ф0 characterization pinned as "partial apply leaves no
 * persisted marker" (apply-executor.characterization.test.ts) — replayed here
 * WITH a RunContext. The merge lands, the delete aborts on drifted updatedAt.
 *
 * FALSIFY=1 drops the runId from the apply, which is how the journal is proven
 * to be the thing doing the work: no run identity → no oplog → nothing to
 * reconcile.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import { listOps } from "../../src/gateway/control-plane/oplog.js";
import { reconcileRun } from "../../src/gateway/control-plane/reconcile.js";
import {
  createRun,
  readRun,
} from "../../src/gateway/control-plane/run-repo.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const FALSIFY = process.env.FALSIFY === "1";
const DIMS = 4;
const RUN_ID = "run-f5";
const DIGEST = "cand-f5";

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
  warn: () => undefined,
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

const rec = (id: string, content: string) => ({
  id,
  content,
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
});
for (const [id, text] of [
  ["m_a", "alpha"],
  ["m_b", "beta"],
  ["m_c", "gamma"],
] as const) {
  store.upsertL1(rec(id, text) as never, vec(id.length));
}

createRun(
  dataDir,
  {
    runId: RUN_ID,
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: "{}",
    binding: "{}",
  },
  new Date().toISOString(),
);

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
});

const body = {
  diff: {
    merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "AB" }],
    // drifted updatedAt → the apply aborts AFTER the merge has landed
    deleteL1: [{ id: "m_c", updatedAt: "2026-07-01T00:00:00Z" }],
  },
  manifest: { baseline: {} },
  context: { presentedRecordIds: ["m_a", "m_b", "m_c"] },
};

const before = store.countL1();
const res = await executor.apply(
  body,
  FALSIFY
    ? { gateMode: "shadow" }
    : { runId: RUN_ID, candidateDigest: DIGEST, gateMode: "shadow" },
);
console.log(
  `apply: status=${res.status} partial=${res.partial} ` +
    `merged=${JSON.stringify(res.applied.merges)} L1 ${before}→${store.countL1()}`,
);

const ops = listOps(dataDir, RUN_ID);
console.log(
  `oplog rows: ${ops.length}` +
    ops
      .map((o) => `\n  #${o.opIndex} ${o.opType}/${o.targetKey} ${o.state}`)
      .join(""),
);

const report = reconcileRun(dataDir, RUN_ID, new Date().toISOString());
console.log(
  `reconcile: verified=${report.verified}/${report.total} ` +
    `resolved=${report.resolved} unresolved=${JSON.stringify(
      report.unresolved.map((u) => `${u.opIndex}:${u.detail}`),
    )}`,
);
console.log(`run state: ${readRun(dataDir, RUN_ID)?.state}`);

store.close();
sbx.cleanup();
