/**
 * tz-09 Codex major #8: the journal has to hold the WHOLE plan.
 *
 * A candidate with three operations, crashing on the second. Before the fix
 * `prepared` was the first trace an operation left, so the third one — never
 * started — was invisible to reconciliation, and an operator reading the run
 * back could not tell "not attempted" from "never in the candidate".
 *
 * FALSIFY=no-plan — reports the same run through the OLD view (rows that
 * reached `prepared` at least once): the third operation disappears.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import {
  createRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { listOps } from "../../src/gateway/control-plane/oplog.js";
import { reconcileRun } from "../../src/gateway/control-plane/reconcile.js";
import { digestOf } from "../../src/gateway/apply-executor/op-journal.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const OLD_VIEW = process.env.FALSIFY === "no-plan";
const DIMS = 4;
const UPDATED = "2026-08-01T00:00:00Z";
const RUN = "run-b2";

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
const rec = (id: string) => ({
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
  sessionKey: "probe",
  sessionId: "probe",
  projectId: "",
  scope: "global",
});
for (const id of ["b_1", "b_2", "b_3"]) {
  store.upsertL1(rec(id) as never, vec(id.length));
}

// Three operations of the same type: the first lands, the second aborts (its
// updatedAt drifted — the guard that protects fresh data), the third never
// starts. That is the ordinary partial apply, not a contrived crash.
const diff = {
  rewriteRecord: [
    { id: "b_1", updatedAt: UPDATED, content: "FIRST" },
    { id: "b_2", updatedAt: "2026-07-01T00:00:00Z", content: "ABORTS" },
    { id: "b_3", updatedAt: UPDATED, content: "NEVER" },
  ],
};

const now = () => new Date().toISOString();
createRun(
  dataDir,
  {
    runId: RUN,
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: JSON.stringify({
      policy: {
        opsSubset: ["rewriteRecord"],
        caps: { deletePerRun: 5, rewritePerRun: 5 },
      },
    }),
    binding: "{}",
  },
  now(),
);
updateRun(
  dataDir,
  RUN,
  {
    state: "reviewed",
    candidateDigest: digestOf(JSON.stringify(diff)),
    verdictDigest: "v",
    criticReceipt: '{"verdict":"approve"}',
  },
  now(),
);

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
  runRepo: true,
});

let thrown = "-";
try {
  const res = await executor.apply(
    {
      diff,
      manifest: { baseline: {} },
      context: { presentedRecordIds: ["b_1", "b_2", "b_3"] },
    },
    { runId: RUN, gateMode: "enforce" },
  );
  thrown = `${res.status}: ${res.error ?? "-"}`;
} catch (err) {
  thrown = err instanceof Error ? err.message : String(err);
}
console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`apply оборвался на второй операции — ${thrown}`);

const rows = listOps(dataDir, RUN).filter(
  (op) => !OLD_VIEW || op.state !== "planned",
);
console.log(
  `в журнале операций: ${rows.length} из 3 — ` +
    JSON.stringify(rows.map((o) => `${o.opIndex}:${o.targetKey}/${o.state}`)),
);
console.log(
  `третья операция (b_3) видна в журнале: ${rows.some((o) => o.targetKey === "b_3")}`,
);

const report = reconcileRun(dataDir, RUN, now());
console.log(
  `reconcile: verified=${report.verified}/${report.total} ` +
    `не начаты=${JSON.stringify(report.notAttempted)} resolved=${report.resolved}`,
);

store.close();
sbx.cleanup();
