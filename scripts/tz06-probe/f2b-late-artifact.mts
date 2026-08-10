/**
 * tz-06 критерий 7 (вторая половина) живая проба: ПОЗДНИЙ кандидат не принят.
 *
 * Ребёнок игнорирует SIGTERM, переживает таймаут и пишет формально валидный
 * diff.json уже ПОСЛЕ того, как его убили. Такой кандидат не должен попасть
 * ни в parse, ни в apply: «процесс не уложился» — это не «результат готов».
 *
 * Проба идёт через настоящий preApply (тот же путь, что и боевой ран), а не
 * через launcher напрямую, потому что решение «принимать или нет» принимает
 * именно он.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=no-timeout — тот же ребёнок успевает в таймаут и
 * выходит нулём → кандидат ОБЯЗАН быть принят. Иначе проба ловит не таймаут,
 * а что-то постороннее (кривой json, не тот путь).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { preApply } from "../../src/gateway/consolidation/runner-stages.js";
import { createLauncherRegistry } from "../../src/gateway/consolidation/launchers/registry.js";
import { defaultSpawnChild } from "../../src/gateway/consolidation/runner-helpers.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { Logger } from "../../src/core/types.js";

const LATE = process.env.FALSIFY !== "no-timeout";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f2b-"));
const scratch = path.join(root, "scratch");
fs.mkdirSync(scratch, { recursive: true });

// Хост, который переживает SIGTERM и пишет кандидат ПОСЛЕ смерти таймаута.
const host = path.join(root, "stubborn.sh");
fs.writeFileSync(
  host,
  `#!/bin/sh
trap '' TERM
CAND='{"merges":[],"deletes":[],"rewrites":[{"path":"scenes/a.md","content":"late"}]}'
${
  LATE
    ? // Внук ВНЕ группы процессов: переживает group-kill и дописывает кандидат
      // уже после таймаута — ровно тот случай, который критерий 7 запрещает.
      `setsid sh -c "sleep 3; printf '%s' '$CAND' > '$PWD/diff.json'" &
sleep 3`
    : `printf '%s' "$CAND" > "$PWD/diff.json"`
}
exit 0
`,
  { mode: 0o755 },
);

const contract = {
  role: "probe-role",
  binding: { launcherId: "pi", model: "m", thinking: "low" },
  assets: {},
  // Таймаут заведомо короче, чем живёт ребёнок в основном режиме.
  timeoutMs: LATE ? 700 : 20_000,
  toolsSubset: new Set<string>(),
  prompt: {
    file: "prompt.md",
    path: null,
    text: "SYSTEM",
    failOnMissing: false,
  },
  policy: {
    opsSubset: new Set(["rewriteBlock"]),
    caps: { deletePerRun: 10, rewritePerRun: 10 },
    maxRunMs: 600000,
    retryBudget: 2,
  },
  requiresCapabilities: [],
  batching: {
    strategy: "fresh-tail-single-batch",
    scope: "fresh_tail",
    diffCap: 10,
    diffByteCap: 4096,
    idsOnly: false,
  },
} as unknown as ResolvedRoleContract;

const ctx = {
  dataDir: root,
  now: () => Date.now(),
  ownerPid: process.pid,
  gatewayUrl: "http://127.0.0.1:8420",
  childrenRef: { value: new Map() },
  launcherFor: createLauncherRegistry(
    { pi: { binary: host, flags: [] } },
    silent,
  ),
  spawnChild: (c: never) => defaultSpawnChild(ctx as never, c),
  config: { memory: {} },
  logger: silent,
} as unknown as OrchestratorContext;

const runId = randomUUID();
const result: Record<string, unknown> = {};
const out = await preApply(
  ctx,
  {
    runId,
    role: "probe-role",
    scratchDir: scratch,
    contract,
    cp: { l0Cursor: null, lastRunAt: null },
    records: [],
    overLimit: [],
    dryRun: false,
    remainingDeleteCap: 10,
    remainingRewriteCap: 10,
  } as never,
  result as never,
);

// Дать позднему ребёнку дописать — именно этот файл и не должен быть принят.
await new Promise((r) => setTimeout(r, LATE ? 3500 : 100));
const candidateOnDisk = fs.existsSync(path.join(scratch, "diff.json"));

console.log(
  `режим: ${LATE ? "ребёнок переживает таймаут" : "ребёнок успевает"}`,
);
console.log(`preApply принял кандидат: ${out.ok}`);
console.log(
  `status=${result.status ?? "<нет>"} error=${result.error ?? "нет"}`,
);
console.log(`поздний diff.json лежит на диске: ${candidateOnDisk}`);

fs.rmSync(root, { recursive: true, force: true });
