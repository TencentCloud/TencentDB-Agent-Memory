/**
 * tz-09 — многобатчевый ночной прогон под ОДНИМ Run (живой дефект).
 *
 * Найдено на боевом инстансе: за всю историю control-plane 86 прогонов и НИ
 * ОДНОГО в состоянии `applied`; ночной прогон 2026-08-12T03:00 отработал
 * 13 минут, ребёнок вернул валидный `out/result.json`, а прогон закончился
 * `run is applied: artefact refused`.
 *
 * Механика: `runNightBatches` гоняет все батчи под одним `runId`. Первый
 * батч доходит до apply, и единственный выход apply-executor'а закрывает Run
 * как `applied` (run-hooks.ts:66). Второй батч ингестит свой артефакт, а
 * `checkArtifactFence` не видит `applied` среди состояний, в которых прогон
 * ещё может производить артефакты (fence.ts:15) → отказ, и весь ночной
 * прогон падает, потеряв уже применённые мутации первого батча.
 *
 * Проба гоняет ДВА батча через реальный runNightBatches с реальным
 * control-plane; ребёнок — единственная заглушка (иначе нужна модель).
 *
 * FALSIFY=one-batch — тот же прогон одним батчем: отказа нет. Это отделяет
 * «сломан ингест артефакта» от «сломан переход между батчами».
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { runNightBatches } from "../../src/gateway/consolidation/night-batches.js";
import { resolveRoleContract } from "../../src/gateway/consolidation/role-contract.js";
import {
  createRun,
  readRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { runOwnerId } from "../../src/gateway/control-plane/owner.js";
import { defaultApplyDiff } from "../../src/gateway/consolidation/runner-helpers.js";
import { finalizeRunOutcome } from "../../src/gateway/consolidation/run-outcome.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { RunSummary } from "../../src/gateway/consolidation/types.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";
import { must, finish } from "../tz07-probe/assert.mts";

const DIMS = 4;
const RUN = "run-night-batches";
const UPDATED = "2026-08-01T00:00:00Z";
const ONE_BATCH = process.env.FALSIFY === "one-batch";

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
const warnings: string[] = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => {
    warnings.push(m);
  },
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
const roleDir = path.join(dataDir, "roles");
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
for (const id of ["n_1", "n_2"]) store.upsertL1(rec(id) as never, vec(1));

const roleJson = {
  name: "night-keeper",
  model: "opencode-go/deepseek-v4-flash",
  prompt_file: "prompt.md",
  enabled: true,
  thinking: "low",
  timeout_min: 10,
  scope: "fresh_tail",
  trigger: "manual_only",
  schedule: null,
  threshold: null,
  idsOnly: false,
  diff_cap: 20,
  diff_byte_cap: 8192,
  ops_subset: ["rewriteRecord"],
  tools_subset: [],
  caps: { delete_per_run: 10, rewrite_per_run: 10 },
  max_run_ms: 600_000,
  fail_on_missing_prompt: false,
  critic_role: null,
  runtime: {},
};
const dir = path.join(roleDir, "night-keeper");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "role.json"),
  JSON.stringify(roleJson),
  "utf-8",
);
fs.writeFileSync(path.join(dir, "prompt.md"), "night prompt", "utf-8");

const resolved = resolveRoleContract("night-keeper", roleDir, {
  timeoutMs: 60_000,
  night: {
    diffCap: 200,
    diffByteCap: 16_384,
    deletePerRun: 25,
    rewritePerRun: 25,
    scheduleRole: "night-keeper",
    thresholdRole: "memory-keeper",
  },
  day: {
    diffCap: 20,
    diffByteCap: 8_192,
    deletePerRun: 50,
    rewritePerRun: 50,
    threshold: 50,
  },
  failOpenPromptRoles: [],
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  thinking: "low",
} as never);
if (!resolved.ok) throw new Error(`role did not resolve: ${resolved.reason}`);

const runScratch = path.join(sbx.home, "scratch", RUN);
fs.mkdirSync(runScratch, { recursive: true });

createRun(
  dataDir,
  {
    runId: RUN,
    roleId: "night-keeper",
    contractHash: "h",
    contractJson: JSON.stringify({
      policy: {
        opsSubset: ["rewriteRecord"],
        caps: { deletePerRun: 10, rewritePerRun: 10 },
      },
    }),
    binding: "{}",
  },
  new Date().toISOString(),
);
claimRun(dataDir, RUN, runOwnerId(process.pid), {
  nowMs: Date.now(),
  ttlMs: 600_000,
});

/** Один кандидат на батч: переписать запись, которую этот батч предъявил. */
const candidateFor = (id: string) => ({
  rewriteRecord: [{ id, updatedAt: UPDATED, content: `REWRITTEN ${id}` }],
});

const ctx = {
  dataDir,
  roleDir,
  roleDefaults: {} as never,
  applyGateMode: "shadow",
  applyRunRepo: true,
  gatewayUrl: "http://127.0.0.1:1",
  ownerPid: process.pid,
  scratchRoot: path.dirname(runScratch),
  now: () => Date.now(),
  logger,
  childrenRef: { value: new Map() },
  vectorStore: () => store as never,
  embeddingService: () => embedding as never,
  // Боевой применятель: именно он закрывает Run через leaveApplying.
  applyDiff: (body: unknown, run?: unknown) =>
    defaultApplyDiff(ctx, body, run as never),
  // Единственная заглушка: ребёнок пишет кандидат по предъявленным записям.
  spawnChild: async (c: { cwd: string }) => {
    // Кандидат обязан лежать внутри предъявленного набора (валидация
    // apply-executor'а), поэтому берём id из workset этой попытки.
    const worksetPath = path.join(c.cwd, "input", "workset.json");
    const workset = JSON.parse(fs.readFileSync(worksetPath, "utf-8")) as {
      presentedRecordIds: string[];
    };
    const id = workset.presentedRecordIds[0]!;
    fs.mkdirSync(path.join(c.cwd, "out"), { recursive: true });
    fs.writeFileSync(
      path.join(c.cwd, "out", "result.json"),
      JSON.stringify(candidateFor(id)),
      "utf-8",
    );
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  },
} as unknown as OrchestratorContext;

const summary: RunSummary = {
  role: "night-keeper",
  status: "ok",
  startedAt: new Date().toISOString(),
  finishedAt: "",
  recordsPresented: 0,
  overLimitBlocks: 0,
  applied: { merges: [], deletes: [], rewrites: [] },
  skipped: { merges: [], deletes: [], rewrites: [] },
} as unknown as RunSummary;

const entry = (id: string) => ({
  id,
  content: `content of ${id}`,
  updatedAt: UPDATED,
  recordedAt: UPDATED,
});
const batches = ONE_BATCH
  ? [[entry("n_1"), entry("n_2")] as never]
  : ([[entry("n_1")], [entry("n_2")]] as never);

console.log(`батчей: ${(batches as unknown[]).length}`);
const res = await runNightBatches(ctx, {
  reason: "probe",
  runId: RUN,
  role: "night-keeper",
  contract: resolved.contract,
  runScratch,
  batches,
  blocks: [],
  cp: { l0Cursor: "", l0CursorId: "", lastRunAt: null },
  summary,
  startedMs: Date.now(),
});

const refused = warnings.filter((w) => w.includes("artefact refused"));
for (const w of refused) console.log(`  WARN ${w}`);
console.log(
  `итог: status=${summary.status} error=${summary.error ?? "-"} ` +
    `rewrites=${JSON.stringify(summary.applied.rewrites)} anyApplied=${res.anyApplied}`,
);
console.log(
  `состояние Run между батчами и до финализации: ${readRun(dataDir, RUN)?.state}`,
);

// Закрывает Run финализация ПРОГОНА — ровно как в run-role.ts:161.
summary.finishedAt = new Date().toISOString();
finalizeRunOutcome(ctx, { runId: RUN }, summary);
const finalState = readRun(dataDir, RUN)?.state;
console.log(`состояние Run после финализации прогона: ${finalState}`);

must(
  "ни один батч не отвергнут по fence собственного прогона",
  refused.length === 0,
);
must(
  "многобатчевый прогон не падает после первого применённого батча",
  summary.status !== "failed",
);
must(
  "применены кандидаты обоих батчей",
  ONE_BATCH || summary.applied.rewrites.length === 2,
);
must(
  "Run закрывает финализация прогона, а не отдельный apply",
  finalState === "applied",
);

store.close();
sbx.cleanup();
finish();
