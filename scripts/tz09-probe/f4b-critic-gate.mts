/**
 * tz-09 Ф4b live probe: the critic gate inside the REAL runBatch path.
 *
 * A synthetic critic returns a negative verdict on a candidate that is
 * otherwise perfectly applicable. The spy on applyDiff is what proves the
 * gate: apply must be called zero times in enforce, and once in shadow with
 * the identical inputs.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { runBatch } from "../../src/gateway/consolidation/runner.js";
import { resolveRoleContract } from "../../src/gateway/consolidation/role-contract.js";
import { createRun } from "../../src/gateway/control-plane/run-repo.js";
import { CRITIC_VERDICT_FILE } from "../../src/gateway/consolidation/critic-launch.js";
import { digestOf } from "../../src/gateway/consolidation/critic-stage.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";

const sbx = makeSandbox([]);
const roleDir = path.join(sbx.dataDir, "roles");
const scratch = path.join(sbx.home, "scratch", "run-1");
fs.mkdirSync(scratch, { recursive: true });

const roleJson = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  model: "opencode-go/deepseek-v4-flash",
  prompt_file: "prompt.md",
  enabled: true,
  thinking: "low",
  timeout_min: 10,
  scope: "fresh_tail",
  trigger: "manual_only",
  schedule: null,
  threshold: null,
  idsOnly: false,
  diff_cap: 20,
  diff_byte_cap: 8192,
  ops_subset: ["rewriteBlock"],
  tools_subset: [],
  caps: { delete_per_run: 10, rewrite_per_run: 10 },
  max_run_ms: 600000,
  fail_on_missing_prompt: false,
  critic_role: null,
  runtime: {},
  ...over,
});

for (const [name, over] of [
  ["keeper", { critic_role: "synthetic-critic" }],
  ["synthetic-critic", {}],
] as const) {
  const d = path.join(roleDir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "role.json"),
    JSON.stringify(roleJson(name, over)),
    "utf-8",
  );
  fs.writeFileSync(path.join(d, "prompt.md"), `${name} prompt`, "utf-8");
}

const resolved = resolveRoleContract("keeper", roleDir, {
  timeoutMs: 60_000,
  night: {
    diffCap: 200,
    diffByteCap: 16_384,
    deletePerRun: 25,
    rewritePerRun: 25,
    scheduleRole: "night-keeper",
    thresholdRole: "memory-keeper",
  },
  day: {
    diffCap: 20,
    diffByteCap: 8_192,
    deletePerRun: 50,
    rewritePerRun: 50,
    threshold: 50,
  },
  failOpenPromptRoles: [],
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  thinking: "low",
} as never);
if (!resolved.ok) throw new Error(`keeper did not resolve: ${resolved.reason}`);
// Держим сам контракт: сужение по resolved.ok не переживает границу
// функции ниже, а `as never` там скрыл бы протухание сигнатуры.
const keeperContract = resolved.contract;

const CANDIDATE = { rewriteBlock: [] };

async function attempt(mode: "enforce" | "shadow"): Promise<void> {
  createRun(
    sbx.dataDir,
    {
      runId: `run-${mode}`,
      roleId: "keeper",
      contractHash: "h",
      contractJson: "{}",
      binding: "{}",
    },
    new Date().toISOString(),
  );

  let applyCalls = 0;
  const ctx = {
    dataDir: sbx.dataDir,
    roleDir,
    roleDefaults: {} as never,
    applyGateMode: mode,
    gatewayUrl: "http://127.0.0.1:1",
    ownerPid: process.pid,
    scratchRoot: path.dirname(scratch),
    now: () => Date.now(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => console.log(`WARN ${m}`),
      error: () => undefined,
    },
    childrenRef: { value: new Map() },
    // The main role writes the candidate; the critic rejects it.
    spawnChild: async (a: { role: string }) => {
      if (a.role === "keeper") {
        fs.writeFileSync(
          path.join(scratch, "diff.json"),
          JSON.stringify(CANDIDATE),
          "utf-8",
        );
      } else {
        fs.writeFileSync(
          path.join(scratch, CRITIC_VERDICT_FILE),
          JSON.stringify({
            verdict: "reject",
            candidateDigest: digestOf(CANDIDATE),
            reasons: ["synthetic critic says no"],
          }),
          "utf-8",
        );
      }
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    },
    applyDiff: async () => {
      applyCalls += 1;
      return {
        ok: true,
        status: "applied",
        applied: { merges: [], deletes: [], rewrites: [] },
        skipped: { merges: [], deletes: [], rewrites: [] },
        skippedMergesMissingTarget: [],
        reindexed: false,
        needsReindex: false,
        partial: false,
      };
    },
  } as unknown as OrchestratorContext;

  const res = await runBatch(ctx, {
    reason: "probe",
    runId: `run-${mode}`,
    role: "keeper",
    contract: keeperContract,
    scratchDir: scratch,
    cp: { l0Cursor: "", lastRunAt: null },
    records: [],
    overLimit: [],
    remainingDeleteCap: 10,
    remainingRewriteCap: 10,
    startedMs: Date.now(),
    dryRun: false,
  } as never);

  console.log(
    `${mode}: applyCalls=${applyCalls} status=${res.status ?? "ok"} error=${res.error ?? "-"}`,
  );
}

await attempt("enforce");
fs.rmSync(path.join(scratch, CRITIC_VERDICT_FILE), { force: true });
await attempt("shadow");

sbx.cleanup();
