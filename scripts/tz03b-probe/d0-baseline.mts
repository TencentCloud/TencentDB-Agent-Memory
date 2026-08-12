/**
 * tz-03b — СТОРОЖ ПОДКЛЮЧЁННОГО ПОРТА СЧЁТЧИКОВ.
 *
 * Историческая роль: до пакета проба была контрольным замером и утверждала
 * ДОРЕФОРМЕННОЕ поведение — после мутации носителя в чекпойнте нет ни
 * `l1Count`, ни `sceneCount`, потому что считать их некому. Порт подключён,
 * инвертированное утверждение стало ложным навсегда, и проба перестала
 * охранять что-либо. Теперь она утверждает обратное: мутация носителя
 * оставляет в чекпойнте оба счётчика, пересчитанных из стора и с диска.
 *
 * FALSIFY=no-counters — локально повторяет дофиксовое состояние: наблюдатель
 * коммитов не подключается вовсе. Нога обязана стать ложной, exit 1.
 */
import path from "node:path";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import { setCommitObserver } from "../../src/core/record/commit-port.js";
import { createCounterObserver } from "../../src/gateway/consolidation/layer-counters.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { bumpFeedbackPriorities } from "../../src/gateway/feedback.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const sandbox = makeSandbox([]);
const dbPath = path.join(sandbox.dataDir, "vectors.db");

const db = openWritableSqlite(dbPath);
try {
  db.exec(
    "CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT, priority INTEGER)",
  );
  db.prepare(
    "INSERT INTO l1_records (record_id, content, priority) VALUES ('a', 'запись', 10)",
  ).run();
} finally {
  db.close();
}

const FALSIFY = process.env.FALSIFY ?? "";

// Наблюдатель подключён ровно так, как это делает боевой gateway. Под
// FALSIFY=no-counters он не подключается — это и есть дофиксовое состояние.
if (FALSIFY !== "no-counters") {
  setCommitObserver(
    createCounterObserver(sandbox.dataDir, {
      countL1: () => 1,
    }),
  );
}

bumpFeedbackPriorities(dbPath, ["запись"]);
await new Promise((r) => setTimeout(r, 100));

const cp = await new ConsolidationCheckpoint(sandbox.dataDir).read();
console.log(
  `  после мутации: l1Count=${String(cp.l1Count)}, sceneCount=${String(cp.sceneCount)}`,
);
must(
  "мутация носителя оставляет счётчики в чекпойнте",
  cp.l1Count === 1 && cp.sceneCount === 0,
);

setCommitObserver(undefined);
sandbox.cleanup();
finish();
