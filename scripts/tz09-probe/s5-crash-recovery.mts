/**
 * tz-09 S5 live scenario: the four points a crash can land on, each recovered
 * by reading the store back — and recovery repeated is a no-op.
 *
 * Every case checks the record count before and after reconciliation: the
 * reconciler must never change it. What may change is the RUN's state, and
 * only when every journalled operation is accounted for.
 *
 * FALSIFY=trust-journal — reconciles the same runs WITHOUT reading the store,
 * trusting the journal's own words (a row that says `prepared` counted as
 * done). The `prepared` case then resolves and the run leaves the parked
 * state, which is the whole failure mode reconciliation exists to prevent.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import {
  createRun,
  readRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { listOps, recordOp } from "../../src/gateway/control-plane/oplog.js";
import {
  reconcileRun,
  type ReconcileReport,
} from "../../src/gateway/control-plane/reconcile.js";
import { must, finish } from "../tz07-probe/assert.mts";
import type { Logger } from "../../src/core/types.js";

const DIMS = 4;
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const vec = (seed: number) => {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });

const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
store.init();

let seq = 0;
function seedRecord(): string {
  const id = `m_${++seq}`;
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
  return id;
}

type CrashPoint = "before-journal" | "prepared" | "applied" | "verified";

/** Reconciliation that believes the journal instead of the store — the shape
 * this package replaced. A `prepared` row means "announced", not "done", so
 * counting it as verified declares a half-finished apply complete. */
function reconcileByJournal(runId: string, nowIso: string): ReconcileReport {
  const ops = listOps(dataDir, runId).filter((o) => o.state !== "planned");
  const resolved = ops.length > 0;
  if (resolved) {
    updateRun(dataDir, runId, { state: "failed", finishedAt: nowIso }, nowIso);
  }
  return {
    runId,
    total: ops.length,
    verified: ops.length,
    unresolved: [],
    notAttempted: [],
    resolved,
  };
}

const reconcile =
  process.env.FALSIFY === "trust-journal" ? reconcileByJournal : (
    runId: string,
    nowIso: string,
  ): ReconcileReport => reconcileRun(dataDir, runId, nowIso);

function scenario(point: CrashPoint): void {
  const runId = `run-${point}`;
  const target = seedRecord();
  const now = new Date().toISOString();
  createRun(
    dataDir,
    {
      runId,
      roleId: "memory-keeper",
      contractHash: "h",
      contractJson: "{}",
      binding: "{}",
    },
    now,
  );
  updateRun(dataDir, runId, { state: "needs-reconciliation" }, now);

  const journal = (state: "prepared" | "applied" | "verified") =>
    recordOp(
      dataDir,
      {
        runId,
        candidateDigest: `cand-${point}`,
        opIndex: 0,
        opType: "deleteL1",
        state,
        targetKey: target,
      },
      now,
    );

  // The delete actually landed in every case except the one where the process
  // died before touching the store.
  if (point !== "before-journal") journal("prepared");
  if (point === "applied" || point === "verified") {
    store.deleteL1(target);
    journal("applied");
  }
  if (point === "verified") journal("verified");

  const before = store.countL1();
  const first = reconcile(runId, now);
  const mid = store.countL1();
  const second = reconcile(runId, now);
  const after = store.countL1();

  console.log(
    `${point.padEnd(15)} records ${before}→${mid}→${after} ` +
      `verified=${first.verified}/${first.total} resolved=${first.resolved} ` +
      `state=${readRun(dataDir, runId)?.state} ` +
      `replay(no-op)=${second.verified === first.verified && second.total === first.total && after === mid} ` +
      `ops=${listOps(dataDir, runId).length}`,
  );

  must(
    `${point}: реконсилиация не трогает стор`,
    before === mid && mid === after,
  );
  must(
    `${point}: повтор реконсилиации — no-op`,
    second.verified === first.verified && second.total === first.total,
  );
  // Незавершённая операция читается из СТОРА: `prepared` значит «объявлена»,
  // а не «сделана», поэтому такой Run обязан остаться припаркованным.
  const parked = readRun(dataDir, runId)?.state === "needs-reconciliation";
  const storeSaysDone = point === "applied" || point === "verified";
  must(
    `${point}: состояние Run решается стором (${storeSaysDone ? "снят с парковки" : "остался припаркован"})`,
    storeSaysDone ? !parked && first.resolved : parked && !first.resolved,
  );
}

for (const point of [
  "before-journal",
  "prepared",
  "applied",
  "verified",
] as const) {
  scenario(point);
}

store.close();
sbx.cleanup();
finish();
