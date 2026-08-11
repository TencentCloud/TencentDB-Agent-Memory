/**
 * tz-02 критерий 1, ПРИЧИНА отказа.
 *
 * План §0 берёт одну критическую секцию вместо двух межпроцессных локов, и
 * следствие этого решения — у отказа теперь ДВЕ разные причины: сдвинувшаяся
 * базовая линия (то, что требует критерий 1) и таймаут ожидания лока (то, что
 * бывает при заклиненном держателе). Тест, который просто ждёт «отказ»,
 * зелёный по неверной причине.
 *
 * Проба гоняет два apply на ОДИН файл: первый применяется, второй ждёт лок и
 * обязан получить отказ ПО БАЗОВОЙ ЛИНИИ, а не по таймауту.
 *
 * ФАЛЬСИФИКАЦИИ:
 *   FALSIFY=no-recheck   — второй apply идёт с пустым baseline (перепроверки
 *                          нет): он применяется поверх чужой правки, и
 *                          «отказ по базовой линии» обязан стать false.
 *   FALSIFY=tiny-timeout — держим лок и входим с waitMs=0: приходит ДРУГОЙ
 *                          отказ, и проба обязана его отличить, а не зачесть
 *                          как успех.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import { withStoreApplyLock } from "../../src/gateway/apply-executor/store-lock.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const MODE = process.env.FALSIFY ?? "";
const DIMS = 4;
const SLUG = "project-a";
const FILE = "scene-a.md";
const REL = `scene_blocks/${SLUG}/${FILE}`;

const v = new Float32Array(DIMS);
v[1] = 1;
const embedding: EmbeddingService = {
  embed: async () => v,
  embedBatch: async (ts: string[]) => ts.map(() => v),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const block = (body: string) =>
  [
    "-----META-START-----",
    "created: 2026-08-01T00:00:00Z",
    "updated: 2026-08-01T00:00:00Z",
    `summary: ${FILE}`,
    "heat: 1",
    "-----META-END-----",
    "",
    body,
    "",
  ].join("\n");

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
fs.mkdirSync(path.join(dataDir, "scene_blocks", SLUG), { recursive: true });
fs.writeFileSync(path.join(dataDir, REL), block("original"));

const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
store.init();
const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
});

const sha = () =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(dataDir, REL)))
    .digest("hex");

/** Обе роли сняли базовую линию ДО того, как любая из них что-то записала. */
const baseline = { [REL]: sha() };

const apply = (body: string, withBaseline: boolean) =>
  executor.apply({
    diff: { rewriteBlock: [{ path: REL, content: block(body) }] },
    manifest: { baseline: withBaseline ? baseline : {} },
    context: { presentedRecordIds: [] },
  });

console.log(`FALSIFY=${MODE || "(нет)"}`);

const [first, second] = await Promise.all([
  apply("ПРАВКА-1", true),
  apply("ПРАВКА-2", MODE !== "no-recheck"),
]);

const outcomes = [first, second];
const applied = outcomes.filter((r) => r.status === "applied").length;
const refusals = outcomes
  .filter((r) => r.status !== "applied")
  .map((r) => r.error ?? "");

// Классификатор причин — то, ради чего проба существует. Отказов, в тексте
// которых есть слово baseline, ТРИ, и засчитывать надо ровно один:
//   drift    — базовая линия сдвинулась под прогоном (критерий 1);
//   coverage — роль правит файл, которого не было в её baseline (не критерий 1);
//   timeout  — держатель лока не отпустил (заклинило, тоже не критерий 1).
const isDrift = (e: string) => /manifest drift/i.test(e);
const isCoverage = (e: string) =>
  /not covered by the manifest baseline/i.test(e);
const isLockTimeout = (e: string) =>
  /holds the store lock|refusing to mutate/i.test(e);

if (MODE === "tiny-timeout") {
  // Держим лок и входим с нулевым ожиданием: другой отказ, другая причина.
  await withStoreApplyLock(dataDir, async () => {
    try {
      await withStoreApplyLock(dataDir, async () => undefined, { waitMs: 0 });
      refusals.push("(таймаут не сработал)");
    } catch (err) {
      refusals.push(err instanceof Error ? err.message : String(err));
    }
  });
}

console.log(`применилось прогонов: ${applied} из 2 (должно быть 1)`);
for (const e of refusals) console.log(`  отказ: ${e.slice(0, 110)}`);
// Отдельный замер ОЖИДАНИЯ: держим лок известное время и смотрим, сколько
// провисел apply. «Прошло больше нуля» не измеряет ничего — ждать надо ровно
// столько, сколько держали.
const HOLD_MS = 700;
let waitedMs = 0;
await withStoreApplyLock(dataDir, async () => {
  const t0 = Date.now();
  // Свежая базовая линия: этот apply обязан ДОЙТИ до лока, а не отсеяться
  // раньше на покрытии или на дрейфе — иначе замер меряет отказ, не ожидание.
  const fresh = { [REL]: sha() };
  const pending = executor
    .apply({
      diff: { rewriteBlock: [{ path: REL, content: block("ПРАВКА-3") }] },
      manifest: { baseline: fresh },
      context: { presentedRecordIds: [] },
    })
    .then(() => {
      waitedMs = Date.now() - t0;
    });
  await new Promise((r) => setTimeout(r, HOLD_MS));
  // Отпускаем лок выходом из этой функции; ждём apply уже снаружи.
  void pending;
  await Promise.resolve();
});
await new Promise((r) => setTimeout(r, 300));
console.log(
  `apply прождал держателя ${waitedMs} мс из ${HOLD_MS} — ` +
    `дождался лока, а не прошёл мимо: ${waitedMs >= HOLD_MS} (должно быть true)`,
);

console.log(
  `отказ по сдвинувшейся базовой линии: ${refusals.some(isDrift)} (должно быть true)`,
);
console.log(
  `отказ по непокрытому пути: ${refusals.some(isCoverage)} (должно быть false)`,
);
console.log(
  `отказ по таймауту лока: ${refusals.some(isLockTimeout)} (должно быть false)`,
);
console.log(
  `на диске: ${fs.readFileSync(path.join(dataDir, REL), "utf-8").includes("ПРАВКА") ? "одна из правок" : "исходный"}`,
);

store.close();
sbx.cleanup();
