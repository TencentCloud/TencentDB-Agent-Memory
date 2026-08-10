/**
 * tz-09 Ф1 live probe: a real gateway, a real manual run, a real /status.
 *
 * Proves that a role run opens a control-plane Run BEFORE the child is
 * spawned, writes the scratch passport, and that the run is visible from
 * outside on GET /status. The child itself is expected to fail in the
 * sandbox (no credentials under the sandbox HOME) — the point is that the
 * protocol state exists regardless of how the child ends.
 *
 * Falsification: `FALSIFY=1` deletes the control-plane db right before the
 * /status read, and the probe must then print `runs=0`.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { controlPlanePath } from "../../src/gateway/control-plane/db.js";

const PORT = 8791;
const sbx = makeSandbox(["memory-keeper"]);
process.env.HOME = sbx.home;

// Config through a sandbox yaml: `Partial<GatewayConfig>` overrides REPLACE a
// whole section (memory.capture would vanish), so the probe configures the
// gateway the way an operator does.
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
  ].join("\n"),
  "utf-8",
);
process.env.TDAI_GATEWAY_CONFIG = cfgPath;

const gateway = new TdaiGateway();

await gateway.start();
const base = `http://127.0.0.1:${PORT}`;

const health = await fetch(`${base}/health`);
console.log(`GET /health -> ${health.status}`);

// token.ts:39 — the loopback token is a SIBLING of dataDir, not inside it.
const tokenFile = path.join(path.dirname(sbx.dataDir), "tdai-gateway.token");
const token = fs.existsSync(tokenFile)
  ? fs.readFileSync(tokenFile, "utf-8").trim()
  : "";

const run = await fetch(`${base}/memory/run`, {
  method: "POST",
  headers: { "x-memory-token": token, "content-type": "application/json" },
  body: "{}",
});
const runBody = (await run.json()) as { status: string; runId: string | null };
console.log(`POST /memory/run -> ${run.status} ${JSON.stringify(runBody)}`);

// The run is async: wait for the row to appear (the child may still be dying).
const deadline = Date.now() + 15_000;
let rows: unknown[] = [];
while (Date.now() < deadline) {
  const status = (await (await fetch(`${base}/status`)).json()) as {
    runs: unknown[];
  };
  rows = status.runs;
  if (rows.length > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}

if (process.env.FALSIFY === "1") {
  fs.rmSync(controlPlanePath(sbx.dataDir), { force: true });
  const status = (await (await fetch(`${base}/status`)).json()) as {
    runs: unknown[];
  };
  console.log(`FALSIFY: control-plane removed -> runs=${status.runs.length}`);
} else {
  console.log(`GET /status -> runs=${rows.length}`);
  console.log(JSON.stringify(rows[0], null, 2));
  const scratch = path.join(sbx.home, "scratch", "memory-keeper");
  const passports = fs.existsSync(scratch)
    ? fs
        .readdirSync(scratch)
        .map((d) => path.join(scratch, d, "run.json"))
        .filter((p) => fs.existsSync(p))
    : [];
  console.log(`run.json passports written: ${passports.length}`);
  if (passports[0]) console.log(fs.readFileSync(passports[0], "utf-8"));
}

await gateway.stop();
sbx.cleanup();
