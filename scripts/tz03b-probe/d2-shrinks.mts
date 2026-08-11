/**
 * tz-03b Ф6/S2a — счётчик УМЕЕТ уменьшаться (ТЗ критерий 1a :85, S2a :116).
 *
 * Это единственная проверка, отличающая «ground truth по состоянию» от
 * «накопительно обработано»: накопительный счётчик после чистки останется
 * прежним и разойдётся с фактом молча.
 *
 * L1 уменьшается настоящей TTL-чисткой (LocalMemoryCleaner → deleteL1Expired),
 * сцены — удалением блоков, как это делает soft-delete внутри extract().
 *
 * ФАЛЬСИФИКАЦИЯ:
 *   FALSIFY=monotonic — наблюдатель никогда не опускает значение (max со старым).
 */
import fs from "node:fs";
import path from "node:path";
import { setCommitObserver } from "../../src/core/record/commit-port.js";
import { createCounterObserver } from "../../src/gateway/consolidation/layer-counters.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { LocalMemoryCleaner } from "../../src/utils/memory-cleaner.js";
import type { IMemoryStore } from "../../src/core/store/types.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);

const sandbox = makeSandbox([]);
const cp = new ConsolidationCheckpoint(sandbox.dataDir);

/** Стор, из которого TTL реально удаляет строки. */
let l1Rows = 300;
const store = {
  countL0: () => 1000,
  countL1: () => l1Rows,
  deleteL0Expired: () => 0,
  deleteL1Expired: () => {
    const removed = 120;
    l1Rows -= removed;
    return removed;
  },
} as unknown as IMemoryStore;

function blocksDir(): string {
  return path.join(sandbox.dataDir, "scene_blocks", "_global");
}

function writeBlocks(n: number): void {
  fs.mkdirSync(blocksDir(), { recursive: true });
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(blocksDir(), `b${i}.md`), "# блок", "utf-8");
  }
}

function installObserver(): void {
  const real = createCounterObserver(sandbox.dataDir, {
    countL1: () => store.countL1() as number,
  });
  if (FALSIFY !== "monotonic") {
    setCommitObserver(real);
    return;
  }
  // Счётчик, который «умеет только расти» — ровно тот дефект, который ищем.
  setCommitObserver({
    onCommitted: async (m) => {
      const before = await cp.read();
      await real.onCommitted(m);
      await cp.update((d) => {
        d.l1Count = Math.max(d.l1Count ?? 0, before.l1Count ?? 0);
        d.sceneCount = Math.max(d.sceneCount ?? 0, before.sceneCount ?? 0);
      });
    },
  });
}

async function main(): Promise<void> {
  writeBlocks(5);
  installObserver();

  const cleaner = new LocalMemoryCleaner({
    baseDir: sandbox.dataDir,
    retentionDays: 3,
    cleanTime: "04:00",
    vectorStore: store,
  });

  // --- 1. Исходное состояние: счётчики проставлены -------------------------
  await cleaner.runOnce();
  await new Promise((r) => setTimeout(r, 100));
  const afterFirst = await cp.read();
  console.log(
    `  после первой чистки: l1Count=${afterFirst.l1Count} (факт ${store.countL1()}), ` +
      `sceneCount=${afterFirst.sceneCount} (факт 5)`,
  );
  must(
    "после чистки счётчик L1 равен факту",
    afterFirst.l1Count === (store.countL1() as number),
  );

  // --- 2. Вторая чистка: значение обязано УПАСТЬ ---------------------------
  const before = afterFirst.l1Count ?? 0;
  await cleaner.runOnce();
  await new Promise((r) => setTimeout(r, 100));
  const afterSecond = await cp.read();
  cleaner.destroy();
  console.log(
    `  после второй чистки: ${before} → ${afterSecond.l1Count} (факт ${store.countL1()})`,
  );
  must("TTL-чистка УМЕНЬШИЛА счётчик L1", (afterSecond.l1Count ?? 0) < before);
  must(
    "и уменьшенное значение по-прежнему равно факту",
    afterSecond.l1Count === (store.countL1() as number),
  );

  // --- 3. Сцены: удаление блоков тоже опускает счётчик ---------------------
  fs.unlinkSync(path.join(blocksDir(), "b0.md"));
  fs.unlinkSync(path.join(blocksDir(), "b1.md"));
  await createCounterObserverAndFire();
  const afterScenes = await cp.read();
  console.log(
    `  после удаления двух блоков: sceneCount=${afterScenes.sceneCount} (факт 3)`,
  );
  must("удаление блоков УМЕНЬШИЛО счётчик сцен", afterScenes.sceneCount === 3);

  finish();
}

/** Тот же путь, которым сцены сообщают о себе после extract(). */
async function createCounterObserverAndFire(): Promise<void> {
  const { notifyCommitted } =
    await import("../../src/core/record/commit-port.js");
  notifyCommitted({
    carrier: "scene",
    kind: "delete",
    affected: 2,
    source: "scene-extract",
    at: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 100));
}

try {
  await main();
} finally {
  setCommitObserver(undefined);
  sandbox.cleanup();
}
