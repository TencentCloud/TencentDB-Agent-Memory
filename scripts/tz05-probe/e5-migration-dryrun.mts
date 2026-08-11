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
import { execFileSync } from "node:child_process";
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

run("--rollback", journalPath);
console.log(`  scope после отката: ${scopes()}`);
must("откат по журналу вернул прежние значения", scopes() === before);

fs.rmSync(dir, { recursive: true, force: true });
finish();
