/**
 * tz-06 Ф5b живая проба: ОДНА роль под тремя хостами, один разбор кандидата.
 *
 * Каждый фейковый хост пишет один и тот же diff.json и дампит свой argv.
 * Кандидат читается настоящим readScratchDiff, дайджест кандидата сравнивается
 * между хостами: если разбор зависит от хоста — дайджесты разойдутся.
 *
 * ФАЛЬСИФИКАЦИИ:
 *   FALSIFY=codex-differs — codex-хост пишет ДРУГОЙ кандидат → дайджесты
 *                           обязаны разойтись (иначе проба ничего не сверяет).
 *   FALSIFY=no-extension  — потребовать capability "extension": её заявляет
 *                           только pi, claude и codex обязаны отказать.
 *                           (Раньше здесь стояла "isolation" — посылка была
 *                           ложной: confineArgv host-agnostic, и изоляцию
 *                           даёт bwrap, а не флаг конкретного хоста.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defaultSpawnChild } from "../../src/gateway/consolidation/runner-helpers.js";
import { createLauncherRegistry } from "../../src/gateway/consolidation/launchers/registry.js";
import { readScratchDiff } from "../../src/gateway/consolidation/scratch-diff.js";
import { recordAttempt } from "../../src/gateway/control-plane/attempt-repo.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { Logger } from "../../src/core/types.js";

const MODE = process.env.FALSIFY ?? "";
const HOSTS = (process.env.LAUNCHERS ?? "pi,claude,codex").split(",");
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f5b-"));

function fakeHost(id: string): string {
  const candidate =
    MODE === "codex-differs" && id === "codex"
      ? '{"merges":[],"deletes":["rec-9"],"rewrites":[]}'
      : '{"merges":[],"deletes":[],"rewrites":[{"path":"scenes/a.md","content":"x"}]}';
  const p = path.join(root, `fake-${id}.sh`);
  fs.writeFileSync(
    p,
    `#!/bin/sh
: > "$PWD/argv-${id}.txt"
for a in "$@"; do printf '%s\\n' "$a" >> "$PWD/argv-${id}.txt"; done
cat > "$PWD/diff.json" <<'JSON'
${candidate}
JSON
exit 0
`,
    { mode: 0o755 },
  );
  return p;
}

const registry = createLauncherRegistry(
  Object.fromEntries(
    HOSTS.map((id) => [id, { binary: fakeHost(id), flags: [] }]),
  ),
  silent,
);

const contract = (launcherId: string): ResolvedRoleContract =>
  ({
    binding: { launcherId, model: "test-model", thinking: "low" },
    assets: {},
    timeoutMs: 20_000,
    toolsSubset: null,
    requiresCapabilities: MODE === "no-extension" ? ["extension"] : ["session"],
  }) as unknown as ResolvedRoleContract;

const digests = new Map<string, string>();
for (const id of HOSTS) {
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
    launcherFor: registry,
    logger: silent,
  } as unknown as OrchestratorContext;

  const res = await defaultSpawnChild(ctx, {
    runId,
    attemptId,
    cwd,
    promptPath: path.join(cwd, "prompt.md"),
    taskPrompt: "TASK",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    contract: contract(id),
  } as never);

  const parsed = await readScratchDiff(cwd, root);
  const digest =
    parsed.error === undefined
      ? createHash("sha256")
          .update(JSON.stringify(parsed.value))
          .digest("hex")
          .slice(0, 16)
      : `<не разобран: ${parsed.error.slice(0, 40)}>`;
  digests.set(id, digest);
  const sessions = fs.existsSync(path.join(cwd, "attempts"))
    ? fs.readdirSync(path.join(cwd, "attempts"))
    : [];
  console.log(
    `${id}: error=${res.error ?? "нет"} exit=${res.exitCode} ` +
      `сессий=${sessions.length} дайджест=${digest}`,
  );
}

const unique = new Set(digests.values());
console.log(
  `хостов: ${HOSTS.length}, различных разборов кандидата: ${unique.size}`,
);
console.log(`разбор одинаков у всех хостов: ${unique.size === 1}`);

fs.rmSync(root, { recursive: true, force: true });
