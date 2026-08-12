/**
 * tz-09 Ф1 live probe: a real gateway, a real manual run, a real /status.
 *
 * Proves that a role run opens a control-plane Run BEFORE the child is
 * spawned, writes the scratch passport, and that the run is visible from
 * outside on GET /status. The child itself is expected to fail in the
 * sandbox (no credentials under the sandbox HOME) — the point is that the
 * protocol state exists regardless of how the child ends.
 *
 * The probe waits for the run to reach a TERMINAL state before stopping the
 * gateway: the child writes into the sandbox, and tearing the tree down under
 * a live run produced an ENOENT on `presented-diff.md` that looked like a
 * product defect and was only the probe racing its own cleanup.
 *
 * FALSIFY=1 deletes the control-plane db right before the /status read: the
 * run must then be invisible, which is what proves /status reads the control
 * plane and not some in-process leftover.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { controlPlanePath } from "../../src/gateway/control-plane/db.js";

const PORT = 8791;
const sbx = makeSandbox(["memory-keeper"]);
process.env.HOME = sbx.home;

// `keep_scratch` (tz-02 Ф5): without it run-role.ts:170 deletes the attempt
// dir at the end of the run, and the passport this probe reads is gone before
// the probe can look — the artefact is transient BY DESIGN, not missing.
const roleFile = path.join(sbx.roleDir, "memory-keeper", "role.json");
const role = JSON.parse(fs.readFileSync(roleFile, "utf-8")) as {
  runtime?: Record<string, unknown>;
};
role.runtime = { ...(role.runtime ?? {}), keep_scratch: true };
fs.writeFileSync(roleFile, JSON.stringify(role, null, 2), "utf-8");

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
must("ручной запуск роли принят", run.status === 200 || run.status === 202);

interface StatusRun {
  runId: string;
  role: string;
  state: string;
  errorClass: string | null;
}
const TERMINAL = new Set([
  "applied",
  "cancelled",
  "needs-reconciliation",
  "failed",
]);
/** The run is no longer in flight: either parked terminally, or classified —
 * `invalid-role-output` is NOT terminal for the Run (P9: the reaction is a new
 * attempt), so waiting for a terminal state alone would hang forever. */
const settled = (r: StatusRun): boolean =>
  TERMINAL.has(r.state) || r.errorClass !== null;
const readRuns = async (): Promise<StatusRun[]> =>
  ((await (await fetch(`${base}/status`)).json()) as { runs: StatusRun[] }).runs;

// The run is async. Wait for the row to appear AND to reach a terminal state:
// stopping the gateway and deleting the sandbox under a live child is a race
// of the probe's own making, and its ENOENT says nothing about the product.
const deadline = Date.now() + 60_000;
let rows: StatusRun[] = [];
while (Date.now() < deadline) {
  rows = await readRuns();
  if (rows.length > 0 && rows.every(settled)) break;
  await new Promise((r) => setTimeout(r, 500));
}
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

must(
  "Run открыт до спавна ребёнка: паспорт run.json лежит в scratch",
  passports.length > 0,
);
must(
  "прогон дошёл до исхода (терминальное состояние или класс отказа)",
  rows.length > 0 && rows.every(settled),
);

// Ф0 наблюдения сняты — теперь источник /status: снос control-plane db
// обязан убрать прогон из ответа.
if (process.env.FALSIFY === "1") {
  fs.rmSync(controlPlanePath(sbx.dataDir), { force: true });
}
const visible = await readRuns();
console.log(`  /status после проверки источника: runs=${visible.length}`);
must("прогон виден в /status из control-plane", visible.length > 0);

await gateway.stop();
sbx.cleanup();
finish();
