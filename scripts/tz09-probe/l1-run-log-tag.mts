/**
 * tz-log Ф1 — строка лога опознаётся по прогону.
 *
 * До пакета из 46 вызовов логгера в consolidation/ только 2 печатали runId,
 * так что строку в 27-мегабайтном `gateway-dev.log` нельзя было отнести к
 * прогону: проверка живого инстанса превращалась в гадание. Тег ставится
 * один раз там, где runId известен — в `execute-run` (жизненный цикл) и на
 * обоих путях apply (внутрипроцессный `defaultApplyDiff` и HTTP-маршрут).
 *
 * Две ноги, потому что путей два:
 *   A — собранный оркестратор: прогон роли + apply батча внутри процесса;
 *   B — настоящий gateway: ребёнок применяет по HTTP, там логгер сервера.
 *
 * FALSIFY=no-tag — нога A получает логгер, срезающий тег (дофиксовая
 * раковина), нога B шлёт apply без runId в теле (дофиксовый маршрут его и не
 * читал). Обе ноги обязаны стать ложными.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { createDevLogger, flushLogs } from "../../src/utils/dev-logger.js";
import { executeRunForRole } from "../../src/gateway/consolidation/execute-run.js";
import { defaultApplyDiff } from "../../src/gateway/consolidation/runner-helpers.js";
import { createRun } from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { runOwnerId } from "../../src/gateway/control-plane/owner.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";
import { must, finish } from "../tz07-probe/assert.mts";

const PORT = 8798;
const DIMS = 4;
const UPDATED = "2026-08-01T00:00:00Z";
const NO_TAG = process.env.FALSIFY === "no-tag";

const vec = (seed: number): Float32Array => {
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

/** Дофиксовая раковина: та же запись в файл, но без тега прогона. */
function stripRunTag(base: Logger): Logger {
  const cut = (m: string): string => m.replace(/\[run:[0-9a-f]+\]\s*/g, "");
  return {
    debug: base.debug ? (m: string) => base.debug?.(cut(m)) : undefined,
    info: (m: string) => base.info(cut(m)),
    warn: (m: string) => base.warn(cut(m)),
    error: (m: string) => base.error(cut(m)),
  };
}

const sbx = makeSandbox([]);
process.env.HOME = sbx.home;
const dataDir = sbx.dataDir;
const logFile = path.join(dataDir, "logs", "gateway-dev.log");
fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
  recursive: true,
});

const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
store.init();
for (const id of ["n_1", "n_2"]) {
  store.upsertL1(
    {
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
    } as never,
    vec(1),
  );
}

const roleDir = path.join(dataDir, "roles");
const roleJson = {
  name: "tagged-keeper",
  model: "m",
  prompt_file: "prompt.md",
  enabled: true,
  thinking: "low",
  timeout_min: 5,
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
  max_run_ms: 120_000,
  fail_on_missing_prompt: false,
  critic_role: null,
  runtime: { scratch_root: path.join(sbx.home, "scratch") },
};
fs.mkdirSync(path.join(roleDir, "tagged-keeper"), { recursive: true });
fs.writeFileSync(
  path.join(roleDir, "tagged-keeper", "role.json"),
  JSON.stringify(roleJson),
  "utf-8",
);
fs.writeFileSync(
  path.join(roleDir, "tagged-keeper", "prompt.md"),
  "prompt",
  "utf-8",
);

// ---- Нога A: жизненный цикл прогона + apply внутри процесса ---------------
const fileLogger = createDevLogger({ tag: "[probe]", dev: true, logFile });
const logger = NO_TAG ? stripRunTag(fileLogger) : fileLogger;

const RUN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ctx = {
  dataDir,
  roleDir,
  roleDefaults: {} as never,
  applyGateMode: "shadow",
  applyRunRepo: true,
  gatewayUrl: `http://127.0.0.1:${PORT}`,
  ownerPid: process.pid,
  scratchRoot: path.join(sbx.home, "scratch"),
  now: () => Date.now(),
  logger,
  checkpoint: new ConsolidationCheckpoint(dataDir),
  childrenRef: { value: new Map() },
  activeRunUuidRef: { value: new Set<string>() },
  lastRunRef: { value: null },
  vectorStore: () => store as never,
  embeddingService: () => embedding as never,
  applyDiff: (body: unknown, run?: unknown) =>
    defaultApplyDiff(ctx, body, run as never),
  // Ребёнок пишет кандидата по предъявленной записи — единственная заглушка.
  spawnChild: async (c: { cwd: string }) => {
    const workset = JSON.parse(
      fs.readFileSync(path.join(c.cwd, "input", "workset.json"), "utf-8"),
    ) as { presentedRecordIds: string[] };
    const id = workset.presentedRecordIds[0] ?? "n_1";
    fs.mkdirSync(path.join(c.cwd, "out"), { recursive: true });
    fs.writeFileSync(
      path.join(c.cwd, "out", "result.json"),
      JSON.stringify({
        rewriteRecord: [{ id, updatedAt: UPDATED, content: `TAGGED ${id}` }],
      }),
      "utf-8",
    );
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  },
} as unknown as OrchestratorContext;

const summary = await executeRunForRole(ctx, {
  reason: "probe",
  runId: RUN_A,
  role: "tagged-keeper",
});
console.log(`нога A: прогон ${summary.status}`);
await flushLogs();

const tagA = `[run:${RUN_A.slice(0, 8)}]`;
const linesA = fs
  .readFileSync(logFile, "utf-8")
  .split("\n")
  .filter((l) => l.includes(tagA));
console.log(`нога A: строк с ${tagA} — ${linesA.length}`);
for (const l of linesA.slice(0, 3)) console.log(`  ${l.slice(0, 140)}`);
must("жизненный цикл прогона пишет строки с его тегом", linesA.length >= 3);

// ---- Нога B: apply по HTTP, логгер сервера --------------------------------
const cfgPath = path.join(sbx.home, "tdai-gateway.yaml");
fs.writeFileSync(
  cfgPath,
  [
    "server:",
    "  host: 127.0.0.1",
    `  port: ${PORT}`,
    "data:",
    `  baseDir: ${dataDir}`,
    "logging:",
    "  level: debug",
    "memory:",
    "  consolidation:",
    "    enabled: true",
    "    applyRunRepo: true",
  ].join("\n"),
  "utf-8",
);
process.env.TDAI_GATEWAY_CONFIG = cfgPath;

const RUN_B = "bbbbbbbb-0000-4000-8000-000000000002";
createRun(
  dataDir,
  {
    runId: RUN_B,
    roleId: "tagged-keeper",
    contractHash: "h",
    contractJson: JSON.stringify({
      policy: { opsSubset: ["rewriteRecord"], caps: {} },
    }),
    binding: "{}",
  },
  new Date().toISOString(),
);
claimRun(dataDir, RUN_B, runOwnerId(process.pid), {
  nowMs: Date.now(),
  ttlMs: 600_000,
  state: "running",
});

const gateway = new TdaiGateway();
await gateway.start();
const token = fs
  .readFileSync(path.join(path.dirname(dataDir), "tdai-gateway.token"), "utf-8")
  .trim();
const applyBody = {
  // Дофиксовый маршрут runId в теле для логов не использовал вовсе.
  ...(NO_TAG ? {} : { runId: RUN_B }),
  diff: {
    rewriteRecord: [{ id: "n_2", updatedAt: UPDATED, content: "HTTP TAGGED" }],
  },
  manifest: { baseline: { n_2: UPDATED } },
  context: { presentedRecordIds: ["n_2"] },
};
const res = await fetch(`http://127.0.0.1:${PORT}/memory/apply`, {
  method: "POST",
  headers: { "x-memory-token": token, "content-type": "application/json" },
  body: JSON.stringify(applyBody),
});
console.log(
  `нога B: POST /memory/apply -> ${res.status} ${JSON.stringify(await res.json()).slice(0, 200)}`,
);
await gateway.stop();
await flushLogs();

const tagB = `[run:${RUN_B.slice(0, 8)}]`;
const linesB = fs
  .readFileSync(logFile, "utf-8")
  .split("\n")
  .filter((l) => l.includes(tagB));
console.log(`нога B: строк с ${tagB} — ${linesB.length}`);
for (const l of linesB.slice(0, 3)) console.log(`  ${l.slice(0, 140)}`);
must("apply по HTTP пишет строки с тегом прогона из тела", linesB.length >= 1);

store.close();
sbx.cleanup();
finish();
