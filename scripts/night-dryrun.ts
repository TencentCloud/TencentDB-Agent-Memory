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
import { buildRoleDefaults } from "../src/gateway/role-defaults.js";
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
  // Корень scratch резолвит конфиг — второй вывод той же формулы
  // разъезжается с гейтвеем при заданном TDAI_SCRATCH_ROOT.
  const scratchRoot = config.data.scratchRoot;

  console.log(`dataDir: ${dataDir}`);
  console.log(`scratchRoot: ${scratchRoot}`);
  console.log(`gatewayUrl: ${gatewayUrl}`);

  const consolidationCfg = config.memory.consolidation;
  const orch = new ConsolidationOrchestrator({
    config,
    enabled: consolidationCfg.enabled,
    roleDefaults: buildRoleDefaults(consolidationCfg),
    launchers: consolidationCfg.launchers,
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
