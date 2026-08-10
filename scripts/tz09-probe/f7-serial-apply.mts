/**
 * tz-09 Ф7 live probe: two REAL applies against one real store, launched at
 * the same moment from two different runs.
 *
 * The lock is what makes the second apply see the store the first one left:
 * both delete a different record and both must land, and the run that is
 * already `applying` cannot be entered twice.
 *
 * FALSIFY=1 turns runRepo off, which also removes the `applying` door — the
 * second entry then succeeds, which is the double-apply criterion 2 forbids.
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
import { beginApplying } from "../../src/gateway/control-plane/applying.js";
import { storeApplyLockPath } from "../../src/gateway/apply-executor/store-lock.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const RUN_REPO = process.env.FALSIFY !== "1";
const DIMS = 4;

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
for (const id of ["m_1", "m_2"]) {
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

for (const [runId, role] of [
  ["run-keeper", "memory-keeper"],
  ["run-night", "night-keeper"],
] as const) {
  createRun(
    dataDir,
    {
      runId,
      roleId: role,
      contractHash: "h",
      contractJson: JSON.stringify({
        policy: {
          opsSubset: ["deleteL1"],
          caps: { deletePerRun: 5, rewritePerRun: 5 },
        },
      }),
      binding: "{}",
    },
    new Date().toISOString(),
  );
}

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
  runRepo: RUN_REPO,
});

const apply = (runId: string, id: string) => {
  const diff = { deleteL1: [{ id, updatedAt: "2026-08-01T00:00:00Z" }] };
  // Enforce binds apply to the candidate a critic approved, so the probe has
  // to record that approval the way the critic stage does.
  updateRun(
    dataDir,
    runId,
    {
      state: "reviewed",
      candidateDigest: digestOf(JSON.stringify(diff)),
      verdictDigest: "v",
      criticReceipt: '{"verdict":"approve"}',
    },
    new Date().toISOString(),
  );
  return executor.apply(
    {
      diff,
      manifest: { baseline: {} },
      context: { presentedRecordIds: [id] },
    },
    { runId, gateMode: "enforce" },
  );
};

console.log(`runRepo=${RUN_REPO} L1 before=${store.countL1()}`);
const [a, b] = await Promise.all([
  apply("run-keeper", "m_1"),
  apply("run-night", "m_2"),
]);
console.log(
  `  keeper: ${a.status} deletes=${JSON.stringify(a.applied.deletes)}` +
    (a.error === undefined ? "" : ` error=${a.error}`),
);
console.log(
  `  night:  ${b.status} deletes=${JSON.stringify(b.applied.deletes)}` +
    (b.error === undefined ? "" : ` error=${b.error}`),
);
console.log(
  `  L1 after=${store.countL1()} ` +
    `runs=${readRun(dataDir, "run-keeper")?.state}/${readRun(dataDir, "run-night")?.state} ` +
    `lock leaked=${fs.existsSync(storeApplyLockPath(dataDir))}`,
);

// The door: a run that is already applying cannot be entered a second time.
createRun(
  dataDir,
  {
    runId: "run-door",
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: "{}",
    binding: "{}",
  },
  new Date().toISOString(),
);
const first = beginApplying(dataDir, "run-door", new Date().toISOString());
const second = beginApplying(dataDir, "run-door", new Date().toISOString());
console.log(
  `  applying door: first=${first.ok} second=${second.ok} (${second.reason ?? "-"})`,
);

store.close();
sbx.cleanup();
