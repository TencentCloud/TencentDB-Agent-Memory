/**
 * tz-05 e5 — dry-run миграции scope: отчёт есть, изменений нет.
 *
 * Запускается НАСТОЯЩИЙ скрипт `scripts/migrate-scope.ts` отдельным процессом,
 * тем же способом, каким его запустит человек. Проба смотрит на три вещи:
 * (1) dry-run печатает распределение и не трогает данные, (2) `--apply` без
 * `--default-scope` отказывается работать, (3) после применения повторный
 * прогон — no-op, а журнал отката содержит прежние значения и умеет их вернуть.
 *
 * Режим фальсификации: FALSIFY=dry-run-writes — dry-run запускается с флагом
 * `--apply`. Нога «данные не изменились» обязана покраснеть.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../src/core/store/sqlite.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e5-"));
const dbPath = path.join(dir, "vectors.db");
const store = new VectorStore(dbPath, 8);
await store.init();

const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
for (let i = 0; i < 6; i += 1) {
  await store.upsertL1(
    {
      id: `r${i}`,
      content: `migration corpus ${i}`,
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
      projectId: i < 3 ? "/repo/own" : "",
      scope: "project",
    } as MemoryRecord,
    VEC,
  );
}
store.close();

// Записи «без scope» бывают только как строки, написанные до появления
// колонки: писатель проставляет значение по умолчанию (sqlite.ts:1178).
{
  const raw = new DatabaseSync(dbPath);
  raw
    .prepare(
      "UPDATE l1_records SET scope = NULL WHERE record_id IN ('r3','r4','r5')",
    )
    .run();
  raw.close();
}

function scopes(): string {
  const raw = new DatabaseSync(dbPath);
  const rows = raw
    .prepare(
      "SELECT record_id, COALESCE(scope,'(null)') AS scope FROM l1_records ORDER BY record_id",
    )
    .all() as Array<Record<string, unknown>>;
  raw.close();
  return rows.map((r) => `${String(r.record_id)}=${String(r.scope)}`).join(" ");
}

function run(...args: string[]): string {
  return execFileSync(
    "npx",
    [
      "tsx",
      "scripts/migrate-scope.ts",
      "--db",
      dbPath,
      "--data-dir",
      dir,
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

const before = scopes();
// Фальсификация: «сухой» прогон запускается с --apply.
const dryOut = run(
  ...(FALSIFY === "dry-run-writes"
    ? ["--apply", "--default-scope", "global"]
    : []),
);
const afterDry = scopes();
console.log("  --- вывод dry-run ---");
for (const line of dryOut.trim().split("\n")) console.log(`  ${line}`);
console.log(`  scope до:    ${before}`);
console.log(`  scope после: ${afterDry}`);

must(
  "dry-run напечатал распределение",
  dryOut.includes("распределение записей"),
);
must("dry-run насчитал три записи без scope", dryOut.includes("без scope: 3"));
must("dry-run НИЧЕГО не изменил", afterDry === before);

// --apply без явного значения по умолчанию обязан отказаться: значение
// выбирается по отчёту, а не заранее.
let refused = false;
try {
  run("--apply");
} catch {
  refused = true;
}
must("--apply без --default-scope отказывается работать", refused);
must("и данные всё ещё не тронуты", scopes() === before);

const applyOut = run("--apply", "--default-scope", "global");
const afterApply = scopes();
console.log(`  scope после apply: ${afterApply}`);
must(
  "apply проставил scope трём записям",
  applyOut.includes("обновлено записей: 3"),
);
must(
  "и это именно те записи, у которых scope не было",
  afterApply === before.replace(/=\(null\)/g, "=global"),
);

const repeatOut = run("--apply", "--default-scope", "global");
must(
  "повторный прогон — no-op (идемпотентность)",
  repeatOut.includes("нечего мигрировать"),
);
must("и данные после повтора те же", scopes() === afterApply);

const journals = fs
  .readdirSync(path.join(dir, ".metadata", "scope-migration"))
  .filter((f) => f.endsWith(".jsonl"));
const journalPath = path.join(
  dir,
  ".metadata",
  "scope-migration",
  journals[0]!,
);
const journal = fs
  .readFileSync(journalPath, "utf-8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, unknown>);
console.log(`  журнал: ${journals.join(", ")}`);
console.log(`  первая строка журнала: ${JSON.stringify(journal[0])}`);
must(
  "журнал отката содержит строку на каждую тронутую запись",
  journal.length === 3,
);
must(
  "и в нём записано прежнее значение, а не новое",
  journal.every((j) => j.scope_before === null && j.scope_after === "global"),
);

// Путь БЕЗ --db: корень резолвится конфигом. Именно он падал с
// `require is not defined in ES module scope`, потому что ни одна нога пробы
// его не трогала — все ходили через --db.
function runResolved(
  env: Record<string, string>,
  ...args: string[]
): {
  out: string;
  code: number;
} {
  const res = spawnSync("npx", ["tsx", "scripts/migrate-scope.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return {
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    code: res.status ?? -1,
  };
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e5-home-"));
const resolvedDataDir = path.join(home, ".pi", "agent-memory", "tdai");
fs.mkdirSync(resolvedDataDir, { recursive: true });
fs.copyFileSync(dbPath, path.join(resolvedDataDir, "vectors.db"));
const resolved = runResolved({ HOME: home, TDAI_DATA_DIR: resolvedDataDir });
console.log("  --- прогон без --db (корень из конфига) ---");
for (const line of resolved.out.trim().split("\n")) console.log(`  ${line}`);
must(
  "прогон без --db не падает и печатает распределение",
  resolved.code === 0 && resolved.out.includes("распределение записей"),
);
must(
  "и он смотрит в корень, выданный конфигом, а не в чужой",
  resolved.out.includes(resolvedDataDir),
);

// Бэкенд tcvdb: миграция на месте невозможна, скрипт обязан отказаться и
// назвать процедуру, а не молча «мигрировать» пустую sqlite-базу рядом.
const tcvdbHome = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e5-tcvdb-"));
const tcvdbDataDir = path.join(tcvdbHome, ".pi", "agent-memory", "tdai");
fs.mkdirSync(tcvdbDataDir, { recursive: true });
fs.copyFileSync(dbPath, path.join(tcvdbDataDir, "vectors.db"));
fs.writeFileSync(
  path.join(tcvdbHome, "tdai-gateway.yaml"),
  [
    "data:",
    `  baseDir: ${tcvdbDataDir}`,
    "memory:",
    "  storeBackend: tcvdb",
    "",
  ].join("\n"),
  "utf-8",
);
const refusedTcvdb = runResolved(
  {
    HOME: tcvdbHome,
    TDAI_GATEWAY_CONFIG: path.join(tcvdbHome, "tdai-gateway.yaml"),
  },
  "--apply",
  "--default-scope",
  "global",
);
console.log("  --- прогон на конфиге с бэкендом tcvdb ---");
for (const line of refusedTcvdb.out.trim().split("\n"))
  console.log(`  ${line}`);
must(
  "на бэкенде tcvdb --apply отказывается и называет процедуру пересоздания",
  refusedTcvdb.code !== 0 &&
    refusedTcvdb.out.includes("миграция на месте невозможна"),
);

// scope=project без project_id — запись, невидимая НИ В ОДНОМ режиме
// (passesScope роняет её и в hidden, и в strict). Скрипт обязан отказаться,
// а не «мигрировать» память в небытие.
let refusedProject = false;
try {
  run("--apply", "--default-scope", "project");
} catch {
  refusedProject = true;
}
must(
  "--default-scope project без --project-id отказывается работать",
  refusedProject,
);

run("--rollback", journalPath);
console.log(`  scope после отката: ${scopes()}`);
must("откат по журналу вернул прежние значения", scopes() === before);

// Откат обязан быть НАСТОЯЩИМ откатом: журнал перестаёт держать свои
// record_id занятыми, иначе повторный --apply отвечает «нечего мигрировать»
// над записями, которые ровно сейчас нуждаются в миграции.
must(
  "журнал помечен откатанным, а не остался считаться выполненным",
  !fs.existsSync(journalPath) && fs.existsSync(`${journalPath}.rolledback`),
);
const afterRollbackApply = run("--apply", "--default-scope", "global");
console.log(`  scope после повторного apply: ${scopes()}`);
must(
  "после отката --apply снова мигрирует те же записи",
  afterRollbackApply.includes("обновлено записей: 3"),
);
must(
  "и данные снова приведены к выбранному значению",
  scopes() === before.replace(/=\(null\)/g, "=global"),
);

// Второй откат возвращает всё как было — сцена чистая для следующей ноги.
const journals2 = fs
  .readdirSync(path.join(dir, ".metadata", "scope-migration"))
  .filter((f) => f.endsWith(".jsonl"));
run(
  "--rollback",
  path.join(dir, ".metadata", "scope-migration", journals2[0]!),
);

// Теперь то же самое, но с project: атрибут scope без владельца бессмыслен,
// поэтому оба столбца обязаны ехать вместе.
const projectOut = run(
  "--apply",
  "--default-scope",
  "project",
  "--project-id",
  "/repo/own",
);
const projectRows = (() => {
  const raw = new DatabaseSync(dbPath);
  const rows = raw
    .prepare(
      "SELECT record_id, COALESCE(scope,'') AS scope, COALESCE(project_id,'') AS project_id FROM l1_records WHERE record_id IN ('r3','r4','r5') ORDER BY record_id",
    )
    .all() as Array<Record<string, unknown>>;
  raw.close();
  return rows;
})();
console.log(
  `  после apply --default-scope project: ${JSON.stringify(projectRows)}`,
);
must(
  "apply с project проставил и scope, и project_id",
  projectOut.includes("обновлено записей: 3") &&
    projectRows.every(
      (r) => r.scope === "project" && r.project_id === "/repo/own",
    ),
);

const journals3 = fs
  .readdirSync(path.join(dir, ".metadata", "scope-migration"))
  .filter((f) => f.endsWith(".jsonl"));
run(
  "--rollback",
  path.join(dir, ".metadata", "scope-migration", journals3[0]!),
);
const restored = (() => {
  const raw = new DatabaseSync(dbPath);
  const rows = raw
    .prepare(
      "SELECT record_id, COALESCE(project_id,'') AS project_id FROM l1_records WHERE record_id IN ('r3','r4','r5')",
    )
    .all() as Array<Record<string, unknown>>;
  raw.close();
  return rows;
})();
console.log(
  `  после второго отката: ${scopes()} | project_id ${JSON.stringify(restored)}`,
);
must(
  "откат вернул и scope, и project_id",
  scopes() === before && restored.every((r) => r.project_id === ""),
);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(tcvdbHome, { recursive: true, force: true });
finish();
