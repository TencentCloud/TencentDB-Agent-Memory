/**
 * tz-03a Ф6 — у `l0Count` есть НАЗВАННЫЙ потребитель (ТЗ A2e :78).
 *
 * До пакета дашборд не печатал ни курсор, ни счётчик (`grep -c
 * 'checkpoint\|Cursor' src/gateway/reports.ts` давал 0), то есть поле не читал
 * никто. Потребитель обязан быть не декоративным: при расхождении сохранённого
 * значения с живым фактом он показывает ОБЕ цифры, иначе дрейф снова не видно.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=stored-only — печатать только сохранённое значение.
 * Краснеет нога про расхождение.
 */
import fs from "node:fs";
import path from "node:path";
import { buildDashboardMarkdown } from "../../src/gateway/reports.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);

const T1 = "2026-08-01T00:00:00.000Z";
const T2 = "2026-08-02T00:00:00.000Z";

const sandbox = makeSandbox([]);
const dbPath = path.join(sandbox.dataDir, "vectors.db");

const db = openWritableSqlite(dbPath);
try {
  db.exec(
    "CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY, recorded_at TEXT)",
  );
  const ins = db.prepare(
    "INSERT INTO l0_conversations (record_id, recorded_at) VALUES (?, ?)",
  );
  ins.run("r1", T1);
  ins.run("r2", T2);
  ins.run("r3", T2);
} finally {
  db.close();
}

const cp = new ConsolidationCheckpoint(sandbox.dataDir);

/** Собрать дашборд и вернуть его текст (под фальсификацией — урезанный). */
function build(): string {
  const md = buildDashboardMarkdown({
    dataDir: sandbox.dataDir,
    logger: undefined,
  } as never);
  return FALSIFY === "stored-only"
    ? md
        .replace(/, the stored value drifted/g, "")
        .replace(/\*\*live count is \d+\*\*/g, "")
    : md;
}

// --- 1. Строки курсора и счётчика присутствуют ------------------------------
await cp.update((d) => {
  d.l0Cursor = T2;
  d.l0CursorId = "r2";
  d.l0Count = 2; // ровно факт: r1 и r2
});
const healthy = build();
const cursorLine = healthy.includes("l0Cursor: 2026-08-02T00:00:00.000Z / r2");
const countLine = healthy.includes("l0Count: 2");
console.log(`  строка курсора: ${cursorLine}, строка счётчика: ${countLine}`);
must(
  "дашборд печатает и курсор (с id), и счётчик",
  cursorLine && countLine && healthy.includes("## L0 cursor"),
);

// --- 2. При расхождении видны ОБЕ цифры ------------------------------------
await cp.update((d) => {
  d.l0Count = 99; // сохранённое значение разошлось с фактом
});
const drifted = build();
const line = drifted.split("\n").find((l) => l.includes("l0Count:")) ?? "";
console.log(`  строка при расхождении: ${line.trim()}`);
must(
  "при расхождении показаны обе цифры — сохранённая и живая",
  line.includes("99") && line.includes("live count is 2"),
);

// Записать файл целиком — потребитель должен быть виден и на диске.
const file = path.join(sandbox.dataDir, "memory_health.md");
fs.writeFileSync(file, drifted, "utf-8");
const grepCount = (
  fs.readFileSync(file, "utf-8").match(/l0Cursor|l0Count/g) ?? []
).length;
console.log(`  вхождений l0Cursor|l0Count в memory_health.md: ${grepCount}`);
must("в файле дашборда есть обе строки", grepCount >= 2);

sandbox.cleanup();
finish();
