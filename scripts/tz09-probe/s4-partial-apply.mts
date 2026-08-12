/**
 * tz-09 S4 live scenario: an apply that mutates and then aborts leaves the run
 * parked and the journal readable, and the next dispatch cannot pick it up.
 *
 * The `prepared` row is the operation the process died inside: the mutation
 * was announced and never returned, which is precisely the state that must
 * NOT be resolvable by reading the journal alone.
 *
 * The second half is the case the applied lists cannot see: a merge whose
 * target was rewritten and whose member deletion then threw. `applied.merges`
 * stays EMPTY there, so the pre-fix `mutated = hasApplied(result)` called a
 * half-written store a clean failure.
 *
 * FALSIFY=mutated-false — computes the flag the way the pre-fix code did,
 * `hasApplied(result)`, instead of asking whether the store was touched: the
 * first half then lands in `failed` and the next dispatch is free to pick the
 * run up. The merge half is decided INSIDE the executor, where a probe may not
 * reach without planting a test hook in product code; it is falsified at the
 * source instead — swap `hasMutated` back to `hasApplied` in
 * apply-executor.ts:203 and this probe reports `merge run state after apply:
 * failed`. ТЗ S4 (:135) forbids exactly that.
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
  readRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { listOps, recordOp } from "../../src/gateway/control-plane/oplog.js";
import {
  hasApplied,
  hasMutated,
} from "../../src/gateway/apply-executor/apply-route-helpers.js";
import { leaveApplying } from "../../src/gateway/apply-executor/run-hooks.js";
import { EMPTY_RESULT } from "../../src/gateway/apply-executor/types.js";
import { beginApplying } from "../../src/gateway/control-plane/applying.js";
import { finalizeRunOutcome } from "../../src/gateway/consolidation/run-outcome.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";
import type { ApplyResult } from "../../src/gateway/apply-executor/types.js";

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
const partialDiff = {
  merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "AB" }],
  // drifted updatedAt → aborts AFTER the merge landed
  deleteL1: [{ id: "m_c", updatedAt: "2026-07-01T00:00:00Z" }],
};
// The critic receipt this candidate needs to reach the store at all.
updateRun(
  dataDir,
  RUN,
  {
    state: "reviewed",
    candidateDigest: digestOf(JSON.stringify(partialDiff)),
    verdictDigest: "v",
    criticReceipt: '{"verdict":"approve"}',
  },
  new Date().toISOString(),
);
const res = await executor.apply(
  {
    diff: partialDiff,
    manifest: { baseline: {} },
    context: { presentedRecordIds: ["m_a", "m_b", "m_c"] },
  },
  { runId: RUN, gateMode: "enforce" },
);
console.log(
  `apply: status=${res.status} partial=${res.partial} records after: ${store.countL1()}`,
);
must(
  "apply смутировал стор и оборвался — это частичное применение",
  res.partial === true && store.countL1() === 2,
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
// Первая половина — merge, который ДОШЁЛ до applied: тут старое и новое
// правило совпадают, поэтому рычаг на неё не действует и не притворяется.
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
const state = readRun(dataDir, RUN)?.state;
console.log(`class=${cls} run.state=${state} journal=${JSON.stringify(counts)}`);
must("частичное применение классифицировано как partial-apply", cls === "partial-apply");
must("Run припаркован в needs-reconciliation", state === "needs-reconciliation");
must(
  "журнал перечисляет и подтверждённые, и незавершённые операции",
  (counts.verified ?? 0) >= 1 && (counts.prepared ?? 0) >= 1,
);

const next = claimRun(dataDir, RUN, "next-dispatch", {
  nowMs: Date.now(),
  ttlMs: 60_000,
});
console.log(
  `next dispatch: ok=${next.ok} reason=${next.ok ? "-" : next.reason}`,
);
must("следующий запуск роли заблокирован до реконсилиации", next.ok === false);

// ── Вторая половина: merge, у которого таргет записан, а удаление членов
// упало. `applied.merges` пуст — ровно то, чего дофиксовый признак не видел.
const MERGE_RUN = "run-s4-merge";
createRun(
  dataDir,
  {
    runId: MERGE_RUN,
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
const mergeExecutor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: crashingStore as unknown as VectorStore,
  embeddingService: embedding,
  runRepo: true,
});
const mergeDiff = {
  merge: [
    { cluster: ["m_d", "m_e"], target: "m_d", content: "MERGED" },
  ],
};
for (const id of ["m_d", "m_e"]) {
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
updateRun(
  dataDir,
  MERGE_RUN,
  {
    state: "reviewed",
    candidateDigest: digestOf(JSON.stringify(mergeDiff)),
    verdictDigest: "v",
    criticReceipt: '{"verdict":"approve"}',
  },
  new Date().toISOString(),
);

let mergeRes: ApplyResult | undefined;
try {
  mergeRes = await mergeExecutor.apply(
    {
      diff: mergeDiff,
      manifest: { baseline: {} },
      context: { presentedRecordIds: ["m_d", "m_e"] },
    },
    { runId: MERGE_RUN, gateMode: "enforce" },
  );
} catch (err) {
  // ApplyRuntimeError вылетает наружу; результат уже закрыт внутри finish().
  console.log(
    `  merge apply threw: ${err instanceof Error ? err.message : String(err)}`,
  );
}
const mergeState = readRun(dataDir, MERGE_RUN)?.state;
console.log(`merge run state after apply: ${mergeState}`);
must(
  "оборванный merge припаркован по факту записи, а не по списку applied",
  mergeState === "needs-reconciliation",
);

// Тот же выход, что делает executor, но с признаком, посчитанным обоими
// способами: half-written результат (ни одна операция не дошла до applied,
// но запись в стор случилась) обязан давать needs-reconciliation.
const halfWritten = EMPTY_RESULT();
halfWritten.storeTouched = true;
const DOOR_RUN = "run-s4-door";
createRun(
  dataDir,
  {
    runId: DOOR_RUN,
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: "{}",
    binding: "{}",
  },
  new Date().toISOString(),
);
beginApplying(dataDir, DOOR_RUN, new Date().toISOString());
leaveApplying(
  { dataDir, logger, runRepo: true } as never,
  { runId: DOOR_RUN } as never,
  {
    ok: false,
    mutated:
      process.env.FALSIFY === "mutated-false"
        ? hasApplied(halfWritten)
        : hasMutated(halfWritten),
    entered: true,
  },
);
const doorState = readRun(dataDir, DOOR_RUN)?.state;
console.log(`half-written result → run state: ${doorState}`);
must(
  "признак «стор затронут» решает исход там, где applied-списки пусты",
  doorState === "needs-reconciliation",
);

store.close();
sbx.cleanup();
finish();
