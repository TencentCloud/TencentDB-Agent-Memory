#!/usr/bin/env bun
/**
 * Manual NIGHT dry-run for the production gateway — B7 integration check.
 *
 * Builds a ConsolidationOrchestrator with the PROD config + dataDir and fires
 * a trigger({ reason: "manual-night-dryrun", runType: "night-keeper",
 * dryRun: true }). Dry-run builds the diff for every chunk but does NOT
 * spawn a keeper session, apply anything, or advance the checkpoint.
 *
 * Run from the repo root:
 *   bun scripts/night-dryrun.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { ConsolidationOrchestrator } from "../src/gateway/consolidation/orchestrator.js";
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
  const scratchRoot = path.join(path.dirname(dataDir), "tdai-memory-keeper");

  console.log(`dataDir: ${dataDir}`);
  console.log(`scratchRoot: ${scratchRoot}`);
  console.log(`gatewayUrl: ${gatewayUrl}`);

  const orch = new ConsolidationOrchestrator({
    config,
    dataDir,
    scratchRoot,
    logger,
    gatewayUrl,
  });

  await orch.start();
  const res = await orch.trigger({
    reason: "manual-night-dryrun",
    runType: "night-keeper",
    dryRun: true,
  });
  console.log("trigger:", JSON.stringify(res));
  if (!res.accepted) {
    console.log("REFUSED — is another run in flight? check /status");
    return;
  }
  // trigger is async (void executeRun). Give the dry-run a moment to finish.
  await new Promise((r) => setTimeout(r, 5_000));
  const last = orch.getLastRun();
  console.log("lastRun:", JSON.stringify(last, null, 2));
  await orch.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
