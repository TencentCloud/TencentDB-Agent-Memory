/**
 * tz-09 Ф2b live probe: a real run fails, and its failure CLASS lands on the
 * Run row where the next dispatch can see it.
 *
 * The child cannot produce a diff in the sandbox (no credentials under the
 * sandbox HOME), so the run fails at the launch/output stage — exactly the
 * `transient-launcher` class. What matters is that `errorClass` is written
 * at all: before Ф2b a failed run left nothing but a report file.
 *
 * Falsification (`FALSIFY=1`): read the row BEFORE the run finishes — the
 * class is absent, so the value cannot be coming from the row's defaults.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { listRecentRuns } from "../../src/gateway/control-plane/run-repo.js";

const PORT = 8792;
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
  ].join("\n"),
  "utf-8",
);
process.env.TDAI_GATEWAY_CONFIG = cfgPath;

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
console.log(`POST /memory/run -> ${res.status}`);

if (process.env.FALSIFY === "1") {
  const early = listRecentRuns(sbx.dataDir)[0];
  console.log(
    `FALSIFY: read before the run ends -> state=${early?.state} errorClass=${early?.errorClass}`,
  );
} else {
  const deadline = Date.now() + 60_000;
  let row = listRecentRuns(sbx.dataDir)[0];
  while (Date.now() < deadline && (row?.errorClass ?? null) === null) {
    await new Promise((r) => setTimeout(r, 500));
    row = listRecentRuns(sbx.dataDir)[0];
  }
  console.log(
    `run row -> state=${row?.state} errorClass=${row?.errorClass} finishedAt=${row?.finishedAt}`,
  );
  const status = (await (
    await fetch(`http://127.0.0.1:${PORT}/status`)
  ).json()) as { runs: Array<Record<string, unknown>> };
  console.log(`GET /status runs[0] -> ${JSON.stringify(status.runs[0])}`);
}

await gateway.stop();
sbx.cleanup();
