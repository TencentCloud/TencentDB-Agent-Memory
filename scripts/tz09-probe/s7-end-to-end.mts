/**
 * tz-09 S7 live probe: one WHOLE role run through the real orchestrator path,
 * with every gate of the package armed.
 *
 * executeRunForRole → contract resolved and pinned → Run created and LEASED →
 * passport written → child (stubbed, so no real pi session) writes the
 * candidate → critic verdict → apply through the real ApplyExecutor with
 * runRepo + enforce → journal → run state.
 *
 * The child is the only thing stubbed: spawning a real sub-session would need
 * a model, and what this probe is about is the protocol around it.
 *
 * FALSIFY=1 makes the critic reject the candidate: nothing may reach the
 * store, and the run must not end `applied`.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { parseConfig } from "../../src/config.js";
import { ConsolidationOrchestrator } from "../../src/gateway/consolidation/orchestrator.js";
import { listRecentRuns } from "../../src/gateway/control-plane/run-repo.js";
import { listOps } from "../../src/gateway/control-plane/oplog.js";
import { CRITIC_VERDICT_FILE } from "../../src/gateway/consolidation/critic-launch.js";
import { digestOf } from "../../src/gateway/consolidation/critic-stage.js";
import type { Logger } from "../../src/core/types.js";

const APPROVE = process.env.FALSIFY !== "1";
const DIMS = 4;
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`  WARN ${m}`),
  error: (m: string) => console.log(`  ERROR ${m}`),
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
const scratchRoot = path.join(sbx.home, "scratch");
fs.mkdirSync(scratchRoot, { recursive: true });

// --- a role package the resolver accepts, with a critic role beside it ---
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
  ops_subset: ["deleteL1"],
  tools_subset: [],
  caps: { delete_per_run: 10, rewrite_per_run: 10 },
  max_run_ms: 600000,
  fail_on_missing_prompt: false,
  critic_role: null,
  runtime: { scratch_root: scratchRoot },
  ...over,
});
for (const [name, over] of [
  ["memory-keeper", { critic_role: "probe-critic" }],
  ["probe-critic", {}],
] as const) {
  const d = path.join(sbx.roleDir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "role.json"),
    JSON.stringify(roleJson(name, over), null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(d, "prompt.md"), `${name} prompt`, "utf-8");
}

// --- a store with one record the role will delete ---
const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
store.init();
const v = new Float32Array(DIMS);
v[1] = 1;
store.upsertL1(
  {
    id: "e2e_1",
    content: "duplicate to remove",
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-01T00:00:00Z"],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    sessionKey: "probe",
    sessionId: "probe",
    projectId: "",
    scope: "global",
  } as never,
  v,
);

const CANDIDATE = {
  deleteL1: [{ id: "e2e_1", updatedAt: "2026-08-01T00:00:00Z" }],
};

const orchestrator = new ConsolidationOrchestrator({
  config: { memory: parseConfig({}) } as never,
  enabled: true,
  roleDefaults: {} as never,
  launcher: { piBinary: "pi", spawnFlags: [] },
  dataDir,
  scratchRoot,
  roleDir: sbx.roleDir,
  logger,
  gatewayUrl: "http://127.0.0.1:1",
  applyGateMode: "enforce",
  applyRunRepo: true,
  vectorStore: () => store as never,
  embeddingService: () =>
    ({
      embed: async () => v,
      embedBatch: async (ts: string[]) => ts.map(() => v),
      getDimensions: () => DIMS,
      getProviderInfo: () => ({ provider: "fake", model: "fake" }),
      isReady: () => true,
      startWarmup: () => undefined,
      close: async () => undefined,
    }) as never,
  // The ONLY stub: the child that would otherwise be a real sub-session.
  spawnChild: async (c: { role: string; cwd: string }) => {
    const dir = c.cwd;
    fs.mkdirSync(dir, { recursive: true });
    if (c.role === "memory-keeper") {
      fs.writeFileSync(
        path.join(dir, "diff.json"),
        JSON.stringify(CANDIDATE),
        "utf-8",
      );
    } else {
      fs.writeFileSync(
        path.join(dir, CRITIC_VERDICT_FILE),
        JSON.stringify({
          verdict: APPROVE ? "approve" : "reject",
          candidateDigest: digestOf(CANDIDATE),
          reasons: [APPROVE ? "looks fine" : "probe rejection"],
        }),
        "utf-8",
      );
    }
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  },
} as never);

console.log(`critic verdict=${APPROVE ? "approve" : "reject"}`);
console.log(`records before: ${store.countL1()}`);

const summary = await orchestrator.executeRun({
  reason: "probe",
  role: "memory-keeper",
});

console.log(
  `run summary: status=${summary.status} error=${summary.error ?? "-"}`,
);
console.log(`records after:  ${store.countL1()}`);

const [row] = listRecentRuns(dataDir, 1);
console.log(
  `run row: state=${row?.state} fence=${row?.fence} owner=${row?.leaseOwner ?? "-"} ` +
    `errorClass=${row?.errorClass ?? "-"}`,
);
console.log(
  `oplog: ${JSON.stringify(
    listOps(dataDir, row?.runId ?? "").map(
      (o) => `${o.opIndex}:${o.opType}/${o.state}`,
    ),
  )}`,
);

store.close();
sbx.cleanup();
