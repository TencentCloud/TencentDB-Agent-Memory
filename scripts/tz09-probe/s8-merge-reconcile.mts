/**
 * tz-09 S8 live scenario (Codex finding 1): a merge whose member deletion never
 * finished must NOT reconcile as resolved.
 *
 * A merge has two effects — the target carries the merged content, and the
 * cluster members are gone. The journal used to describe only the first, so a
 * crash inside `deleteL1Batch` left a run whose single journalled op verified
 * happily while the duplicates it was supposed to remove were still in the
 * store: reconciliation reported full confidence over half an operation.
 *
 * Here `deleteL1Batch` throws — exactly the shape of dying inside it — and the
 * run goes through the real ApplyExecutor and the real reconciliation.
 *
 * FALSIFY=1 journals the merge WITHOUT its members (the pre-fix shape) and the
 * probe must flip to `resolved=true` with the duplicate still present.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import { digestOf } from "../../src/gateway/apply-executor/op-journal.js";
import {
  createRun,
  updateRun,
  readRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { listOps } from "../../src/gateway/control-plane/oplog.js";
import { reconcileRun } from "../../src/gateway/control-plane/reconcile.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const DIMS = 4;
const RUN = "run-s8";
const DIGEST = "cand-s8";
const KEEP_MEMBERS = process.env.FALSIFY === "1";

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
for (const id of ["s8_target", "s8_member"]) {
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
        opsSubset: ["merge"],
        caps: { deletePerRun: 5, rewritePerRun: 5 },
      },
    }),
    binding: "{}",
  },
  new Date().toISOString(),
);

// Dying INSIDE deleteL1Batch: the target rewrite already landed, the members
// did not. FALSIFY additionally hides the members from the journal.
const crashingStore = new Proxy(store, {
  get(t, prop, recv) {
    if (prop === "deleteL1Batch") {
      return async () => {
        throw new Error("simulated crash inside deleteL1Batch");
      };
    }
    return Reflect.get(t, prop, recv) as unknown;
  },
});

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: crashingStore as unknown as VectorStore,
  embeddingService: embedding,
  runRepo: true,
});

console.log(
  `journal members: ${KEEP_MEMBERS ? "OMITTED (pre-fix)" : "recorded"}`,
);
console.log(`records before: ${store.countL1()}`);

const mergeDiff = {
  merge: [
    {
      cluster: ["s8_target", "s8_member"],
      target: "s8_target",
      content: "MERGED CONTENT",
    },
  ],
};
// Enforce refuses a candidate no verdict named, so the crash this probe is
// about is only reachable once the critic receipt is on the row.
updateRun(
  dataDir,
  RUN,
  {
    state: "reviewed",
    candidateDigest: digestOf(JSON.stringify(mergeDiff)),
    verdictDigest: "v",
    criticReceipt: '{"verdict":"approve"}',
  },
  new Date().toISOString(),
);

let applyError = "-";
try {
  await executor.apply(
    {
      diff: mergeDiff,
      manifest: { baseline: {} },
      context: { presentedRecordIds: ["s8_target", "s8_member"] },
    },
    { runId: RUN, gateMode: "enforce" },
  );
} catch (err) {
  applyError = err instanceof Error ? err.message : String(err);
}
console.log(`apply threw: ${applyError}`);
// 2 records left = the target was rewritten but the member was never removed.
console.log(`records after: ${store.countL1()}`);

if (KEEP_MEMBERS) {
  // Pre-fix journal shape: the merge row with no member keys at all.
  const db = (
    await import("../../src/gateway/control-plane/db.js")
  ).openControlPlane(dataDir);
  db.prepare(`UPDATE oplog SET extraKeys = '' WHERE runId = ?`).run(RUN);
  db.close();
}

console.log(
  `journal: ${JSON.stringify(
    listOps(dataDir, RUN).map(
      (o) => `${o.opIndex}:${o.opType}/${o.state} extra=${o.extraKeys || "-"}`,
    ),
  )}`,
);

const report = reconcileRun(dataDir, RUN, new Date().toISOString());
console.log(
  `reconcile: total=${report.total} verified=${report.verified} resolved=${report.resolved}`,
);
for (const u of report.unresolved)
  console.log(`  unresolved ${u.opIndex}: ${u.detail}`);
console.log(`run state after reconcile: ${readRun(dataDir, RUN)?.state}`);

store.close();
sbx.cleanup();
