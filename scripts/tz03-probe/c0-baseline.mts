/**
 * tz-03a — СТОРОЖ ДВУХ ПОЧИНЕННЫХ ДЕФЕКТОВ (ТЗ S2 :114, S3 :124).
 *
 * Историческая роль: до правок пакета проба была контрольным замером и
 * утверждала, что дефекты ВОСПРОИЗВОДЯТСЯ. Дефекты починены в 03a, и
 * инвертированное утверждение стало ложным навсегда — проба не охраняла
 * ничего. Теперь она утверждает противоположное и краснеет при регрессии.
 *
 * Наблюдение 1 (S2): повторная финализация того же прогона НЕ задваивает
 * `l0Count` — счётчик пересчитывается из стора по курсору, а не `+= newL0`.
 *
 * Наблюдение 2 (S3): прогон с меньшим anchor'ом НЕ откатывает курсор — guard
 * сравнивает кандидата с ЖИВЫМ значением, а не со снимком старта.
 *
 * FALSIFY=old-advance — локально (без правки продукта) повторяет дофиксовую
 * финализацию: `+=` вместо пересчёта и сравнение со снимком старта. Обе ноги
 * обязаны стать ложными, exit 1.
 */
import fs from "node:fs";
import path from "node:path";
import {
  advanceCheckpoint,
  cursorGte,
} from "../../src/gateway/consolidation/checkpoint-advance.js";
import {
  EMPTY_L0_CURSOR,
  maxL0RecordedAt,
  type L0Cursor,
} from "../../src/gateway/consolidation/diff-builder.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { RunSummary } from "../../src/gateway/consolidation/types.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const T1 = "2026-08-01T00:00:00.000Z";
const T2 = "2026-08-02T00:00:00.000Z";

const sandbox = makeSandbox([]);

/** Минимальный L0-стор: две метки, на T2 — пара строк (как в живой базе). */
function seedStore(dataDir: string): void {
  const db = openWritableSqlite(path.join(dataDir, "vectors.db"));
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
}

function summaryOf(role: string): RunSummary {
  return {
    role,
    status: "ok",
    startedAt: T1,
    finishedAt: T2,
    recordsPresented: 3,
    overLimitBlocks: 0,
    applied: { merges: [], deletes: [], rewrites: [] },
  } as unknown as RunSummary;
}

function ctxOf(dataDir: string): OrchestratorContext {
  return {
    dataDir,
    checkpoint: new ConsolidationCheckpoint(dataDir),
    logger: { debug: () => {} },
  } as unknown as OrchestratorContext;
}

const FALSIFY = process.env.FALSIFY ?? "";

/**
 * Финализация прогона. Под `FALSIFY=old-advance` — локальная копия
 * дофиксового поведения: счётчик наращивается на `newL0`, а монотонность
 * курсора проверяется против СНИМКА старта, который у обоих прогонов пуст.
 */
async function finalize(
  ctx: OrchestratorContext,
  prevCursor: L0Cursor,
  newL0: number,
  role: string,
  anchor?: L0Cursor,
): Promise<void> {
  if (FALSIFY === "old-advance") {
    const cursor =
      anchor ?? maxL0RecordedAt(path.join(ctx.dataDir, "vectors.db"));
    await ctx.checkpoint.update((d) => {
      if (cursor.recordedAt && cursorGte(cursor, prevCursor)) {
        d.l0Cursor = cursor.recordedAt;
        d.l0CursorId = cursor.recordId;
      }
      d.l0Count += newL0;
    });
    return;
  }
  await advanceCheckpoint(ctx, prevCursor, newL0, summaryOf(role), anchor);
}

async function main(): Promise<void> {
  seedStore(sandbox.dataDir);
  const ctx = ctxOf(sandbox.dataDir);

  // --- Наблюдение 1: повтор того же прогона не задваивает счётчик ----------
  await finalize(ctx, EMPTY_L0_CURSOR, 3, "memory-keeper");
  const afterFirst = (await ctx.checkpoint.read()).l0Count;
  await finalize(ctx, EMPTY_L0_CURSOR, 3, "memory-keeper");
  const afterRetry = (await ctx.checkpoint.read()).l0Count;
  console.log(`  l0Count: первый прогон ${afterFirst}, повтор ${afterRetry}`);
  must(
    "S2 не воспроизводится: повтор того же прогона не задваивает l0Count",
    afterFirst === 3 && afterRetry === 3,
  );

  // --- Наблюдение 2: меньший anchor не откатывает курсор -------------------
  fs.rmSync(ctx.checkpoint.file, { force: true });
  const fresh = ctxOf(sandbox.dataDir);
  // day: anchor не передан → курсор = max(recorded_at) = T2
  await finalize(fresh, EMPTY_L0_CURSOR, 3, "memory-keeper");
  const dayCursor = (await fresh.checkpoint.read()).l0Cursor;
  // night: стартовал раньше, его снимок prevCursor = "", anchor = T1 < T2
  await finalize(fresh, EMPTY_L0_CURSOR, 1, "night-keeper", {
    recordedAt: T1,
    recordId: "r1",
  });
  const nightCursor = (await fresh.checkpoint.read()).l0Cursor;
  console.log(`  курсор: после day ${dayCursor}, после night ${nightCursor}`);
  must(
    "S3 не воспроизводится: прогон с меньшим anchor не откатил курсор назад",
    dayCursor === T2 && nightCursor === T2,
  );

  finish();
}

try {
  await main();
} finally {
  sandbox.cleanup();
}
