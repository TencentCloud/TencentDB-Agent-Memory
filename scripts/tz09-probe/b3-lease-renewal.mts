/**
 * tz-09 Codex major #9: a lease/lock must not be stealable from a HEALTHY
 * owner just because the clock passed a fixed TTL.
 *
 * Both halves, on real files and the real control-plane db:
 *   A. the per-role file lock is renewed while the run is alive, so a second
 *      process asking for the same role after the original ttl is still
 *      refused;
 *   B. the Run lease is renewed the same way, so a takeover after the ttl no
 *      longer wins (and therefore no longer bumps the fence under a run that
 *      is still producing artefacts).
 *
 * FALSIFY=no-renew — skip the renewals: both are stolen, which is the defect.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { acquireRoleLock } from "../../src/gateway/consolidation/role-lock.js";
import { createRun } from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { runOwnerId } from "../../src/gateway/control-plane/owner.js";

const NO_RENEW = process.env.FALSIFY === "no-renew";
const TTL = 900;
const RUN = "run-b3";

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"} ttl=${TTL}ms`);

// ── A. the per-role file lock.
const lock = acquireRoleLock(dataDir, "memory-keeper", { ttlMs: TTL });
if (lock === null) throw new Error("could not take the role lock");

const mine = runOwnerId(process.pid);
createRun(
  dataDir,
  {
    runId: RUN,
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: "{}",
    binding: "{}",
  },
  new Date().toISOString(),
);
claimRun(dataDir, RUN, mine, { nowMs: Date.now(), ttlMs: TTL });

// The run works for three ttl's, renewing on the same schedule the
// orchestrator uses (ttl/3).
const beat = setInterval(
  () => {
    if (NO_RENEW) return;
    lock.renew();
    claimRun(dataDir, RUN, mine, { nowMs: Date.now(), ttlMs: TTL });
  },
  Math.floor(TTL / 3),
);
await new Promise((r) => setTimeout(r, TTL * 3));
clearInterval(beat);

const stolenLock = acquireRoleLock(dataDir, "memory-keeper", { ttlMs: TTL });
console.log(
  `после 3×ttl роль-лок у другого процесса: ${stolenLock !== null} ` +
    `(должно быть false)`,
);

const takeover = claimRun(dataDir, RUN, "someone-else", {
  nowMs: Date.now(),
  ttlMs: TTL,
});
console.log(
  `после 3×ttl лиза Run захвачена: ${takeover.ok} (должно быть false)` +
    (takeover.ok ? ` fence=${takeover.fence}` : ` — ${takeover.reason}`),
);

lock.release();
stolenLock?.release();
sbx.cleanup();
