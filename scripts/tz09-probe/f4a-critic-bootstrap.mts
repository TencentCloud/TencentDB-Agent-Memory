/**
 * tz-09 Ф4a live probe: the critic bootstrap on a real gateway.
 *
 * The live `memory-keeper` declares `critic_role: "memory-critic"`, and that
 * package does not exist (only `dedup-daily-critic/prompt.md` does, which is
 * a prompt, not a role). So the same binary, the same role, two gate modes:
 *   enforce → the role is disabled BEFORE any run is created — no Run row,
 *             no child, no cost;
 *   shadow  → the same missing critic is logged and the run proceeds.
 *
 * Both halves run in ONE command, because the shadow half is what proves the
 * enforce half is a gate and not an accident of the sandbox.
 *
 * FALSIFY=no-bootstrap-gate — runs the enforce half in shadow: a Run appears
 * despite the missing critic, and the enforce observation goes false.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { listRecentRuns } from "../../src/gateway/control-plane/run-repo.js";
import { must, finish } from "../tz07-probe/assert.mts";

type GateMode = "enforce" | "shadow";

/** The real HOME. `makeSandbox` copies the live role out of `os.homedir()`,
 * and each half of this probe repoints HOME at its own sandbox — without
 * restoring it first, the second half would look for the role inside the
 * sandbox the first half just deleted. */
const REAL_HOME = process.env.HOME ?? "";

/** Boot a gateway in `mode`, fire one manual run, report the Run rows it left. */
async function runsAfterManualRun(
  mode: GateMode,
  port: number,
): Promise<number> {
  process.env.HOME = REAL_HOME;
  const sbx = makeSandbox(["memory-keeper"]);
  process.env.HOME = sbx.home;

  const cfgPath = path.join(sbx.home, "tdai-gateway.yaml");
  fs.writeFileSync(
    cfgPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      "data:",
      `  baseDir: ${sbx.dataDir}`,
      "memory:",
      "  consolidation:",
      "    enabled: true",
      `    applyGateMode: ${mode}`,
    ].join("\n"),
    "utf-8",
  );
  process.env.TDAI_GATEWAY_CONFIG = cfgPath;

  const roleFile = path.join(sbx.roleDir, "memory-keeper", "role.json");
  const role = JSON.parse(fs.readFileSync(roleFile, "utf-8")) as {
    critic_role: string | null;
  };
  console.log(`gateMode=${mode} critic_role=${role.critic_role}`);

  const gateway = new TdaiGateway();
  await gateway.start();
  try {
    const token = fs
      .readFileSync(
        path.join(path.dirname(sbx.dataDir), "tdai-gateway.token"),
        "utf-8",
      )
      .trim();
    const res = await fetch(`http://127.0.0.1:${port}/memory/run`, {
      method: "POST",
      headers: { "x-memory-token": token, "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json()) as Record<string, unknown>;
    console.log(`  POST /memory/run -> ${res.status} ${JSON.stringify(body)}`);

    await new Promise((r) => setTimeout(r, 2_000));
    const runs = listRecentRuns(sbx.dataDir).length;
    console.log(`  control-plane runs=${runs}`);
    return runs;
  } finally {
    await gateway.stop();
    sbx.cleanup();
  }
}

const enforceMode: GateMode =
  process.env.FALSIFY === "no-bootstrap-gate" ? "shadow" : "enforce";
const enforced = await runsAfterManualRun(enforceMode, 8793);
must(
  "недостающий критик отключает роль ДО создания Run: ни одной строки",
  enforced === 0,
);

const shadowed = await runsAfterManualRun("shadow", 8794);
must(
  "контроль: в shadow тот же недостающий критик прогон не блокирует",
  shadowed > 0,
);

finish();
