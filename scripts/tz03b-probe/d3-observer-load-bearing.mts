/**
 * tz-03b Ф6/S5 — точка коммита НЕСУЩАЯ, а не декоративная (ТЗ S5 :131).
 *
 * Наблюдателя снимают и делают обычный прогон с мутациями: счётчики обязаны
 * ПЕРЕСТАТЬ сходиться с фактом. Если после отключения всё по-прежнему
 * сходится, значит данные текут не через порт, и пакет не сделан, как бы ни
 * выглядел код. Затем наблюдателя возвращают — сходимость обязана
 * восстановиться сама, без ручного пересчёта.
 *
 * ФАЛЬСИФИКАЦИЯ:
 *   FALSIFY=always-recompute — счётчик пересчитывается мимо порта (как если бы
 *   его считал кто-то ещё параллельно); тогда отключение порта ничего не
 *   ломает, и проба обязана это заметить.
 */
import path from "node:path";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import { setCommitObserver } from "../../src/core/record/commit-port.js";
import {
  createCounterObserver,
  recomputeCounters,
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

const store = {
  countL1(): number {
    const db = openWritableSqlite(dbPath);
    try {
      return (
        db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as {
          c: number;
        }
      ).c;
    } finally {
      db.close();
    }
  },
};

function seed(n: number): void {
  const db = openWritableSqlite(dbPath);
  try {
    db.exec(
      "CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT, priority INTEGER)",
    );
    const ins = db.prepare(
      "INSERT INTO l1_records (record_id, content, priority) VALUES (?, ?, 10)",
    );
    for (let i = 0; i < n; i++) ins.run(`r${i}`, `запись ${i}`);
  } finally {
    db.close();
  }
}

function addRow(id: string): void {
  const db = openWritableSqlite(dbPath);
  try {
    db.prepare(
      "INSERT INTO l1_records (record_id, content, priority) VALUES (?, 'запись', 10)",
    ).run(id);
  } finally {
    db.close();
  }
}

/** Обычный прогон с мутацией: строка добавлена и путь мутации отработал. */
async function ordinaryRun(id: string): Promise<void> {
  addRow(id);
  bumpFeedbackPriorities(dbPath, ["запись"]);
  if (FALSIFY === "always-recompute") {
    // Настоящий путь обновления — другой: счётчик считают мимо порта.
    await recomputeCounters(sandbox.dataDir, store);
  }
  await new Promise((r) => setTimeout(r, 50));
}

async function main(): Promise<void> {
  seed(3);

  // --- 1. С наблюдателем: сходится ----------------------------------------
  setCommitObserver(createCounterObserver(sandbox.dataDir, store));
  await ordinaryRun("new-1");
  const withObserver = await cp.read();
  console.log(
    `  наблюдатель на месте: l1Count=${withObserver.l1Count}, факт=${store.countL1()}`,
  );
  must(
    "с наблюдателем счётчик сходится с фактом",
    withObserver.l1Count === store.countL1(),
  );

  // --- 2. Наблюдателя сняли: обязано РАЗОЙТИСЬ ------------------------------
  setCommitObserver(undefined);
  await ordinaryRun("new-2");
  const withoutObserver = await cp.read();
  console.log(
    `  наблюдателя сняли: l1Count=${withoutObserver.l1Count}, факт=${store.countL1()}`,
  );
  must(
    "без наблюдателя счётчики ПЕРЕСТАЛИ сходиться — значит данные текут через порт",
    withoutObserver.l1Count !== store.countL1(),
  );

  // --- 3. Наблюдателя вернули: чинится САМО --------------------------------
  setCommitObserver(createCounterObserver(sandbox.dataDir, store));
  await ordinaryRun("new-3");
  const restored = await cp.read();
  console.log(
    `  наблюдателя вернули: l1Count=${restored.l1Count}, факт=${store.countL1()}`,
  );
  must(
    "возврат наблюдателя восстановил сходимость без ручного пересчёта",
    restored.l1Count === store.countL1(),
  );

  finish();
}

try {
  await main();
} finally {
  setCommitObserver(undefined);
  sandbox.cleanup();
}
