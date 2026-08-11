/**
 * tz-02 критерий 4a, вторая половина: при отсутствии нового места работает
 * fallback на снятый путь `diff.json` — и на входе (роль), и на выходе
 * (гейтвей). Окно отката существует именно для этого: пакет роли, ещё несущий
 * старую инструкцию, обязан деградировать в «сработал по-старому», а не в
 * «ничего не произвёл».
 *
 * Ноги:
 *   ВХОД  — роль, как велит ЖИВОЙ текст SKILL.md, ищет вход в новом месте,
 *           а когда его нет, читает снятый путь. Каталог попытки при этом
 *           приводится к до-Ф4 виду прямо перед чтением.
 *   ВЫХОД — роль пишет результат ТОЛЬКО в `diff.json`; настоящий читатель
 *           гейтвея (`scratch-diff.ts` → `resolveResultPath`) обязан его
 *           принять, и прогон обязан дойти до apply.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=no-fallback — роль не пишет результат никуда. Это
 * контроль над второй ногой: если прогон и без снятого пути «успешен», значит
 * успех приходил не оттуда, и наблюдение ничего не стоило.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { parseConfig } from "../../src/config.js";
import { ConsolidationOrchestrator } from "../../src/gateway/consolidation/orchestrator.js";
import { CRITIC_VERDICT_FILE } from "../../src/gateway/consolidation/critic-launch.js";
import { digestOf } from "../../src/gateway/consolidation/critic-stage.js";
import {
  LEGACY_RESULT_REL,
  PRESENTED_REL,
  WORKSET_REL,
} from "../../src/gateway/consolidation/attempt-layout.js";
import type { Logger } from "../../src/core/types.js";

const NO_FALLBACK = process.env.FALSIFY === "no-fallback";
const DIMS = 4;

/** Порядок чтения входа — из ЖИВОГО текста скилла, не из моей памяти. */
const SKILL = "src/core/prompts/skills/memory-keeper/SKILL.md";
const inputLine =
  fs
    .readFileSync(SKILL, "utf-8")
    .split("\n")
    .find((l) => l.includes("гейтвей записывает его в")) ?? "";
const namedPaths = [...inputLine.matchAll(/<cwd>\/([^`*\s)]+)/g)].map(
  (m) => m[1] as string,
);

let roleSawVia: string | null = null;
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
    if (c.role === "memory-keeper") {
      // Приводим каталог попытки к ДО-Ф4 виду: нового места нет, вход лежит
      // там, где его писал прежний пайплайн.
      const text = fs.readFileSync(path.join(dir, PRESENTED_REL), "utf-8");
      fs.rmSync(path.join(dir, WORKSET_REL), { force: true });
      fs.rmSync(path.join(dir, PRESENTED_REL), { force: true });
      fs.writeFileSync(path.join(dir, LEGACY_RESULT_REL), text, "utf-8");

      // Роль читает вход строго в том порядке, который называет SKILL.md.
      for (const rel of namedPaths) {
        if (fs.existsSync(path.join(dir, rel))) {
          roleSawVia = rel;
          break;
        }
      }
      if (!NO_FALLBACK) {
        fs.writeFileSync(
          path.join(dir, LEGACY_RESULT_REL),
          JSON.stringify(CANDIDATE),
          "utf-8",
        );
      } else {
        fs.rmSync(path.join(dir, LEGACY_RESULT_REL), { force: true });
      }
    } else {
      fs.mkdirSync(path.dirname(path.join(dir, CRITIC_VERDICT_FILE)), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(dir, CRITIC_VERDICT_FILE),
        JSON.stringify({
          verdict: "approve",
          candidateDigest: digestOf(CANDIDATE),
          reasons: ["probe"],
        }),
        "utf-8",
      );
    }
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  },
} as never);

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`SKILL.md называет вход по порядку: ${JSON.stringify(namedPaths)}`);

const summary = await orchestrator.executeRun({
  reason: "probe",
  role: "memory-keeper",
});
console.log(
  `run summary: status=${summary.status} error=${summary.error ?? "-"}`,
);
console.log(`роль нашла вход через: ${roleSawVia ?? "(нигде)"}`);
console.log(
  `fallback входа сработал: ${roleSawVia === LEGACY_RESULT_REL} (должно быть true)`,
);
console.log(
  `гейтвей принял результат по снятому пути: ` +
    `${summary.status === "ok"} (должно быть true)`,
);

store.close();
sbx.cleanup();
