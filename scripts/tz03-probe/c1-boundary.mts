/**
 * tz-03a Ф1 — граница курсора определена однозначно (ТЗ A2d :77, критерий 3b).
 *
 * На живой базе 7420 меток времени несут РОВНО ДВЕ строки: 83% строк делят
 * метку с соседом. Поэтому обе односложные границы неверны — `>=` считает
 * пограничную строку в каждом прогоне, голое `>` теряет партнёра из пары,
 * которую разрезал diffCap. Курсор становится парой (recorded_at, record_id).
 *
 * ФАЛЬСИФИКАЦИИ:
 *   FALSIFY=ge               — вернуть включающую границу (id отброшен).
 *   FALSIFY=gt               — голое `>` по метке, без второй координаты.
 *   FALSIFY=empty-fallback-id — ночной anchor-fallback теряет id чекпойнта.
 */
import path from "node:path";
import {
  countNewL0Since,
  cursorOfCheckpoint,
  maxL0RecordedAt,
  type L0Cursor,
} from "../../src/gateway/consolidation/diff-builder.js";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);

const T1 = "2026-08-01T00:00:00.000Z";
const T2 = "2026-08-02T00:00:00.000Z";

const sandbox = makeSandbox([]);
const dbPath = path.join(sandbox.dataDir, "vectors.db");

/** r1@T1, затем ПАРА r2/r3 на одной метке T2 — как в живой базе. */
function seedStore(): void {
  const db = openWritableSqlite(dbPath);
  try {
    db.exec(
      "CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY, recorded_at TEXT)",
    );
    db.exec("CREATE INDEX idx_l0_recorded ON l0_conversations(recorded_at)");
    const ins = db.prepare(
      "INSERT INTO l0_conversations (record_id, recorded_at) VALUES (?, ?)",
    );
    ins.run("r1", T1);
    ins.run("r2", T2);
    ins.run("r3", T2);
  } finally {
    db.close();
  }
}

/** Счёт «новых» — под фальсификацией предикат подменяется на односложный. */
function countNew(cursor: L0Cursor): number {
  if (FALSIFY === "ge") {
    return countNewL0Since(dbPath, { ...cursor, recordId: "" }) ?? -1;
  }
  if (FALSIFY === "gt") {
    const db = openWritableSqlite(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS c FROM l0_conversations WHERE recorded_at != '' AND recorded_at > ?",
        )
        .get(cursor.recordedAt) as { c: number } | null;
      return row?.c ?? -1;
    } finally {
      db.close();
    }
  }
  return countNewL0Since(dbPath, cursor) ?? -1;
}

/** Личности «новых» строк тем же предикатом, что и счёт (для ноги 2). */
function idsNewerThan(cursor: L0Cursor): string[] {
  const where =
    FALSIFY === "gt"
      ? "recorded_at > :at"
      : FALSIFY === "ge" || cursor.recordId === ""
        ? "recorded_at >= :at"
        : "(recorded_at > :at OR (recorded_at = :at AND record_id > :id))";
  const db = openWritableSqlite(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT record_id FROM l0_conversations WHERE recorded_at != '' AND ${where.replace(
          /:at/g,
          "?",
        )}`.replace(":id", "?"),
      )
      .all(
        ...(FALSIFY === "gt" || FALSIFY === "ge" || cursor.recordId === ""
          ? [cursor.recordedAt]
          : [cursor.recordedAt, cursor.recordedAt, cursor.recordId]),
      ) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id).sort();
  } finally {
    db.close();
  }
}

/** Ночной anchor-fallback: skip-merge в первом чанке → двигать нечего. */
function anchorFallback(cp: {
  l0Cursor: string;
  l0CursorId: string;
}): L0Cursor {
  return FALSIFY === "empty-fallback-id"
    ? { recordedAt: cp.l0Cursor, recordId: "" }
    : cursorOfCheckpoint(cp);
}

seedStore();

// --- 1. Пограничная строка не считается дважды ------------------------------
// Курсор стоит на r2: обработаны r1 и r2, новой остаётся только r3.
const atR2: L0Cursor = { recordedAt: T2, recordId: "r2" };
console.log(`  новых после пары (${T2}, r2): ${countNew(atR2)}`);
must("пограничная строка не попадает в новые повторно", countNew(atR2) === 1);

// --- 2. Партнёр из разрезанной пары не теряется -----------------------------
// diffCap разрезал пару: r2 обработан, r3 — нет. Голое `>` потеряло бы r3
// НАВСЕГДА, поэтому проверяется не число, а личность оставшейся строки.
const newIds = idsNewerThan(atR2);
console.log(`  новые строки после (T2, r2): [${newIds.join(", ")}]`);
must(
  "партнёр разрезанной пары (r3) остался новым, а не пропал",
  newIds.length === 1 && newIds[0] === "r3",
);

// --- 3. Старый чекпойнт без id ведёт себя как прежде ------------------------
const legacy = cursorOfCheckpoint({ l0Cursor: T2, l0CursorId: "" });
console.log(`  новых у legacy-курсора (id пустой): ${countNew(legacy)}`);
must(
  "чекпойнт без l0CursorId даёт прежнюю включающую границу",
  countNew(legacy) === 2,
);

// --- 4. Ночной anchor-fallback сохраняет пару -------------------------------
// Прогон, которому нечего двигать, обязан вернуть ТОТ ЖЕ курсор целиком.
const cp = { l0Cursor: T2, l0CursorId: "r2" };
const fallback = anchorFallback(cp);
console.log(
  `  anchor-fallback: ${fallback.recordedAt}/${fallback.recordId || "(пусто)"}`,
);
must(
  "anchor-fallback не теряет вторую координату курсора",
  fallback.recordedAt === T2 && fallback.recordId === "r2",
);
must(
  "и потому не откатывает прогон на уже обработанную строку",
  countNew(fallback) === countNew(atR2),
);

// --- 5. Максимум читается парой, ничья разрешена детерминированно -----------
const max = maxL0RecordedAt(dbPath);
console.log(`  max: ${max.recordedAt}/${max.recordId}`);
must(
  "maxL0RecordedAt отдаёт пару, ничья на метке разрешена record_id DESC",
  max.recordedAt === T2 && max.recordId === "r3",
);

sandbox.cleanup();
finish();
