/**
 * tz-06 criterion 3 / S1 against the REAL host binaries.
 *
 * Every earlier probe spawned a shell stub, so no host had ever executed a
 * role through the port — the critic's second high finding. This one launches
 * the actual `claude` and `codex` on this machine through `RoleLauncher` and
 * asks each to WRITE a file into the run's cwd, which is the thing a role has
 * to be able to do: a host that answers but cannot write produces no candidate.
 *
 * Skips a host that is not installed instead of failing: the point is proof
 * where the binary exists, not a hard dependency on both.
 *
 * FALSIFY=no-identity — do not link the operator's credentials into the
 *   attempt home. Both hosts then run unauthenticated and write nothing, which
 *   is the defect this fix closed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClaudeLauncher } from "../../src/gateway/consolidation/launchers/claude.js";
import { createCodexLauncher } from "../../src/gateway/consolidation/launchers/codex.js";
import { resolveExecutable } from "../../src/gateway/consolidation/launchers/isolation.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { RoleLauncher } from "../../src/gateway/consolidation/launchers/types.js";
import type { Logger } from "../../src/core/types.js";

const NO_IDENTITY = process.env.FALSIFY === "no-identity";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f8-"));
const contract = {
  binding: { launcherId: "x", model: "", thinking: "low" },
  assets: {},
  timeoutMs: 180_000,
  toolsSubset: new Set<string>(),
  requiresCapabilities: [],
} as unknown as ResolvedRoleContract;

/** The env a real launch gets, minus the host homes the launcher owns. */
function envFor(home: string): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
  };
  if (process.env.SHELL !== undefined) base.SHELL = process.env.SHELL;
  return base;
}

async function tryHost(
  name: string,
  binary: string,
  model: string,
  make: (s: { binary: string }, l: Logger) => RoleLauncher,
): Promise<void> {
  const resolved = resolveExecutable(binary);
  if (resolved === null) {
    console.log(`${name}: не установлен на PATH — пропуск`);
    return;
  }
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd, { recursive: true });
  const promptPath = path.join(cwd, "prompt.md");
  fs.writeFileSync(
    promptPath,
    "You are a file-writing probe. Do exactly what the task says.",
    "utf-8",
  );

  const launcher = make({ binary: resolved }, silent);
  const started = Date.now();
  const out = await launcher.launch({
    runId: randomUUID(),
    attemptId: randomUUID(),
    cwd,
    promptPath,
    taskPrompt:
      `Write the single word PONG into the file "candidate.txt" ` +
      `in the current directory. Then stop.`,
    env: envFor(root),
    contract: { ...contract, binding: { ...contract.binding, model } },
  } as never);

  if (!out.ok) {
    console.log(`${name}: launch отвергнут — ${out.error.kind}`);
    return;
  }
  if (NO_IDENTITY) {
    // Remove the identity the launcher just linked: the child then starts
    // with an empty host home, exactly as it did before this fix.
    for (const f of [".credentials.json", "auth.json", "config.toml"]) {
      fs.rmSync(path.join(out.handle.sessionRef, f), { force: true });
    }
  }
  const res = await out.handle.completion;
  const wrote = fs.existsSync(path.join(cwd, "candidate.txt"));
  console.log(
    `${name}: статус=${res.status} код=${res.exitCode} ` +
      `за ${Math.round((Date.now() - started) / 1000)} c`,
  );
  console.log(`  роль записала кандидат: ${wrote}`);
  console.log(
    `  первые 120 байт stdout: ${JSON.stringify(res.stdout.slice(0, 120))}`,
  );
  console.log(
    `  spool-ссылка на полный stdout: ${res.stdoutFile !== null && res.stdoutFile !== undefined}`,
  );
}

/** The model this operator's codex account can actually run: the launcher
 * always passes the CONTRACT's model, so the probe has to name a real one or
 * it measures the account's entitlements instead of the port. */
function operatorCodexModel(): string {
  try {
    const cfg = fs.readFileSync(
      path.join(os.homedir(), ".codex", "config.toml"),
      "utf-8",
    );
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(cfg)?.[1] ?? "gpt-5.6-sol";
  } catch {
    return "gpt-5.6-sol";
  }
}

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
await tryHost(
  "claude",
  "claude",
  "claude-haiku-4-5-20251001",
  createClaudeLauncher,
);
await tryHost("codex", "codex", operatorCodexModel(), createCodexLauncher);

fs.rmSync(root, { recursive: true, force: true });
