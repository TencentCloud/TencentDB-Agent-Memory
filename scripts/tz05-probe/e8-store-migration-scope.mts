/**
 * tz-05 e8 — переезд sqlite → TCVDB не теряет scope.
 *
 * Это не абстрактный путь: `scripts/migrate-scope.ts` отказывается мигрировать
 * scope на месте, когда бэкенд — tcvdb, и прописывает единственный маршрут до
 * strict — «выгрузить, пересоздать коллекцию, залить заново». Заливает заново
 * ровно этот скрипт, пакетной записью. Если по дороге scope теряется, режим
 * strict после миграции не увидит НИ ОДНОЙ записи.
 *
 * Прогон настоящий: `runMigrationCli` с тем же argv, каким его зовёт человек,
 * источник — настоящий VectorStore, приёмник — TcvdbMemoryStore поверх фейка,
 * который говорит по протоколу TCVDB (включая грамматику filter).
 *
 * Режим фальсификации: FALSIFY=batch-drops-scope — приёмник оборачивается так,
 * что пакетная запись выкидывает scope/project_id из документа, ровно как это
 * делала своя копия литерала в upsertL1Batch. Ноги про strict обязаны
 * покраснеть.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { TcvdbMemoryStore } from "../../src/core/store/tcvdb.js";
import { startTcvdbFake } from "../../src/core/store/tcvdb-fake.js";
import { runMigrationCli } from "../migrate-sqlite-to-tcvdb/sqlite-to-tcvdb.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const OWN = "/repo/own";
const OTHER = "/repo/other";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e8-"));
const dbPath = path.join(dir, "vectors.db");
const source = new VectorStore(dbPath, 8);
await source.init();

const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
async function seed(id: string, scope: string, projectId: string) {
  await source.upsertL1(
    {
      id,
      content: `migration sentinel ${id}`,
      type: "episodic",
      priority: 50,
      scene_name: "s",
      source_message_ids: [],
      metadata: {},
      timestamps: ["2026-08-12T00:00:00.000Z"],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      sessionKey: "probe",
      sessionId: "probe",
      projectId,
      scope,
    } as MemoryRecord,
    VEC,
  );
}
await seed("own", "project", OWN);
await seed("other", "project", OTHER);
await seed("global", "global", "");
source.close();

const fake = await startTcvdbFake();
let target: TcvdbMemoryStore | undefined;

const configPath = path.join(dir, "openclaw.json");
fs.writeFileSync(configPath, "{}", "utf-8");

await runMigrationCli(
  [
    "--plugin-data-dir",
    dir,
    "--sqlite-path",
    dbPath,
    "--openclaw-config-path",
    configPath,
    "--tcvdb-url",
    fake.url,
    "--tcvdb-username",
    "u",
    "--tcvdb-api-key",
    "k",
    "--tcvdb-database",
    "probedb",
    "--tcvdb-embedding-model",
    "m",
    "--no-apply-config",
    "--no-rewrite-manifest",
    "--no-bm25-enabled",
    "--yes",
  ],
  {
    createTargetStore: (options) => {
      target = new TcvdbMemoryStore({
        url: options.tcvdb.url,
        username: options.tcvdb.username,
        apiKey: options.tcvdb.apiKey,
        database: options.tcvdb.database,
        embeddingModel: options.tcvdb.embeddingModel,
        timeout: options.tcvdb.timeout,
      });
      if (FALSIFY !== "batch-drops-scope") return target;
      // Фальсификация: пакетная запись теряет атрибуты по дороге.
      const store = target;
      const original = store.upsertL1Batch.bind(store);
      store.upsertL1Batch = async (records: MemoryRecord[]) =>
        original(
          records.map((r) => {
            const copy = { ...r } as MemoryRecord;
            delete (copy as { scope?: string }).scope;
            delete (copy as { projectId?: string }).projectId;
            return copy;
          }),
        );
      return store;
    },
    verifyDelayMs: 0,
  },
);

const store = target!;
const strict = await store.searchL1Fts("sentinel", 20, OWN, "strict");
const ids = strict.map((h) => h.record_id).sort();
console.log(`  strict после миграции: ${JSON.stringify(ids)}`);
console.log(
  `  отвергнутых фильтров у фейка: ${JSON.stringify(fake.rejectedFilters)}`,
);

must(
  "фейк принял выражение фильтра — значит проверка не вырождена",
  fake.rejectedFilters.length === 0,
);
must(
  "после переезда strict видит свой проект и global",
  JSON.stringify(ids) === JSON.stringify(["global", "own"]),
);

const own = (await store.searchL1Fts("sentinel", 20, OWN, "decay")).find(
  (h) => h.record_id === "own",
);
console.log(`  запись own: scope=${own?.scope} project_id=${own?.project_id}`);
must(
  "и атрибуты доехали ровно те, что были в sqlite",
  own?.scope === "project" && own?.project_id === OWN,
);

store.close();
await fake.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
