/**
 * tz-log Ф2/Ф3 — отчёт прогона находится по Run, и одна команда его печатает.
 *
 * Колонка `runs.logPath` была заведена и никем не заполнялась, а отчёт
 * назывался `<role>-<ts>.json` — по строке control-plane найти его было
 * нельзя, и наоборот. Теперь runId лежит и в имени файла, и в теле отчёта, и
 * в строке Run; `scripts/tdai-run-log.mts` собирает всё это в один вывод.
 *
 * Проба гоняет настоящий прогон в песочнице (заглушен только ребёнок),
 * потом запускает саму команду и читает её реальный вывод.
 *
 * FALSIFY=no-link — стирает logPath сразу после прогона, как было до фикса:
 * связь Run → отчёт ложна.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { executeRunForRole } from "../../src/gateway/consolidation/execute-run.js";
import { defaultApplyDiff } from "../../src/gateway/consolidation/runner-helpers.js";
import {
  readRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { readLastRuns } from "../../src/gateway/reports.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";
import { must, finish } from "../tz07-probe/assert.mts";

const DIMS = 4;
const UPDATED = "2026-08-01T00:00:00Z";
const RUN = "cccccccc-0000-4000-8000-000000000003";
const NO_LINK = process.env.FALSIFY === "no-link";
/** Ребёнок падает: именно у отказавшего прогона проверка должна показать,
 * что именно сказал ребёнок (на живом инстансе это был HTTP 402). */
const CHILD_STDERR = "402: not enough credits";

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
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sbx = makeSandbox([]);
process.env.HOME = sbx.home;
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
  recursive: true,
});

const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, silent);
store.init();
store.upsertL1(
  {
    id: "n_1",
    content: "content of n_1",
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

const roleDir = path.join(dataDir, "roles");
fs.mkdirSync(path.join(roleDir, "linked-keeper"), { recursive: true });
fs.writeFileSync(
  path.join(roleDir, "linked-keeper", "role.json"),
  JSON.stringify({
    name: "linked-keeper",
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
  }),
  "utf-8",
);
fs.writeFileSync(
  path.join(roleDir, "linked-keeper", "prompt.md"),
  "prompt",
  "utf-8",
);

const ctx = {
  dataDir,
  roleDir,
  roleDefaults: {} as never,
  applyGateMode: "shadow",
  applyRunRepo: true,
  gatewayUrl: "http://127.0.0.1:1",
  ownerPid: process.pid,
  scratchRoot: path.join(sbx.home, "scratch"),
  now: () => Date.now(),
  logger: silent,
  checkpoint: new ConsolidationCheckpoint(dataDir),
  childrenRef: { value: new Map() },
  activeRunUuidRef: { value: new Set<string>() },
  lastRunRef: { value: null },
  vectorStore: () => store as never,
  embeddingService: () => embedding as never,
  applyDiff: (body: unknown, run?: unknown) =>
    defaultApplyDiff(ctx, body, run as never),
  spawnChild: async () => ({
    exitCode: 1,
    timedOut: false,
    stdout: "",
    stderr: CHILD_STDERR,
  }),
} as unknown as OrchestratorContext;

const summary = await executeRunForRole(ctx, {
  reason: "probe",
  runId: RUN,
  role: "linked-keeper",
});
console.log(`прогон: ${summary.status} (${summary.error ?? "-"})`);

if (NO_LINK) {
  // Дофиксовое состояние: строка Run про свой отчёт ничего не знает.
  updateRun(dataDir, RUN, { logPath: "" }, new Date().toISOString());
}

const row = readRun(dataDir, RUN);
console.log(`logPath в control-plane: ${row?.logPath || "(пусто)"}`);
const linked = row?.logPath !== undefined && row.logPath !== "";
const body: { runId?: string } = linked
  ? (JSON.parse(fs.readFileSync(row.logPath, "utf-8")) as { runId?: string })
  : {};
must(
  "строка Run указывает на существующий отчёт этого же прогона",
  linked && fs.existsSync(row.logPath) && body.runId === RUN,
);

const dashboard = readLastRuns(dataDir, 5);
console.log(`readLastRuns вернул: ${dashboard.map((r) => r.file).join(", ")}`);
must(
  "отчёт с runId в имени по-прежнему виден дашборду",
  dashboard.some((r) => String(r.file).includes(RUN.slice(0, 8))),
);

// Ф3: та самая команда, ради которой всё делалось.
const out = execFileSync(
  "npx",
  ["tsx", "scripts/tdai-run-log.mts", RUN.slice(0, 8), "--data-dir", dataDir],
  { encoding: "utf-8", cwd: process.cwd() },
);
console.log("--- вывод tdai-run-log.mts");
console.log(
  out
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n"),
);
must(
  "команда печатает роль, состояние и stderr ребёнка одним выводом",
  out.includes("linked-keeper") &&
    out.includes("failed") &&
    out.includes(CHILD_STDERR),
);

// Ссылка протухла (отчёт пережил чистку, а путь в строке — нет): отчёт лежит
// в logs/ под именем с runId, и команда обязана его найти, а не соврать, что
// прогон до записи не дошёл.
updateRun(
  dataDir,
  RUN,
  { logPath: path.join(dataDir, "logs", "стёртый-путь.json") },
  new Date().toISOString(),
);
const stale = execFileSync(
  "npx",
  ["tsx", "scripts/tdai-run-log.mts", RUN.slice(0, 8), "--data-dir", dataDir],
  { encoding: "utf-8", cwd: process.cwd() },
);
console.log(
  `при протухшей ссылке: ${stale.includes(CHILD_STDERR) ? "отчёт найден по имени" : "отчёт потерян"}`,
);
must(
  "протухший logPath не прячет лежащий рядом отчёт",
  stale.includes(CHILD_STDERR),
);

// Диагностический инструмент не имеет права молча съесть кривой аргумент.
let tailRejected = false;
try {
  execFileSync(
    "npx",
    [
      "tsx",
      "scripts/tdai-run-log.mts",
      "last",
      "--tail",
      "нет",
      "--data-dir",
      dataDir,
    ],
    { encoding: "utf-8", stdio: "pipe", cwd: process.cwd() },
  );
} catch {
  tailRejected = true;
}
must("нечисловой --tail отвергнут", tailRejected);

store.close();
sbx.cleanup();
finish();
