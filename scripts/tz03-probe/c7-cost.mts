/**
 * tz-03a Ф7 — НФТ/R1: пересчёт не превращает финализацию в полный скан
 * (ТЗ НФТ :139, R1 :144).
 *
 * Замер идёт по ЖИВОМУ стору и строго на ЧТЕНИЕ (`openReadonlySqlite`): цифра
 * с игрушечной базы ничего не сказала бы о риске, ради которого требование
 * написано. Порог — 50 мс на финализацию при текущем объёме.
 *
 * Живая база берётся из конфига (tz-07), а не из захардкоженного пути.
 */
import path from "node:path";
import { loadGatewayConfig } from "../../src/gateway/config.js";
import {
  countL0UpTo,
  countNewL0Since,
  maxL0RecordedAt,
} from "../../src/gateway/consolidation/diff-builder.js";
import { openReadonlySqlite } from "../../src/gateway/http-utils.js";
import { must, finish } from "../tz07-probe/assert.mts";

const THRESHOLD_MS = 50;

const dbPath = path.join(loadGatewayConfig().data.baseDir, "vectors.db");
console.log(`  живая база: ${dbPath}`);

let rows = 0;
try {
  const db = openReadonlySqlite(dbPath);
  try {
    rows =
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM l0_conversations WHERE recorded_at != ''",
          )
          .get() as { c: number } | null
      )?.c ?? 0;
  } finally {
    db.close();
  }
} catch {
  rows = 0;
}
console.log(`  строк L0 с непустым recorded_at: ${rows}`);

const cursor = maxL0RecordedAt(dbPath);
console.log(`  курсор: ${cursor.recordedAt || "(пусто)"}/${cursor.recordId}`);

// Ровно то, что делает финализация: пересчёт по курсору + счёт «новых».
const started = performance.now();
const processed = countL0UpTo(dbPath, cursor);
const fresh = countNewL0Since(dbPath, cursor);
const elapsed = performance.now() - started;
console.log(
  `  обработано ${processed}, новых ${fresh}, время ${elapsed.toFixed(1)} мс`,
);

must(
  "замер сделан на непустой живой базе (иначе цифра ничего не значит)",
  rows > 1000 && processed !== null && fresh !== null,
);
must(
  `пересчёт укладывается в ${THRESHOLD_MS} мс на текущем объёме`,
  elapsed < THRESHOLD_MS,
);
must(
  "инвариант держится и на живом сторе: обработанные + новые = все непустые",
  (processed ?? -1) + (fresh ?? -1) === rows,
);

finish();
