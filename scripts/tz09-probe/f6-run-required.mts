/**
 * tz-09 Ф6 live probe: with `applyRunRepo` on, a real apply that names no live
 * Run never reaches the store, and the ops policy comes from the Run's pinned
 * contract instead of from the caller.
 *
 * Three real applies against one real VectorStore:
 *   1. no runId                → refused, store untouched
 *   2. runId of a cancelled run → refused, store untouched
 *   3. live run whose snapshot allows only rewriteBlock, caller claims
 *      deleteL1 → refused by the gate in enforce, store untouched
 * and a control: the same delete with the snapshot allowing it → applied.
 *
 * FALSIFY=1 turns runRepo off (the documented rollback) — case 1 then mutates
 * the store, which is exactly what the gate is there to prevent.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import { digestOf } from "../../src/gateway/apply-executor/op-journal.js";
import {
  createRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
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

const rec = (id: string) => ({
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
});
for (const id of ["m_1", "m_2", "m_3", "m_4"]) {
  store.upsertL1(rec(id) as never, vec(id.length));
}

function seedRun(runId: string, ops: string[]): void {
  createRun(
    dataDir,
    {
      runId,
      roleId: "memory-keeper",
      contractHash: "h",
      contractJson: JSON.stringify({
        policy: { opsSubset: ops, caps: { deletePerRun: 5, rewritePerRun: 5 } },
      }),
      binding: "{}",
    },
    new Date().toISOString(),
  );
}
seedRun("run-cancelled", ["deleteL1"]);
updateRun(
  dataDir,
  "run-cancelled",
  { state: "cancelled" },
  new Date().toISOString(),
);
seedRun("run-blocks-only", ["rewriteBlock"]);
seedRun("run-may-delete", ["deleteL1"]);

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
  runRepo: RUN_REPO,
});

const deleteBody = (id: string) => ({
  diff: { deleteL1: [{ id, updatedAt: "2026-08-01T00:00:00Z" }] },
  manifest: { baseline: {} },
  context: { presentedRecordIds: [id] },
});

/** Enforce binds apply to an approved candidate, so a probe that wants to
 * reach the OPS gate has to pass the candidate gate first. */
function approve(runId: string, id: string): void {
  updateRun(
    dataDir,
    runId,
    {
      state: "reviewed",
      candidateDigest: digestOf(JSON.stringify(deleteBody(id).diff)),
      verdictDigest: "v",
      criticReceipt: '{"verdict":"approve"}',
    },
    new Date().toISOString(),
  );
}
approve("run-blocks-only", "m_3");
approve("run-may-delete", "m_4");

console.log(`runRepo=${RUN_REPO}`);
for (const [label, id, run, wantApplied] of [
  ["без runId apply отклонён, стор не тронут", "m_1", undefined, false],
  [
    "apply по отменённому Run отклонён, стор не тронут",
    "m_2",
    { runId: "run-cancelled" },
    false,
  ],
  [
    "политика берётся из пиннутого контракта, а не от вызывающего",
    "m_3",
    {
      runId: "run-blocks-only",
      opsSubset: new Set(["deleteL1"] as const),
      gateMode: "enforce" as const,
    },
    false,
  ],
  [
    "контроль: контракт разрешает deleteL1 — apply проходит",
    "m_4",
    {
      runId: "run-may-delete",
      candidateDigest: "d4",
      opsSubset: new Set(["deleteL1"] as const),
      gateMode: "enforce" as const,
    },
    true,
  ],
] as const) {
  const before = store.countL1();
  const res = await executor.apply(deleteBody(id), run as never);
  const after = store.countL1();
  console.log(
    `  status=${res.status} L1 ${before}→${after}` +
      (res.error === undefined ? "" : ` error=${res.error}`),
  );
  must(
    label,
    wantApplied
      ? res.status === "applied" && after === before - 1
      : res.status === "aborted" && after === before,
  );
}

store.close();
sbx.cleanup();
finish();
