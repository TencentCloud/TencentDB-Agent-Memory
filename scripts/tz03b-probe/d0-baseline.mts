/**
 * tz-03b — ИНВЕРТИРОВАННАЯ проба: контрольный замер «как было до пакета».
 *
 * Она утверждает ДОРЕФОРМЕННОЕ поведение: после мутации носителя в чекпойнте
 * нет ни `l1Count`, ни `sceneCount`, потому что считать их некому. Пока пакет
 * не сделан, она зелёная; после Ф2-Ф3 она ОБЯЗАНА быть красной.
 *
 * Зелёная d0 после внедрения означает, что порт никуда не подключён, как бы
 * убедительно ни выглядели остальные пробы.
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

// Наблюдатель подключён ровно так, как это делает боевой gateway.
setCommitObserver(
  createCounterObserver(sandbox.dataDir, {
    countL1: () => 1,
  }),
);

bumpFeedbackPriorities(dbPath, ["запись"]);
await new Promise((r) => setTimeout(r, 100));

const cp = await new ConsolidationCheckpoint(sandbox.dataDir).read();
console.log(
  `  после мутации: l1Count=${String(cp.l1Count)}, sceneCount=${String(cp.sceneCount)}`,
);
must(
  "ДО пакета мутация не оставляла счётчиков в чекпойнте (эта нога обязана стать ложной)",
  cp.l1Count === undefined && cp.sceneCount === undefined,
);

setCommitObserver(undefined);
sandbox.cleanup();
finish();
