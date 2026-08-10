/**
 * tz-09 Ф4a live probe: the critic bootstrap on a real gateway.
 *
 * The live `memory-keeper` declares `critic_role: "memory-critic"`, and that
 * package does not exist (only `dedup-daily-critic/prompt.md` does, which is
 * a prompt, not a role). So:
 *   enforce → the role is disabled BEFORE any run is created — no Run row,
 *             no child, no cost;
 *   shadow  → the same missing critic is logged and the run proceeds.
 *
 * That difference IS the falsification: one binary, one role, two gate modes.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { listRecentRuns } from "../../src/gateway/control-plane/run-repo.js";

const MODE = process.env.GATE_MODE === "shadow" ? "shadow" : "enforce";
const PORT = MODE === "shadow" ? 8794 : 8793;
const sbx = makeSandbox(["memory-keeper"]);
process.env.HOME = sbx.home;

const cfgPath = path.join(sbx.home, "tdai-gateway.yaml");
fs.writeFileSync(
  cfgPath,
  [
    "server:",
    "  host: 127.0.0.1",
    `  port: ${PORT}`,
    "data:",
    `  baseDir: ${sbx.dataDir}`,
    "memory:",
    "  consolidation:",
    "    enabled: true",
    `    applyGateMode: ${MODE}`,
  ].join("\n"),
  "utf-8",
);
process.env.TDAI_GATEWAY_CONFIG = cfgPath;

const roleFile = path.join(sbx.roleDir, "memory-keeper", "role.json");
const role = JSON.parse(fs.readFileSync(roleFile, "utf-8")) as {
  critic_role: string | null;
};
console.log(`gateMode=${MODE} critic_role=${role.critic_role}`);

const gateway = new TdaiGateway();
await gateway.start();
const token = fs
  .readFileSync(
    path.join(path.dirname(sbx.dataDir), "tdai-gateway.token"),
    "utf-8",
  )
  .trim();

const res = await fetch(`http://127.0.0.1:${PORT}/memory/run`, {
  method: "POST",
  headers: { "x-memory-token": token, "content-type": "application/json" },
  body: "{}",
});
const body = (await res.json()) as Record<string, unknown>;
console.log(`POST /memory/run -> ${res.status} ${JSON.stringify(body)}`);

await new Promise((r) => setTimeout(r, 2_000));
const runs = listRecentRuns(sbx.dataDir);
console.log(`control-plane runs=${runs.length}`);

await gateway.stop();
sbx.cleanup();
