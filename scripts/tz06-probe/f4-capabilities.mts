/**
 * tz-06 Ф4 живая проба (S5 + критерий 10): несовместимость ОБЪЯВЛЯЕТСЯ.
 *
 * Три запуска через настоящий registry и настоящий defaultSpawnChild,
 * на preallocated Attempt-строках в настоящей control-plane базе:
 *   1. роль требует capability, которой у claude нет → host-incompatible;
 *   2. бинаря нет на диске                       → binary-not-found;
 *   3. launcher бросает исключение               → internal-launcher.
 * Во всех трёх промис сервиса РЕЗОЛВИТСЯ, а kind виден в listAttempts.
 *
 * ФАЛЬСИФИКАЦИИ:
 *   FALSIFY=no-requirement — убрать требование из контракта → роль обязана
 *                            запуститься (случай 1 перестаёт отказывать).
 *   FALSIFY=raw-throw      — снять перехват на границе сервиса → случай 3
 *                            обязан положить процесс (промис reject'ится).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultSpawnChild } from "../../src/gateway/consolidation/runner-helpers.js";
import { createLauncherRegistry } from "../../src/gateway/consolidation/launchers/registry.js";
import {
  recordAttempt,
  listAttempts,
} from "../../src/gateway/control-plane/attempt-repo.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { RoleLauncher } from "../../src/gateway/consolidation/launchers/types.js";
import type { Logger } from "../../src/core/types.js";

const MODE = process.env.FALSIFY ?? "";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f4-"));
const trueBin = "/bin/true";

function contractWith(
  requires: string[],
  launcherId = "pi",
): ResolvedRoleContract {
  return {
    binding: { launcherId, model: "m", thinking: "low" },
    assets: {},
    timeoutMs: 10_000,
    requiresCapabilities: MODE === "no-requirement" ? [] : requires,
  } as unknown as ResolvedRoleContract;
}

function ctxWith(launcherFor: (id: string) => RoleLauncher) {
  return {
    dataDir: dir,
    now: () => Date.now(),
    childrenRef: { value: new Map() },
    launcherFor,
    logger: silent,
  } as unknown as OrchestratorContext;
}

async function attempt(
  label: string,
  launcherFor: (id: string) => RoleLauncher,
  contract: ResolvedRoleContract,
): Promise<void> {
  const runId = randomUUID();
  const attemptId = recordAttempt(
    dir,
    runId,
    "launch",
    new Date().toISOString(),
  );
  const cwd = path.join(dir, runId);
  fs.mkdirSync(cwd, { recursive: true });
  // Настоящий системный промпт: без него фальсификация «убрать требование»
  // упиралась бы в permission-denied и не показывала бы, что роль запустилась.
  fs.writeFileSync(path.join(cwd, "p.md"), "SYSTEM PROMPT");
  const res = await defaultSpawnChild(ctxWith(launcherFor), {
    runId,
    attemptId,
    cwd,
    promptPath: path.join(cwd, "p.md"),
    taskPrompt: "task",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    contract,
  } as never);
  const row = listAttempts(dir, runId)[0];
  console.log(
    `${label}: промис резолвнулся, error=${res.error ?? "нет"} | ` +
      `attempt.outcome=${row?.outcome ?? "<пусто>"}`,
  );
}

// 1. Роль требует собственный extension-бандл; у claude такого нет.
// Не "isolation": confinement решают isolationProfileRef + bwrap, одинаково
// для всех хостов, поэтому такой capability в словаре больше нет — она могла
// бы отвечать только "да" и пропускала бы роль незаконфайненной.
const realRegistry = createLauncherRegistry(
  {
    pi: { binary: trueBin, flags: ["-p"] },
    claude: { binary: trueBin, flags: ["-p"] },
  },
  silent,
);
await attempt(
  "capability отсутствует",
  realRegistry,
  contractWith(["extension"], "claude"),
);

// 2. Бинаря нет — ENOENT приходит из процесса, а не из проверки матрицы.
const missingBin = createLauncherRegistry(
  { pi: { binary: path.join(dir, "does-not-exist"), flags: ["-p"] } },
  silent,
);
await attempt("бинаря нет", missingBin, contractWith([]));

// 3. Launcher бросает — это баг launcher'а, но не reject сервиса.
const throwing: RoleLauncher = {
  id: "pi",
  capabilities: new Set(["session"]),
  launch: () => {
    throw new Error("launcher exploded");
  },
};
await attempt("launcher бросил", () => throwing, contractWith([]));

fs.rmSync(dir, { recursive: true, force: true });
