/**
 * tz-09 live probe for the three blockers Codex found in round 1.
 *
 *   #1 apply is bound to the candidate a critic APPROVED — a caller holding a
 *      valid runId cannot swap the diff under it;
 *   #2 the artefact fence survives the child deleting `<scratch>/run.json`,
 *      because the passport lives in the child's own writable scratch;
 *   #3 a Run state write from a process that lost the lease is refused, and a
 *      conditional UPDATE that matched nothing no longer reports success.
 *
 * Real VectorStore, real ApplyExecutor, real control-plane db, isolated HOME.
 *
 * FALSIFY=no-candidate-gate — apply in shadow instead of enforce: the swapped
 *   diff then lands in the store, which is the defect itself.
 * FALSIFY=passport-only — re-runs the same scenario through the PREVIOUS
 *   implementation (passport missing → allowed), which accepts the artefact of
 *   a run this process no longer owns.
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
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { runOwnerId } from "../../src/gateway/control-plane/owner.js";
import { rejectStaleArtifact } from "../../src/gateway/consolidation/artifact-fence.js";
import { digestOf } from "../../src/gateway/apply-executor/op-journal.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";
import { openReadonlySqlite } from "../../src/gateway/http-utils.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";

const FALSIFY = process.env.FALSIFY ?? "";
const MODE = FALSIFY === "no-candidate-gate" ? "shadow" : "enforce";
const DIMS = 4;
const UPDATED = "2026-08-01T00:00:00Z";

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
  timestamps: [UPDATED],
  createdAt: UPDATED,
  updatedAt: UPDATED,
  sessionKey: "probe",
  sessionId: "probe",
  projectId: "",
  scope: "global",
});
store.upsertL1(rec("m_1", "original") as never, vec(1));

/** Read the stored text back: "the gate refused" is only worth something if
 * the store really did not change. */
function contentOf(id: string): string | undefined {
  const db = openReadonlySqlite(path.join(dataDir, "vectors.db"));
  try {
    const row = db
      .prepare("SELECT content FROM l1_records WHERE record_id = ?")
      .get(id) as { content?: string } | undefined;
    return row?.content;
  } finally {
    db.close();
  }
}

const now = () => new Date().toISOString();
function seedRun(runId: string): void {
  createRun(
    dataDir,
    {
      runId,
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
}

const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
  runRepo: true,
});

const approvedDiff = {
  rewriteRecord: [{ id: "m_1", updatedAt: UPDATED, content: "APPROVED" }],
};
const swappedDiff = {
  rewriteRecord: [{ id: "m_1", updatedAt: UPDATED, content: "SWAPPED" }],
};
const bodyFor = (diff: unknown) => ({
  diff,
  manifest: { baseline: {} },
  context: { presentedRecordIds: ["m_1"] },
});

// ── #1: the critic approved `approvedDiff`; the caller submits `swappedDiff`.
seedRun("run-1");
updateRun(
  dataDir,
  "run-1",
  {
    state: "reviewed",
    candidateDigest: digestOf(JSON.stringify(approvedDiff)),
    verdictDigest: "v",
    criticReceipt: '{"verdict":"approve"}',
  },
  now(),
);

const swapped = await executor.apply(bodyFor(swappedDiff), {
  runId: "run-1",
  gateMode: MODE,
});
const afterSwap = contentOf("m_1");
console.log(`режим гейта: ${MODE}`);
console.log(`подменённый диф отвергнут: ${swapped.status === "aborted"}`);
console.log(`  причина: ${swapped.error ?? "(нет)"}`);
console.log(
  `  содержимое в сторе не подменено: ${afterSwap !== "SWAPPED"} ` +
    `(${afterSwap ?? "?"})`,
);

// Control: the approved bytes go through.
const good = await executor.apply(bodyFor(approvedDiff), {
  runId: "run-1",
  gateMode: MODE,
});
console.log(
  `одобренный кандидат применён: ${good.status === "applied"} (${good.status})`,
);

// ── #2: takeover, then the child deletes its passport.
seedRun("run-2");
const scratch = path.join(dataDir, "scratch-run-2");
fs.mkdirSync(scratch, { recursive: true });
const ctx = {
  dataDir,
  ownerPid: process.pid,
  logger,
} as unknown as OrchestratorContext;
claimRun(dataDir, "run-2", runOwnerId(process.pid), {
  nowMs: Date.now(),
  ttlMs: 60_000,
});
fs.writeFileSync(
  path.join(scratch, "run.json"),
  JSON.stringify({
    runId: "run-2",
    fence: 1,
    owner: runOwnerId(process.pid),
    role: "memory-keeper",
    copyOf: "control-plane.db",
  }),
  "utf-8",
);
console.log(
  `до захвата артефакт принят: ${rejectStaleArtifact(ctx, "run-2", scratch) === null}`,
);
claimRun(dataDir, "run-2", "someone-else", {
  nowMs: Date.now() + 120_000,
  ttlMs: 60_000,
});
fs.rmSync(path.join(scratch, "run.json"), { force: true });

/** The check as it was before this fix: no passport, nothing to compare. */
const oldReject = (dir: string): string | null =>
  fs.existsSync(path.join(dir, "run.json")) ? "would compare" : null;

const fenceErr =
  FALSIFY === "passport-only"
    ? oldReject(scratch)
    : rejectStaleArtifact(ctx, "run-2", scratch);
console.log(
  `после захвата и удаления паспорта артефакт отвергнут: ${fenceErr !== null}`,
);
console.log(`  причина: ${fenceErr ?? "(принят)"}`);

// ── #3: a write from the owner that lost the lease.
const stale = updateRun(
  dataDir,
  "run-2",
  { state: "applied", finishedAt: now() },
  now(),
  { owner: runOwnerId(process.pid) },
);
console.log(`запись состояния потерявшим лизу отвергнута: ${stale === false}`);
const winner = updateRun(dataDir, "run-2", { state: "failed" }, now(), {
  owner: "someone-else",
});
console.log(`запись действующим владельцем прошла: ${winner === true}`);

store.close();
sbx.cleanup();
