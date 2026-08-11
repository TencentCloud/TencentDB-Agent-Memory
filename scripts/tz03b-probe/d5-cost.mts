/**
 * tz-03b Ф6 — НФТ/R1: пересчёт счётчиков не превращает точку коммита в
 * дорогую операцию (ТЗ НФТ :139, R1 :144).
 *
 * Замер идёт по ЖИВОМУ дереву юзера и СТРОГО на чтение (`openReadonlySqlite`,
 * `fs.readdir`): цифра с игрушечной базы ничего не сказала бы о риске, ради
 * которого требование написано. Живой стор здесь не инстанцируется — это
 * запись; выполняется ровно тот запрос, который делает бэкенд
 * (`sqlite.ts:1498`, `SELECT COUNT(*) FROM l1_records`).
 *
 * Порог — 50 мс на один пересчёт обоих носителей.
 */
import path from "node:path";
import { loadGatewayConfig } from "../../src/gateway/config.js";
import { openReadonlySqlite } from "../../src/gateway/http-utils.js";
import { countScenes } from "../../src/gateway/consolidation/layer-counters.js";
import { must, finish } from "../tz07-probe/assert.mts";

const THRESHOLD_MS = 50;

const dataDir = loadGatewayConfig().data.baseDir;
const dbPath = path.join(dataDir, "vectors.db");
console.log(`  живое дерево: ${dataDir}`);

/** Тот же счёт, что делает sqlite-бэкенд, но на readonly-соединении. */
function liveCountL1(): number {
  const db = openReadonlySqlite(dbPath);
  try {
    return (
      db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as { c: number }
    ).c;
  } finally {
    db.close();
  }
}

const started = performance.now();
const l1 = liveCountL1();
const scenes = await countScenes(dataDir);
const elapsed = performance.now() - started;

console.log(
  `  l1_records=${l1}, блоков сцен=${scenes}, время пересчёта ${elapsed.toFixed(1)} мс`,
);

must(
  "замер сделан на непустом живом дереве (иначе цифра ничего не значит)",
  l1 > 100,
);
must(
  `пересчёт обоих носителей укладывается в ${THRESHOLD_MS} мс на текущем объёме`,
  elapsed < THRESHOLD_MS,
);
must("счёт сцен на живом дереве не нулевой", scenes > 0);

finish();
