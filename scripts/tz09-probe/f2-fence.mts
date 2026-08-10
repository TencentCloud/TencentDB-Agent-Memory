/**
 * tz-09 Ф2 live probe: cross-process claim + fence on a real control plane.
 *
 * Two separate OS processes race for the same Run; exactly one may own it.
 * Then the winner's lease is left to expire, a third owner takes over, and
 * the artefact the first owner left in its scratch dir is refused at
 * ingestion — the path `preApply` uses.
 *
 * Falsification (`FALSIFY=1`): skip the takeover, and the same artefact is
 * accepted — proving the rejection comes from the fence, not from the shape
 * of the passport.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { createRun } from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { rejectStaleArtifact } from "../../src/gateway/consolidation/artifact-fence.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";

const sbx = makeSandbox([]);
const RUN = "probe-run-1";
const scratch = path.join(sbx.home, "scratch", RUN);
fs.mkdirSync(scratch, { recursive: true });

createRun(
  sbx.dataDir,
  {
    runId: RUN,
    roleId: "memory-keeper",
    contractHash: "h",
    contractJson: "{}",
    binding: "{}",
    scratchPath: scratch,
  },
  new Date().toISOString(),
);

// 1. Two real processes race for the lease.
const worker = path.join(import.meta.dirname, "f2-claim-worker.mts");
const race = ["owner-a", "owner-b"].map((owner) =>
  spawnSync("npx", ["tsx", worker, sbx.dataDir, RUN, owner], {
    encoding: "utf-8",
  }),
);
const lines = race.map((r) => r.stdout.trim().split("\n").pop() ?? "");
for (const l of lines) console.log(l);
const winners = lines.filter((l) => l.includes("ok=true"));
console.log(`winners=${winners.length} (must be 1)`);

const ctx = {
  dataDir: sbx.dataDir,
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: (m: string) => console.log(`WARN ${m}`),
    error: () => undefined,
  },
} as unknown as OrchestratorContext;

// 2. The winner writes its passport, exactly as run-role.ts does before spawn.
const fence = Number(/fence=(\d+)/.exec(winners[0] ?? "")?.[1] ?? "1");
fs.writeFileSync(
  path.join(scratch, "run.json"),
  JSON.stringify({
    runId: RUN,
    fence,
    owner: "winner",
    role: "memory-keeper",
    copyOf: "control-plane.db",
  }),
  "utf-8",
);
console.log(`passport fence=${fence}`);

// 3. Takeover by a third owner once the lease has expired.
if (process.env.FALSIFY !== "1") {
  const taken = claimRun(sbx.dataDir, RUN, "owner-c", {
    nowMs: Date.now() + 3_600_000,
    ttlMs: 60_000,
  });
  console.log(`takeover ok=${taken.ok} fence=${taken.ok ? taken.fence : "-"}`);
}

// 4. Ingestion of the OLD artefact — the exact call preApply makes.
const verdict = rejectStaleArtifact(ctx, RUN, scratch);
console.log(
  process.env.FALSIFY === "1"
    ? `FALSIFY: no takeover -> ingestion=${verdict === null ? "ACCEPTED" : verdict}`
    : `ingestion=${verdict === null ? "ACCEPTED" : verdict}`,
);

sbx.cleanup();
