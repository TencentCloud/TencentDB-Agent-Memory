/** One competing owner, in its own OS process. Prints `CLAIM <ok> <fence>`. */
import { claimRun } from "../../src/gateway/control-plane/lease.js";

const [dataDir, runId, owner] = process.argv.slice(2);
const res = claimRun(dataDir!, runId!, owner!, {
  nowMs: Date.now(),
  ttlMs: 60_000,
});
console.log(`CLAIM ${owner} ok=${res.ok} fence=${res.ok ? res.fence : "-"}`);
