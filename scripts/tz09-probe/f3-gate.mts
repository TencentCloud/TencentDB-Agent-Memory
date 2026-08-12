/**
 * tz-09 Ф3 live probe: the same candidate through a REAL apply, twice.
 *
 * shadow → the delete lands and the divergence is logged; enforce → the
 * apply is refused before any mutation and the record count does not move.
 * The role policy comes from the contract, not from the payload.
 *
 * Falsification is built in: the shadow half IS the falsification — remove
 * the gate and enforce behaves exactly like it. FALSIFY=shadow-as-enforce
 * runs the FIRST half in shadow too, so the refusal disappears and both legs
 * of the enforce observation go false — the refusal comes from the gate mode
 * and from nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import type { ApplyOp, RunContext } from "../../src/gateway/apply-executor.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";

const DIMS = 4;
const sbx = makeSandbox([]);
const vec = (n: number) => {
  const v = new Float32Array(DIMS);
  v[n % DIMS] = 1;
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
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`WARN ${m}`),
  error: () => undefined,
};

const store = new VectorStore(
  path.join(sbx.dataDir, "vectors.db"),
  DIMS,
  logger,
);
store.init();
const rec = (id: string): MemoryRecord => ({
  id,
  content: `memory ${id}`,
  type: "episodic",
  priority: 50,
  scene_name: "test",
  source_message_ids: [],
  metadata: {},
  timestamps: ["2026-08-01T00:00:00Z"],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  sessionKey: "cc",
  sessionId: "cc",
  projectId: "",
  scope: "global",
});
store.upsertL1(rec("m_a"), vec(1));
store.upsertL1(rec("m_b"), vec(2));

const executor = new ApplyExecutor({
  dataDir: sbx.dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
});

const candidate = {
  diff: { deleteL1: [{ id: "m_a", updatedAt: "2026-08-01T00:00:00Z" }] },
  manifest: { baseline: {} },
  context: { presentedRecordIds: ["m_a"] },
};
// The role may rewrite blocks; it may NOT delete. Exactly the case that used
// to be applied anyway.
const policy = (gateMode: RunContext["gateMode"]): RunContext => ({
  runId: "probe-run",
  opsSubset: new Set<ApplyOp>(["rewriteBlock"]),
  caps: { deletePerRun: 50, rewritePerRun: 50 },
  gateMode,
});

const before = store.countL1();
console.log(`records before: ${before}`);
const firstMode =
  process.env.FALSIFY === "shadow-as-enforce" ? "shadow" : "enforce";
const enforced = await executor.apply(candidate, policy(firstMode));
const afterEnforce = store.countL1();
console.log(
  `${firstMode} -> status=${enforced.status} error=${enforced.error} records=${afterEnforce}`,
);
must(
  "операция вне ops_subset отклонена гейтом",
  enforced.status === "aborted",
);
must("отказ случился ДО мутации: счётчик записей не сдвинулся", afterEnforce === before);

const shadowed = await executor.apply(candidate, policy("shadow"));
const afterShadow = store.countL1();
console.log(`shadow  -> status=${shadowed.status} records=${afterShadow}`);
must(
  "контроль: в shadow та же операция проходит, значит сцена реальна",
  afterShadow < before,
);

store.close();
fs.rmSync(sbx.home, { recursive: true, force: true });
finish();
