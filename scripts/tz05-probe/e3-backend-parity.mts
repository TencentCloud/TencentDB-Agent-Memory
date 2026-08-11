/**
 * tz-05 e3 — паритет двух бэкендов на scope и provenance.
 *
 * Оба стора настоящие: `VectorStore` на node:sqlite и `TcvdbMemoryStore` через
 * HTTP-фейк API (`tcvdb-fake.ts`), то есть по проводу ходит тот же клиент, что
 * и в бою. Сравниваются не «оба вернули что-то», а конкретные множества
 * видимых записей и прочитанная обратно цепочка.
 *
 * Журнал отклонённых фильтров фейка проверяется отдельной ногой: стор
 * превращает любую ошибку в пустой массив, поэтому «фильтр не понят» и
 * «коллекция пуста» снаружи выглядят одинаково.
 *
 * Режим фальсификации: FALSIFY=break-second-backend — на TCVDB не пишется
 * scope. Красной обязана стать нога именно второго бэкенда, а sqlite остаётся
 * зелёным: иначе проба меряет что-то общее, а не паритет.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { TcvdbMemoryStore } from "../../src/core/store/tcvdb.js";
import { startTcvdbFake } from "../../src/core/store/tcvdb-fake.js";
import { PROVENANCE_KEY } from "../../src/core/record/provenance.js";
import { passesScope } from "../../src/core/hooks/auto-recall/scope.js";
import type { IMemoryStore } from "../../src/core/store/types.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const OWN = "/repo/own";
const OTHER = "/repo/other";
const CHAIN = {
  source: "user-input",
  createdAt: "2026-08-12T00:00:00.000Z",
  chain: [
    { role: "extractor", action: "store", at: "2026-08-12T00:00:00.000Z" },
  ],
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e3-"));
const fake = await startTcvdbFake();
const sqlite = new VectorStore(path.join(dir, "vectors.db"), 8);
await sqlite.init();
const tcvdb = new TcvdbMemoryStore({
  url: fake.url,
  username: "u",
  apiKey: "k",
  database: "probedb",
  embeddingModel: "m",
  timeout: 5000,
});
await tcvdb.init();

function record(
  id: string,
  scope: string,
  projectId: string,
  dropScope = false,
): MemoryRecord {
  return {
    id,
    content: "scoped parity sentinel",
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: { [PROVENANCE_KEY]: CHAIN },
    timestamps: ["2026-08-12T00:00:00.000Z"],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    sessionKey: "probe",
    sessionId: "probe",
    projectId,
    ...(dropScope ? {} : { scope }),
  } as MemoryRecord;
}

const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
const CLASSES: Array<[string, string, string]> = [
  ["own", "project", OWN],
  ["other", "project", OTHER],
  ["global", "global", OTHER],
];

for (const [id, scope, projectId] of CLASSES) {
  await sqlite.upsertL1(record(id, scope, projectId), VEC);
  // Фальсификация ломает ТОЛЬКО второй бэкенд: scope до TCVDB не доезжает.
  await tcvdb.upsertL1(
    record(id, scope, projectId, FALSIFY === "break-second-backend"),
  );
}

async function visible(
  store: IMemoryStore,
  mode: "hidden" | "strict",
): Promise<string[]> {
  // Продуктовый путь recall — фильтр стора И JS-предикат (search.ts). В
  // hidden TCVDB намеренно не шлёт фильтр: предикат по scope выкинул бы все
  // документы, написанные до этого пакета (замер: 0 попаданий вместо 1).
  const hits = await store.searchL1Fts("sentinel", 20, OWN, mode);
  return hits
    .filter((h) => passesScope(h, OWN, mode))
    .map((h) => h.record_id)
    .sort();
}

const sqliteHidden = await visible(sqlite, "hidden");
const tcvdbHidden = await visible(tcvdb, "hidden");
console.log(`  sqlite hidden: ${sqliteHidden.join(", ") || "(пусто)"}`);
console.log(`  tcvdb  hidden: ${tcvdbHidden.join(", ") || "(пусто)"}`);

must(
  "sqlite показывает свой проект и global, чужой скрывает",
  sqliteHidden.join(",") === "global,own",
);
must(
  "TCVDB отвечает тем же множеством — паритет, а не «оба что-то вернули»",
  tcvdbHidden.join(",") === "global,own",
);
must(
  "фейк не отклонил ни одного фильтра — пустой ответ был бы неотличим от поломки",
  fake.rejectedFilters.length === 0,
);

const tcvdbOwn = (await tcvdb.searchL1Fts("sentinel", 20, OWN, "hidden")).find(
  (h) => h.record_id === "own",
);
const sqliteOwn = (
  await sqlite.searchL1Fts("sentinel", 20, OWN, "hidden")
).find((h) => h.record_id === "own");
console.log(`  цепочка из TCVDB: ${tcvdbOwn?.metadata_json ?? "(нет)"}`);
must(
  "provenance читается обратно с обоих бэкендов и совпадает",
  JSON.stringify(
    JSON.parse(tcvdbOwn?.metadata_json ?? "{}")[PROVENANCE_KEY],
  ) ===
    JSON.stringify(
      JSON.parse(sqliteOwn?.metadata_json ?? "{}")[PROVENANCE_KEY],
    ),
);

sqlite.close();
tcvdb.close();
await fake.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
