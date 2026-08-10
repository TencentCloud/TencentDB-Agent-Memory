/**
 * tz-02 (баг из ревью кристалла): роль читает ВХОД по пути, который SKILL.md
 * ей называет, а гейтвей этот путь перед спавном удаляет.
 *
 * `runner-stages.ts:86` пишет вход в `presented-diff.md`, `:93` сносит
 * `diff.json` (чтобы вход нельзя было спутать с выходом), а три keeper-скилла
 * говорили роли «гейтвей записывает его в <cwd>/diff.json… Читай оттуда».
 *
 * Проба гоняет РЕАЛЬНЫЙ orchestrator (стаб — только сам ребёнок) и в роли
 * делает ровно то, что велит SKILL.md: достаёт имя файла из живого текста
 * скилла и пытается прочитать его в cwd.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=old-path — читать `diff.json`, как говорил скилл до
 * фикса. Проба обязана покраснеть: файла нет.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { parseConfig } from "../../src/config.js";
import { ConsolidationOrchestrator } from "../../src/gateway/consolidation/orchestrator.js";
import { CRITIC_VERDICT_FILE } from "../../src/gateway/consolidation/critic-launch.js";
import { digestOf } from "../../src/gateway/consolidation/critic-stage.js";
import type { Logger } from "../../src/core/types.js";

const OLD_PATH = process.env.FALSIFY === "old-path";
const APPROVE = true;

/** Имя входного файла — из ЖИВОГО текста скилла, не из моей памяти. */
const SKILL = "src/core/prompts/skills/memory-keeper/SKILL.md";
const line = fs
  .readFileSync(SKILL, "utf-8")
  .split("\n")
  .find((l) => l.includes("гейтвей записывает его в"));
const named = OLD_PATH
  ? "diff.json"
  : (/<cwd>\/([^`*\s]+)/.exec(line ?? "")?.[1] ?? "<не нашёл>");
let roleSaw: string | null = null;
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
      // Роль делает ровно то, что ей велит SKILL.md.
      const input = path.join(dir, named);
      roleSaw = fs.existsSync(input)
        ? fs.readFileSync(input, "utf-8").slice(0, 60)
        : null;
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

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`SKILL.md называет входом: ${named}`);

const summary = await orchestrator.executeRun({
  reason: "probe",
  role: "memory-keeper",
});

console.log(
  `run summary: status=${summary.status} error=${summary.error ?? "-"}`,
);
console.log(
  `роль нашла вход по этому пути: ${roleSaw !== null} (должно быть true)`,
);
console.log(`первые 60 байт входа: ${JSON.stringify(roleSaw)}`);

store.close();
sbx.cleanup();
