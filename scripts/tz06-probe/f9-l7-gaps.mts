/**
 * tz-06 L7 gaps from Codex major #6.
 *
 *   A. a descendant that calls `setsid()` leaves the child's process group, so
 *      `kill -- -<pgid>` never reached it and the "cancelled" run left a live
 *      process behind;
 *   B. the spool file is named in the result, so it has to be COMPLETE when
 *      the result arrives. NOTE: the truncation this guards against could NOT
 *      be reproduced here — 16 MB through a fast-exiting child came out whole
 *      on the old code too. The flush-before-resolve is kept as a defence
 *      against a slow disk, not as a fix for an observed defect; the line
 *      below is a regression guard, not a falsified claim.
 *
 * FALSIFY=group-only — kill by process group alone (the old behaviour): the
 *   setsid grandchild survives.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "../../src/gateway/consolidation/launchers/child-process.js";
import {
  killProcessGroup,
  readPgrpOf,
  snapshotTree,
} from "../../src/gateway/consolidation/keeper-proc.js";
import type { Logger } from "../../src/core/types.js";

const GROUP_ONLY = process.env.FALSIFY === "group-only";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f9-"));
const marker = path.join(root, "escapee.pid");

// A child that (1) spawns a setsid grandchild which outlives it and (2)
// prints 12 MB, so the spool has real work to flush.
const script = path.join(root, "child.sh");
fs.writeFileSync(
  script,
  `#!/bin/sh
setsid sh -c 'echo $$ > "${marker}"; sleep 300' &
awk 'BEGIN{s="";while(length(s)<4000)s=s "x";for(i=0;i<4000;i++)print s}'
sleep 60
`,
  { mode: 0o755 },
);

const started = Date.now();
const run = runChildProcess({
  binary: script,
  args: [],
  cwd: root,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
  timeoutMs: 4000,
  logger: silent,
  onChild: (child) => {
    if (!GROUP_ONLY) return;
    // The old kill: the process group and nothing else.
    setTimeout(() => {
      const pgid = readPgrpOf(child.pid ?? 0);
      if (pgid !== null) killProcessGroup(pgid);
    }, 3000);
  },
});

// Let the grandchild register itself before anything is killed.
await new Promise((r) => setTimeout(r, 1500));
const escapee = Number(fs.readFileSync(marker, "utf-8").trim());
console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`внук с setsid: pid=${escapee}`);
console.log(
  `  он вне группы ребёнка: ${snapshotTree(process.pid).includes(escapee)}`,
);

const res = await run;
// The kill is asynchronous in the kernel; give it a moment before asking.
await new Promise((r) => setTimeout(r, 500));
const alive = readPgrpOf(escapee) !== null;
console.log(
  `результат: статус=${res.timedOut ? "timed_out" : "exited"} ` +
    `за ${Math.round((Date.now() - started) / 1000)} c`,
);
console.log(`  внук убит вместе с деревом: ${!alive}`);

const spooled =
  res.stdoutFile === null || res.stdoutFile === undefined
    ? -1
    : fs.statSync(res.stdoutFile).size;
console.log(
  `  spool-файл полон на момент результата: ${spooled === res.stdoutBytes} ` +
    `(${spooled} из ${res.stdoutBytes})`,
);

if (alive) {
  try {
    process.kill(escapee, "SIGKILL");
  } catch {
    /* already gone */
  }
}
fs.rmSync(root, { recursive: true, force: true });
