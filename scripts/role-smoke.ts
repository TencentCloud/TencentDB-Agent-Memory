#!/usr/bin/env bun
/**
 * Manual path-б smoke for the forked task-cycle role wiring (fork-task-cycle
 * -for-roles). Builds a ConsolidationOrchestrator with the PROD config,
 * fires a trigger for memory-keeper (dry-run), and verifies:
 *   1. per-role scratchRoot = <tdai>/runs/memory-keeper (from role.json
 *      runtime.scratch_root, not the shared scratchRoot)
 *   2. spawn args include --extension / --skill (from runtime)
 *   3. diff.json is pre-written into the scratch dir by preApply
 *
 * Dry-run builds the diff but does NOT spawn a keeper session or apply.
 * Run from the repo root: bun scripts/role-smoke.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { ConsolidationOrchestrator } from "../src/gateway/consolidation/orchestrator.js";
import { resolveRoleRuntimeFromDir } from "../src/gateway/consolidation/role-runtime.js";
import { buildRoleSpawnArgs } from "../src/gateway/consolidation/role-spawn-args.js";
import { resolveRoleDir } from "../src/gateway/role-paths.js";
import type { Logger } from "../src/core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const logger: Logger = {
  debug: () => undefined,
  info: (m?: unknown) => console.log(`[info] ${m ?? ""}`),
  warn: (m?: unknown) => console.warn(`[warn] ${m ?? ""}`),
  error: (m?: unknown) => console.error(`[error] ${m ?? ""}`),
};

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const dataDir = config.data.baseDir;
  const gatewayUrl = `http://${config.server.host}:${config.server.port}`;
  const home = process.env.HOME ?? "/root";
  const sharedScratchRoot = path.join(path.dirname(dataDir), "tdai-memory-keeper");
  const roleDir = resolveRoleDir(home);

  // 0. Role runtime — per-role scratchRoot must resolve from role.json
  const roleRt = resolveRoleRuntimeFromDir("memory-keeper", roleDir);
  if (!roleRt) {
    console.error("FAIL: resolveRoleRuntime(memory-keeper) returned null");
    process.exit(1);
  }
  console.log(`roleRt.runtime.scratchRoot: ${roleRt.runtime.scratchRoot}`);
  console.log(`roleRt.runtime.extensionPath: ${roleRt.runtime.extensionPath}`);
  console.log(`roleRt.runtime.skillPath: ${roleRt.runtime.skillPath}`);
  if (!roleRt.runtime.scratchRoot?.includes("runs/memory-keeper")) {
    console.error("FAIL: runtime.scratchRoot does not point at runs/memory-keeper");
    process.exit(1);
  }
  if (!roleRt.runtime.extensionPath?.includes("task-cycle-memory-keeper/index.ts")) {
    console.error("FAIL: runtime.extensionPath missing");
    process.exit(1);
  }

  const orch = new ConsolidationOrchestrator({
    config,
    dataDir,
    scratchRoot: sharedScratchRoot,
    logger,
    gatewayUrl,
  });

  // 0b. Spawn args — --no-extensions/--extension/--skill from the role runtime
  const childCtx = {
    role: "memory-keeper",
    env: {},
    promptPath: "/tmp/nonexistent-prompt.md",
    cwd: "/tmp",
  } as never;
  const args = buildRoleSpawnArgs(childCtx, roleDir);
  console.log("spawnArgs:", JSON.stringify(args));
  if (
    !args.includes("--no-extensions") ||
    !args.includes("--extension") ||
    !args.includes(roleRt.runtime.extensionPath ?? "") ||
    !args.includes("--skill") ||
    !args.includes(roleRt.runtime.skillPath ?? "")
  ) {
    console.error("FAIL: spawn args do not include --no-extensions/--extension/--skill from runtime");
    process.exit(1);
  }

  await orch.start();
  const res = await orch.trigger({
    reason: "manual-role-smoke",
    runType: "memory-keeper",
    dryRun: true,
  });
  console.log("trigger:", JSON.stringify(res));
  if (!res.accepted) {
    console.log("REFUSED — is another run in flight? check /status");
    await orch.stop();
    process.exit(1);
  }
  const freshRunId = res.runId;
  await new Promise((r) => setTimeout(r, 6_000));
  const last = orch.getLastRun();
  console.log("lastRun:", JSON.stringify(last, null, 2));
  await orch.stop();

  // 3. diff.json pre-write — look in the per-role runs dir
  const runsDir = roleRt.runtime.scratchRoot;
  const entries = [];
  try {
    const { readdirSync } = await import("node:fs");
    for (const runId of readdirSync(runsDir)) {
      const d = path.join(runsDir, runId);
      if (path.extname(runId)) continue;
      const files = readdirSync(d);
      if (files.includes("diff.json")) entries.push({ runId, files });
    }
  } catch (e) {
    console.error(`runs dir read failed: ${e}`);
  }
  console.log("runs/memory-keeper with diff.json:", JSON.stringify(entries));
  // The FRESH run from THIS smoke must carry diff.json — the apply-handshake
  // (gateway pre-writes it at spawn). Checking entries.length>0 alone
  // false-passes on stale runs if the per-role scratch override breaks;
  // assert the specific runId returned by the trigger.
  const freshEntry = entries.find((e) => e.runId === freshRunId);
  if (!freshEntry) {
    console.error(
      `FAIL: fresh run ${freshRunId} has no diff.json — apply-handshake broken`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
