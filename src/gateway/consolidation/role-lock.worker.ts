/**
 * Worker for role-lock.cross-process.test.ts — NOT a test file.
 *
 * A second real process that builds a full ConsolidationOrchestrator on a
 * shared dataDir and asks it to run a role. The probe goes through
 * `runNow`, not through `acquireRoleLock` directly: the point is whether the
 * lock is actually WIRED into the trigger path, which a unit test of the
 * lock module alone cannot show.
 *
 * argv: <dataDir> <roleDir> <role> <barrierFile>
 * stdout: one line `RESULT <status> <error?>` — a refused run comes back as
 * status "failed" plus the single-flight error, which the test classifies.
 */
import fs from "node:fs";
import path from "node:path";
import { parseConfig } from "../../config.js";
import { ConsolidationOrchestrator } from "./orchestrator.js";
import { buildRoleDefaults, buildLauncherDefaults } from "../role-defaults.js";
import type { GatewayConfig } from "../config.js";

const [dataDir, roleDir, role, barrier] = process.argv.slice(2);

const memory = parseConfig({
  consolidation: {
    enabled: true,
    diffCap: 10,
    diffByteCap: 4096,
    timeoutMs: 5000,
  },
  nightRun: { schedule: "06:00", threshold: 50, timezone: "system" },
});
const config = {
  server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
  data: { baseDir: dataDir },
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "fake",
    maxTokens: 1,
    timeoutMs: 1,
    disableThinking: false,
  },
  memory,
} as unknown as GatewayConfig;

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const orch = new ConsolidationOrchestrator({
  config,
  enabled: true,
  roleDefaults: buildRoleDefaults(memory.consolidation),
  launcher: buildLauncherDefaults(memory.consolidation),
  dataDir,
  scratchRoot: path.join(dataDir, "scratch"),
  logger: silent,
  gatewayUrl: "http://127.0.0.1:1",
  roleName: role,
  roleDir,
  applyDiff: async () =>
    ({
      ok: true,
      applied: { merges: [], deletes: [], rewrites: [] },
      skipped: { merges: [], deletes: [], rewrites: [] },
      needsReindex: false,
    }) as never,
  // Hold the run until the barrier file disappears: that is the window in
  // which the OTHER process must be refused.
  spawnChild: async (ctx) => {
    fs.writeFileSync(`${barrier}.${role}.ready`, String(process.pid), "utf-8");
    while (fs.existsSync(barrier)) await sleep(20);
    await fs.promises.writeFile(
      path.join(ctx.scratchDir, "diff.json"),
      JSON.stringify({}),
      "utf-8",
    );
    return {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      killed: null,
    };
  },
});

const summary = await orch.runNow({ reason: "lock-probe", runType: role });
process.stdout.write(`RESULT ${summary.status} ${summary.error ?? ""}\n`);
