/**
 * tz-06 Ф1 живая проба: роль исполняется ЧЕРЕЗ ПОРТ, а не через прямой спавн.
 *
 * Оркестратор запускается без подмены spawnChild, то есть идёт штатным путём
 * defaultSpawnChild → реестр launcher'ов → launchers/pi.ts. Бинарь «pi»
 * подменён shell-скриптом: он печатает полученные аргументы в свой лог и
 * пишет валидный diff.json, как настоящая роль.
 *
 * Проверяется: (а) порт реально спавнит; (б) форма аргументов пришла из
 * launcher'а (флаги из настроек + --model/--thinking/--system-prompt);
 * (в) кандидат роли доехал до apply.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=1 подменяет binding на несуществующий launcher —
 * прогон обязан упасть типизированным invalid-binding, а не исключением.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { ConsolidationOrchestrator } from "../../src/gateway/consolidation/orchestrator.js";
import { parseConfig } from "../../src/config.js";
import { buildRoleDefaults } from "../../src/gateway/role-defaults.js";
import type { Logger } from "../../src/core/types.js";

const BAD_LAUNCHER = process.env.FALSIFY === "1";
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`  WARN ${m}`),
  error: (m: string) => console.log(`  ERROR ${m}`),
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
const scratchRoot = path.join(sbx.home, "scratch");
fs.mkdirSync(scratchRoot, { recursive: true });
fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
  recursive: true,
});

// Подменный «pi»: записывает свои аргументы и валидный кандидат.
const argsLog = path.join(sbx.home, "args.log");
const fakePi = path.join(sbx.home, "fake-pi.sh");
fs.writeFileSync(
  fakePi,
  `#!/bin/sh\nfor a in "$@"; do echo "$a" >> ${argsLog}; done\nprintf '{}' > diff.json\nexit 0\n`,
  { mode: 0o755 },
);

const roleDir = path.join(sbx.roleDir, "memory-keeper");
fs.mkdirSync(roleDir, { recursive: true });
fs.writeFileSync(
  path.join(roleDir, "role.json"),
  JSON.stringify({
    name: "memory-keeper",
    model: "opencode-go/deepseek-v4-flash",
    prompt_file: "prompt.md",
    enabled: true,
    thinking: "low",
    trigger: "manual_only",
    scope: "fresh_tail",
    ops_subset: ["deleteL1"],
    runtime: { scratch_root: scratchRoot },
    ...(BAD_LAUNCHER ? { launcher: "nosuchhost" } : {}),
  }),
  "utf-8",
);
fs.writeFileSync(path.join(roleDir, "prompt.md"), "keeper prompt", "utf-8");

const memory = parseConfig({
  consolidation: {
    enabled: true,
    launchers: { pi: { binary: fakePi, flags: ["--probe-flag"] } },
  },
});

const orch = new ConsolidationOrchestrator({
  config: { memory } as never,
  enabled: true,
  roleDefaults: buildRoleDefaults(memory.consolidation),
  launchers: memory.consolidation.launchers,
  dataDir,
  scratchRoot,
  roleDir: sbx.roleDir,
  logger,
  gatewayUrl: "http://127.0.0.1:1",
  roleName: "memory-keeper",
} as never);

if (BAD_LAUNCHER) {
  // Реестр обязан вернуть отказывающий launcher, а не бросить.
  const ctx = (
    orch as unknown as { ctx: { launcherFor: (id: string) => unknown } }
  ).ctx;
  const launcher = ctx.launcherFor("nosuchhost") as {
    launch: (i: unknown) => Promise<{ ok: boolean; error?: { kind: string } }>;
  };
  const out = await launcher.launch({} as never);
  console.log(`неизвестный launcher: ok=${out.ok} kind=${out.error?.kind}`);
  sbx.cleanup();
  process.exit(0);
}

const summary = await orch.runNow({ reason: "probe" });
console.log(`прогон: status=${summary.status} error=${summary.error ?? "-"}`);

const args = fs.existsSync(argsLog)
  ? fs.readFileSync(argsLog, "utf-8").trim().split("\n")
  : [];
console.log(`подменный pi вызван: ${args.length > 0}`);
console.log(`аргументы: ${JSON.stringify(args)}`);

sbx.cleanup();
