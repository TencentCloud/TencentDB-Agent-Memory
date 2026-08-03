#!/usr/bin/env bun
/**
 * Live per-role parallelism smoke (per-role-lock criterion 4): with a real
 * ConsolidationOrchestrator, start a memory-keeper run and, while it is in
 * flight, trigger night-keeper — both must be ACCEPTED (different roles run
 * in parallel; same-role second call must be busy).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { ConsolidationOrchestrator } from "../src/gateway/consolidation/orchestrator.js";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const dataDir = config.data.baseDir;
  const gatewayUrl = `http://${config.server.host}:${config.server.port}`;
  const home = process.env.HOME ?? "/root";
  const roleDir = resolveRoleDir(home);
  const sharedScratchRoot = path.join(path.dirname(dataDir), "tdai-memory-keeper");

  const orch = new ConsolidationOrchestrator({
    config,
    dataDir,
    scratchRoot: sharedScratchRoot,
    logger,
    gatewayUrl,
  });
  await orch.start();

  // Start memory-keeper (real, non-dry). It will run 1-5 min.
  const mk = await orch.trigger({ reason: "parallel-smoke-mk" });
  console.log("memory-keeper trigger:", mk.status, mk.accepted ? "accepted ✓" : "refused");
  if (!mk.accepted) {
    console.error("FAIL: memory-keeper refused at start");
    process.exit(1);
  }
  await sleep(300);

  // Same-role second → must be busy.
  const mk2 = await orch.trigger({ reason: "parallel-smoke-mk2" });
  console.log("same-role memory-keeper #2:", mk2.status, mk2.accepted ? "accepted (BAD)" : "busy ✓");
  if (mk2.accepted) {
    console.error("FAIL: same-role second trigger was accepted (single-flight broken)");
    process.exit(1);
  }

  // Different role (night-keeper) → must be ACCEPTED in parallel.
  const nk = await orch.trigger({ reason: "parallel-smoke-night", runType: "night-keeper" });
  console.log("night-keeper trigger:", nk.status, nk.accepted ? "accepted ✓" : "refused");
  if (!nk.accepted) {
    console.error("FAIL: night-keeper refused while memory-keeper in flight (per-role lock broken)");
    process.exit(1);
  }

  // Poll until both runs finish (bounded ~10 min).
  let waited = 0;
  while (orch.isRunning && waited < 600_000) {
    await sleep(5_000);
    waited += 5_000;
  }
  const last = orch.getLastRun();
  console.log("final isRunning:", orch.isRunning, "| waited:", Math.round(waited / 1000), "s");
  console.log("lastRun:", JSON.stringify(last, null, 2));
  await orch.stop();
  console.log("PARALLELISM OK: memory-keeper + night-keeper ran concurrently, same-role busy honored");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
