/**
 * tz-06 Ф6 живая проба (S6, security): изоляция и гейт L6.
 *
 * Три негативных действия ребёнка — прочитать чужой auth-файл, записать вне
 * scratch, открыть исходящее соединение:
 *   A) ПОД изоляцией (реальный bwrap) → все три обязаны провалиться, а запись
 *      В свой scratch — пройти (иначе изоляция просто ломает процесс);
 *   B) ВНЕ изоляции, из обычного процесса того же пользователя → все три
 *      обязаны пройти. Это обязательная фальсификация: без неё падение внутри
 *      изоляции ничего не доказывает (нет сети, нет файла, кривой скрипт).
 *   C) Гейт: роль с isolationProfileRef при незакрытом L6 обязана получить
 *      typed isolation-unavailable, а не тихий незащищённый запуск.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  confineArgv,
  isolationAvailable,
  L6_SIGNED_OFF,
} from "../../src/gateway/consolidation/launchers/isolation.js";
import { defaultSpawnChild } from "../../src/gateway/consolidation/runner-helpers.js";
import { createLauncherRegistry } from "../../src/gateway/consolidation/launchers/registry.js";
import { recordAttempt } from "../../src/gateway/control-plane/attempt-repo.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { Logger } from "../../src/core/types.js";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f6-"));
const scratch = path.join(root, "scratch");
fs.mkdirSync(scratch, { recursive: true });

// Чужой секрет и цель записи ВНЕ scratch — в HOME, а НЕ в /tmp: песочница
// подменяет /tmp своим tmpfs, поэтому цель в /tmp «не пишется на хост» просто
// потому, что её там нет. Это была бы ложная зелень.
const foreignAuth = path.join(os.homedir(), ".tz06-probe-foreign-auth.json");
fs.writeFileSync(foreignAuth, '{"token":"s3cr3t"}');
const outsideTarget = path.join(os.homedir(), ".tz06-probe-outside.txt");

const script = path.join(scratch, "negatives.sh");
fs.writeFileSync(
  script,
  `#!/bin/sh
cat ${foreignAuth} >/dev/null 2>&1 && echo READ_OK || echo READ_DENIED
(echo x > ${outsideTarget}) 2>/dev/null && echo WRITE_OK || echo WRITE_DENIED
(echo x > ./inside.txt) 2>/dev/null && echo INSIDE_OK || echo INSIDE_DENIED
# Адрес, а не имя: холодный DNS съедал бюджет и давал NET_DENIED по
# ПОСТОРОННЕЙ причине — фальсификация краснела не из-за изоляции.
timeout 20 curl -s -o /dev/null --connect-timeout 15 http://1.1.1.1 && echo NET_OK || echo NET_DENIED
`,
  { mode: 0o755 },
);

function report(label: string, out: string): void {
  const lines = out.split("\n").filter(Boolean);
  console.log(`${label}: ${lines.join(" ")}`);
}

console.log(`bwrap доступен: ${isolationAvailable()}`);
console.log(`L6 подписан: ${L6_SIGNED_OFF}`);

// A. Под изоляцией.
fs.rmSync(outsideTarget, { force: true });
const confined = confineArgv(scratch, "/bin/sh", [script]);
const a = spawnSync(confined.binary, confined.args, { encoding: "utf-8" });
report("A под изоляцией", a.stdout);
console.log(`A: хост-файл вне scratch создан: ${fs.existsSync(outsideTarget)}`);

// B. Обязательная фальсификация — то же самое БЕЗ изоляции.
fs.rmSync(outsideTarget, { force: true });
const b = spawnSync("/bin/sh", [script], { cwd: scratch, encoding: "utf-8" });
report("B вне изоляции", b.stdout);
console.log(`B: хост-файл вне scratch создан: ${fs.existsSync(outsideTarget)}`);

// C. Гейт: роль просит профиль изоляции, L6 не подписан.
// Фейковый хост докладывает, из-под изоляции он запущен или нет — иначе
// "ошибки нет" читалось бы как "запустили без изоляции", что неверно.
const hostBin = path.join(root, "fake-codex.sh");
fs.writeFileSync(
  hostBin,
  `#!/bin/sh
(echo x > ${outsideTarget}) 2>/dev/null && echo WRITE_OK > "$PWD/confinement.txt" || echo WRITE_DENIED > "$PWD/confinement.txt"
exit 0
`,
  { mode: 0o755 },
);
const runId = randomUUID();
const cwd = path.join(root, "runs", runId);
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(cwd, "prompt.md"), "SYSTEM");
const attemptId = recordAttempt(
  root,
  runId,
  "launch",
  new Date().toISOString(),
);
const ctx = {
  dataDir: root,
  now: () => Date.now(),
  childrenRef: { value: new Map() },
  launcherFor: createLauncherRegistry(
    { codex: { binary: hostBin, flags: [] } },
    silent,
  ),
  logger: silent,
} as unknown as OrchestratorContext;

const gated = await defaultSpawnChild(ctx, {
  runId,
  attemptId,
  cwd,
  promptPath: path.join(cwd, "prompt.md"),
  taskPrompt: "TASK",
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  contract: {
    binding: {
      launcherId: "codex",
      model: "m",
      thinking: "low",
      isolationProfileRef: "confined",
    },
    assets: {},
    timeoutMs: 10_000,
    toolsSubset: null,
    requiresCapabilities: [],
  } as unknown as ResolvedRoleContract,
} as never);
const marker = path.join(cwd, "confinement.txt");
const ran = fs.existsSync(marker)
  ? fs.readFileSync(marker, "utf-8").trim()
  : "<не запускался>";
console.log(
  `C гейт: ${gated.error ?? "ЗАПУЩЕНО"} exit=${gated.exitCode} stderr=${gated.stderr.trim().slice(0, 80) || "пусто"}`,
);
console.log(`C: ребёнок ${ran} (при открытом гейте обязано быть WRITE_DENIED)`);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(foreignAuth, { force: true });
fs.rmSync(outsideTarget, { force: true });
