/**
 * tz-09 S3 (вторая половина) live probe: a run killed mid-flight is settled by
 * the NEXT gateway start, and that is what moves the fence.
 *
 * Before this wiring `claimRun` was reachable only from tests: fence stayed 1
 * for every real run, so the artefact-fence check downstream compared 1 with 1
 * and could never refuse anything. Here a real gateway boots twice on the same
 * dataDir with runs left behind by a "dead" process.
 *
 * Falsification is done from outside: stub out the recoverOrphanRuns call in
 * consolidation/triggers.ts and re-run — the runs stay live at fence 1 and the
 * stale artefact is ACCEPTED, which is the pre-fix state.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { parseConfig } from "../../src/config.js";
import {
  createRun,
  readRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { checkArtifactFence } from "../../src/gateway/control-plane/fence.js";

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
  recursive: true,
});
fs.mkdirSync(path.join(dataDir, "records"), { recursive: true });
fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });

const now = new Date().toISOString();
for (const [runId, state] of [
  ["run-running", "running"],
  ["run-applying", "applying"],
] as const) {
  createRun(
    dataDir,
    {
      runId,
      roleId: "memory-keeper",
      contractHash: "h",
      contractJson: "{}",
      binding: "{}",
    },
    now,
  );
  // A process that is gone held the lease — that is what a takeover has to
  // wrest away, and what makes the fence move.
  claimRun(dataDir, runId, "dead-host:999999", {
    nowMs: Date.now() - 3_600_000,
    ttlMs: 1,
  });
  updateRun(dataDir, runId, { state }, now);
}

const before = [
  readRun(dataDir, "run-running"),
  readRun(dataDir, "run-applying"),
];
console.log(
  `before start: ${before
    .map((r) => `${r?.runId}=${r?.state}/fence=${r?.fence}`)
    .join(" ")}`,
);

const port = 29_800 + Math.floor(Math.random() * 150);
const gateway = new TdaiGateway({
  data: { baseDir: dataDir },
  server: { port, host: "127.0.0.1", corsOrigins: [] },
  memory: parseConfig({}),
});
await gateway.start();
await gateway.stop();

const after = [
  readRun(dataDir, "run-running"),
  readRun(dataDir, "run-applying"),
];
console.log(
  `after start:  ${after
    .map((r) => `${r?.runId}=${r?.state}/fence=${r?.fence}`)
    .join(" ")}`,
);

// The artefact the dead child left behind carries the OLD fence.
for (const r of before) {
  if (r === null) continue;
  const check = checkArtifactFence(dataDir, r.runId, r.fence);
  console.log(
    `  stale artefact of ${r.runId} (fence ${r.fence}): ` +
      `${check.ok ? "ACCEPTED" : `REFUSED — ${check.reason}`}`,
  );
}

sbx.cleanup();
