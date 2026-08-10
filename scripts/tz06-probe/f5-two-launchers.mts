/**
 * tz-06 Ф5 живая проба (S1 + S4): одна роль под двумя launcher'ами.
 *
 * Фейковые хосты (pi и claude) дампят СВОЙ argv и окружение в файл и пишут
 * одинаковый кандидат в diff.json. Кандидат читается настоящим
 * readScratchDiff — так проверяется, что разбор одинаков независимо от хоста.
 *
 * Проверяется:
 *   S1 — pi-бинарь недоступен, роль с binding claude обязана отработать;
 *   S4 — при launcherId=claude pi-launcher НЕ вызван ни разу, и в реальной
 *        командной строке ребёнка нет ни одного pi-флага и ни одного
 *        значения из дефолтных spawnFlags.
 *
 * ФАЛЬСИФИКАЦИИ:
 *   FALSIFY=binding-pi  — вернуть binding launcherId="pi" → заглушка обязана
 *                         быть вызвана (S4 краснеет).
 *   FALSIFY=claude-caps — потребовать от роли capability "extension", которой
 *                         у claude нет → отказ host-incompatible вместо
 *                         молчаливого запуска.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultSpawnChild } from "../../src/gateway/consolidation/runner-helpers.js";
import { createPiLauncher } from "../../src/gateway/consolidation/launchers/pi.js";
import { createClaudeLauncher } from "../../src/gateway/consolidation/launchers/claude.js";
import { checkCapabilities } from "../../src/gateway/consolidation/launchers/capabilities.js";
import { readScratchDiff } from "../../src/gateway/consolidation/scratch-diff.js";
import { recordAttempt } from "../../src/gateway/control-plane/attempt-repo.js";
import { DEFAULT_PI_FLAGS } from "../../src/gateway/consolidation/launchers/pi-config.js";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f5-"));

/** Хост, который дампит свой argv и пишет ОДИН И ТОТ ЖЕ кандидат. */
function fakeHost(name: string): string {
  const p = path.join(root, `fake-${name}.sh`);
  fs.writeFileSync(
    p,
    `#!/bin/sh
: > "$PWD/argv-${name}.txt"
for a in "$@"; do printf '%s\\n' "$a" >> "$PWD/argv-${name}.txt"; done
cat > "$PWD/diff.json" <<'JSON'
{"merges":[],"deletes":[],"rewrites":[{"path":"scenes/a.md","content":"x"}]}
JSON
exit 0
`,
    { mode: 0o755 },
  );
  return p;
}

// S1: pi-бинаря на диске НЕТ вообще — роль под claude обязана отработать.
const piBin = path.join(root, "no-pi");
const claudeBin = fakeHost("claude");

// S4: pi-launcher, который взрывается при вызове. Заменяется на настоящий
// только в режиме фальсификации binding-pi.
let piCalls = 0;
const explodingPi: RoleLauncher = {
  id: "pi",
  capabilities: new Set(["session", "extension", "skill", "thinking"]),
  launch: async () => {
    piCalls += 1;
    throw new Error("pi launcher was called — binding was not honoured");
  },
};
void createPiLauncher; // настоящий pi-launcher здесь не нужен: бинаря нет
void piBin;
const claude = createClaudeLauncher(
  { binary: claudeBin, flags: ["-p"] },
  silent,
);

function contract(launcherId: "pi" | "claude"): ResolvedRoleContract {
  return {
    binding: { launcherId, model: "test-model", thinking: "low" },
    assets: {},
    timeoutMs: 20_000,
    toolsSubset: new Set(["fetch_records.py"]),
    requiresCapabilities: MODE === "claude-caps" ? ["extension"] : ["session"],
  } as unknown as ResolvedRoleContract;
}

async function runUnder(launcherId: "pi" | "claude") {
  const runId = randomUUID();
  const cwd = path.join(root, "runs", runId);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "prompt.md"), "SYSTEM PROMPT OF THE ROLE");
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
    // Заглушка ВСЕГДА на месте pi: если binding честный, её не позовут.
    launcherFor: (id: string) => (id === "claude" ? claude : explodingPi),
    logger: silent,
  } as unknown as OrchestratorContext;

  const res = await defaultSpawnChild(ctx, {
    runId,
    attemptId,
    cwd,
    promptPath: path.join(cwd, "prompt.md"),
    taskPrompt: "TASK",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    contract: contract(launcherId),
  } as never);
  const parsed = await readScratchDiff(cwd);
  return { cwd, res, parsed };
}

// Проверка матрицы отдельно от запуска: при claude-caps запуск обязан
// не состояться, а причина — быть названной.
const capsError = checkCapabilities(
  "claude",
  contract("claude").requiresCapabilities,
  claude.capabilities,
);
console.log(
  `матрица claude: ${capsError === null ? "совместима" : capsError.kind}`,
);

console.log(`pi-бинарь на диске: ${fs.existsSync(piBin)}`);
const underClaude = await runUnder("claude");
console.log(
  `claude: error=${underClaude.res.error ?? "нет"} exit=${underClaude.res.exitCode}`,
);
console.log(
  `claude кандидат разобран: ${underClaude.parsed.error === undefined}`,
);
console.log(`pi-launcher вызван раз: ${piCalls}`);

const argvFile = path.join(underClaude.cwd, "argv-claude.txt");
if (fs.existsSync(argvFile)) {
  const argv = fs.readFileSync(argvFile, "utf-8").split("\n").filter(Boolean);
  // `-p` есть у обоих CLI и пришёл из claude-конфига — это НЕ pi-изм.
  // Ищем ровно то, что умеет только pi.
  const PI_ONLY = [
    "--no-context-files",
    "--thinking",
    "--skill",
    "--extension",
    "--no-extensions",
    "--session-dir",
    ...DEFAULT_PI_FLAGS.filter((f) => f !== "-p"),
  ];
  const piIsms = argv.filter((a) => PI_ONLY.includes(a));
  console.log(`pi-флагов в реальном argv ребёнка: ${piIsms.length}`);
  console.log(
    `claude получил системный промпт файлом-в-текст: ${argv.includes("SYSTEM PROMPT OF THE ROLE")}`,
  );
  console.log(
    `claude получил tools_subset: ${argv.includes("fetch_records.py")}`,
  );
}

if (MODE === "binding-pi") {
  // Тот же прогон, но binding честно указывает на pi → заглушка ОБЯЗАНА быть
  // вызвана. Если счётчик остался нулём, S4 ничего не проверял.
  const underPi = await runUnder("pi");
  console.log(`pi: error=${underPi.res.error ?? "нет"}`);
  console.log(`pi-launcher вызван раз: ${piCalls}`);
}

fs.rmSync(root, { recursive: true, force: true });
