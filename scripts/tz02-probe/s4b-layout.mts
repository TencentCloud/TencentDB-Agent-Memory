/**
 * tz-02 критерий 4 (S4): после прогона каталог попытки разложен по §3.5 —
 * `run.json`, `input/workset.json`, `out/result.json`, `out/critic.json`.
 *
 * Раскладка нужна не ради порядка: без `input/workset.json` разобрать прогон
 * постфактум нечем — вход восстанавливается только пересчётом от курсора, а
 * тот уже вернёт другие записи. Вердикт критика в `out/` рядом с результатом,
 * а не в корне, по той же причине: вход, выход и служебное не должны лежать
 * вперемешку.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=old-layout — роль пишет результат по снятому пути
 * `diff.json`. Прогон при этом проходит (fallback жив), но `out/result.json`
 * не появляется, и «все четыре файла §3.5 на месте» обязано стать false.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { parseConfig } from "../../src/config.js";
import { ConsolidationOrchestrator } from "../../src/gateway/consolidation/orchestrator.js";
import { digestOf } from "../../src/gateway/apply-executor/op-journal.js";
import {
  CRITIC_REL,
  LEGACY_RESULT_REL,
  RESULT_REL,
  WORKSET_REL,
} from "../../src/gateway/consolidation/attempt-layout.js";
import type { Logger } from "../../src/core/types.js";

const OLD_LAYOUT = process.env.FALSIFY === "old-layout";
const DIMS = 4;

let attemptDir: string | null = null;
/** Снимок раскладки СНУТРИ прогона: безусловное удаление scratch после
 * не-dry-run прогона (`day-runner.ts:119`) снимает Ф5, не эта проба. */
let snapshot: string[] = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (m: string) => console.log(`  ERROR ${m}`),
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
const scratchRoot = path.join(sbx.home, "scratch");
fs.mkdirSync(scratchRoot, { recursive: true });

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

let legacyPresent = false;
const LAYOUT = ["run.json", WORKSET_REL, RESULT_REL, CRITIC_REL];

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
  // Единственная заглушка — сам ребёнок.
  spawnChild: async (c: { role: string; cwd: string }) => {
    const dir = c.cwd;
    attemptDir = dir;
    if (c.role === "memory-keeper") {
      fs.writeFileSync(
        path.join(dir, OLD_LAYOUT ? LEGACY_RESULT_REL : RESULT_REL),
        JSON.stringify(CANDIDATE),
        "utf-8",
      );
    } else {
      fs.mkdirSync(path.dirname(path.join(dir, CRITIC_REL)), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(dir, CRITIC_REL),
        JSON.stringify({
          verdict: "approve",
          candidateDigest: digestOf(JSON.stringify(CANDIDATE)),
          reasons: ["probe"],
        }),
        "utf-8",
      );
      // Критик — последний ребёнок прогона: всё, что раскладка обещает, уже
      // на диске.
      snapshot = LAYOUT.filter((rel) => fs.existsSync(path.join(dir, rel)));
      legacyPresent = fs.existsSync(path.join(dir, LEGACY_RESULT_REL));
    }
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  },
} as never);

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

const summary = await orchestrator.executeRun({
  reason: "probe",
  role: "memory-keeper",
});
console.log(
  `run summary: status=${summary.status} error=${summary.error ?? "-"}`,
);

console.log(`каталог попытки: ${attemptDir ?? "(не создан)"}`);
for (const rel of LAYOUT) {
  console.log(`  ${rel}: ${snapshot.includes(rel) ? "есть" : "НЕТ"}`);
}
console.log(
  `все четыре файла §3.5 на месте: ${snapshot.length === LAYOUT.length} (должно быть true)`,
);
console.log(`результат по снятому пути: ${legacyPresent} (должно быть false)`);

store.close();
sbx.cleanup();
