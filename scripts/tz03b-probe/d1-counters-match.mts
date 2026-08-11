/**
 * tz-03b Ф6/S1 — счётчик слоя равен ФАКТУ по носителю после каждого пути
 * мутации (ТЗ критерий 1 :84, проверка S1 :105).
 *
 * Сверяется сохранённое значение с прямым пересчётом носителя, а не с другой
 * производной того же числа: правка мимо точки коммита обязана дать
 * расхождение, иначе сверка ничего не проверяет.
 *
 * ФАЛЬСИФИКАЦИИ (ломают НАСТОЯЩИЙ механизм через setCommitObserver,
 * а не переписывают дефект внутри пробы):
 *   FALSIFY=increment   — наблюдатель накапливает вместо пересчёта.
 *   FALSIFY=skip-notify — наблюдателя нет вообще (порт молчит).
 */
import fs from "node:fs";
import path from "node:path";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import {
  setCommitObserver,
  notifyCommitted,
} from "../../src/core/record/commit-port.js";
import {
  createCounterObserver,
  countScenes,
} from "../../src/gateway/consolidation/layer-counters.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { bumpFeedbackPriorities } from "../../src/gateway/feedback.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);

const sandbox = makeSandbox([]);
const dbPath = path.join(sandbox.dataDir, "vectors.db");
const cp = new ConsolidationCheckpoint(sandbox.dataDir);

/** Настоящий стор пробе не нужен — нужен носитель и честный счёт по нему. */
const store = {
  countL1(): number {
    const db = openWritableSqlite(dbPath);
    try {
      return (
        (db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as {
          c: number;
        }) ?? { c: 0 }
      ).c;
    } finally {
      db.close();
    }
  },
};

function seed(): void {
  const db = openWritableSqlite(dbPath);
  try {
    db.exec(
      "CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT, priority INTEGER)",
    );
    const ins = db.prepare(
      "INSERT INTO l1_records (record_id, content, priority) VALUES (?, ?, 10)",
    );
    ins.run("a", "первая запись");
    ins.run("b", "вторая запись");
  } finally {
    db.close();
  }
}

/** Прямая правка носителя МИМО точки коммита — этого счётчик знать не должен. */
function deleteBehindTheBack(id: string): void {
  const db = openWritableSqlite(dbPath);
  try {
    db.prepare("DELETE FROM l1_records WHERE record_id = ?").run(id);
  } finally {
    db.close();
  }
}

function writeBlock(rel: string): void {
  const p = path.join(sandbox.dataDir, "scene_blocks", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "# блок", "utf-8");
}

function installObserver(): void {
  if (FALSIFY === "skip-notify") return; // порт молчит
  if (FALSIFY === "increment") {
    // Старое поведение: += вместо пересчёта.
    let accumulated = 0;
    setCommitObserver({
      onCommitted: async (m) => {
        accumulated += m.affected;
        await cp.update((d) => {
          d.l1Count = accumulated;
        });
      },
    });
    return;
  }
  setCommitObserver(createCounterObserver(sandbox.dataDir, store));
}

async function main(): Promise<void> {
  seed();
  writeBlock("_global/one.md");
  installObserver();

  // --- 1. Прямой SQL-путь: feedback ---------------------------------------
  bumpFeedbackPriorities(dbPath, ["первая"]);
  await new Promise((r) => setTimeout(r, 50));
  let stored = await cp.read();
  console.log(
    `  после feedback: l1Count=${stored.l1Count} факт=${store.countL1()}, ` +
      `sceneCount=${stored.sceneCount} факт=${await countScenes(sandbox.dataDir)}`,
  );
  must(
    "после прямого SQL-пути счётчик L1 равен факту по носителю",
    stored.l1Count === store.countL1(),
  );
  must(
    "счётчик сцен равен факту, хотя двигался другой носитель",
    stored.sceneCount === (await countScenes(sandbox.dataDir)),
  );

  // --- 2. Путь удаления (как у TTL-чистки) --------------------------------
  deleteBehindTheBack("b");
  notifyCommitted({
    carrier: "l1",
    kind: "delete",
    affected: 1,
    source: "cleaner",
    at: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 50));
  stored = await cp.read();
  console.log(
    `  после удаления: l1Count=${stored.l1Count} факт=${store.countL1()}`,
  );
  must(
    "после удаления счётчик равен факту, а не факту плюс дельте",
    stored.l1Count === store.countL1(),
  );

  // --- 3. Правка МИМО точки коммита обязана дать расхождение --------------
  deleteBehindTheBack("a");
  const factAfterSilent = store.countL1();
  const storedAfterSilent = (await cp.read()).l1Count;
  console.log(
    `  правка мимо порта: сохранено=${storedAfterSilent}, факт=${factAfterSilent}`,
  );
  must(
    "правка мимо точки коммита ВИДНА как расхождение (иначе сверка декоративна)",
    storedAfterSilent !== factAfterSilent,
  );

  // --- 4. Повтор того же события ничего не задваивает ---------------------
  const event = {
    carrier: "l1" as const,
    kind: "update" as const,
    affected: 1,
    source: "apply",
    at: new Date().toISOString(),
  };
  notifyCommitted(event);
  await new Promise((r) => setTimeout(r, 50));
  const first = (await cp.read()).l1Count;
  notifyCommitted(event);
  await new Promise((r) => setTimeout(r, 50));
  const second = (await cp.read()).l1Count;
  console.log(
    `  повтор события: ${first} → ${second}, факт=${store.countL1()}`,
  );
  must(
    "повтор того же события не меняет счётчик и оставляет его равным факту",
    first === second && second === store.countL1(),
  );

  finish();
}

try {
  await main();
} finally {
  setCommitObserver(undefined);
  sandbox.cleanup();
}
