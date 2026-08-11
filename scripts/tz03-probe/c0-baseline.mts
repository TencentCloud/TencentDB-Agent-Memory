/**
 * tz-03a Ф0 — КОНТРОЛЬНЫЙ ЗАМЕР ДО ПРАВОК (ТЗ S2 :114, S3 :124).
 *
 * Эта проба устроена НАОБОРОТ остальных: её наблюдения — «дефект
 * воспроизводится». Сегодня она обязана быть ЗЕЛЁНОЙ, а после Ф2 и Ф3 —
 * КРАСНОЙ. Зелёная c0 после починки означает, что дефект жив.
 *
 * Замер 1 (S2): повторная финализация того же прогона задваивает `l0Count`,
 * потому что `advanceCheckpoint` делает `d.l0Count += newL0` без отметки
 * «этот runId уже финализирован».
 *
 * Замер 2 (S3): guard сравнивает курсор со СНИМКОМ старта (`prevCursor`), а не
 * с живым значением, поэтому прогон с меньшим anchor'ом откатывает курсор
 * назад.
 */
import fs from "node:fs";
import path from "node:path";
import { advanceCheckpoint } from "../../src/gateway/consolidation/checkpoint-advance.js";
import { EMPTY_L0_CURSOR } from "../../src/gateway/consolidation/diff-builder.js";
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

async function main(): Promise<void> {
  seedStore(sandbox.dataDir);
  const ctx = ctxOf(sandbox.dataDir);

  // --- Замер 1: повтор того же прогона задваивает счётчик ------------------
  await advanceCheckpoint(ctx, EMPTY_L0_CURSOR, 3, summaryOf("memory-keeper"));
  const afterFirst = (await ctx.checkpoint.read()).l0Count;
  await advanceCheckpoint(ctx, EMPTY_L0_CURSOR, 3, summaryOf("memory-keeper"));
  const afterRetry = (await ctx.checkpoint.read()).l0Count;
  console.log(`  l0Count: первый прогон ${afterFirst}, повтор ${afterRetry}`);
  must(
    "ДЕФЕКТ S2 воспроизведён: повтор того же прогона задваивает l0Count",
    afterFirst === 3 && afterRetry === 6,
  );

  // --- Замер 2: меньший anchor откатывает курсор назад ---------------------
  fs.rmSync(ctx.checkpoint.file, { force: true });
  const fresh = ctxOf(sandbox.dataDir);
  // day: anchor не передан → курсор = max(recorded_at) = T2
  await advanceCheckpoint(
    fresh,
    EMPTY_L0_CURSOR,
    3,
    summaryOf("memory-keeper"),
  );
  const dayCursor = (await fresh.checkpoint.read()).l0Cursor;
  // night: стартовал раньше, его снимок prevCursor = "", anchor = T1 < T2
  await advanceCheckpoint(
    fresh,
    EMPTY_L0_CURSOR,
    1,
    summaryOf("night-keeper"),
    {
      recordedAt: T1,
      recordId: "r1",
    },
  );
  const nightCursor = (await fresh.checkpoint.read()).l0Cursor;
  console.log(`  курсор: после day ${dayCursor}, после night ${nightCursor}`);
  must(
    "ДЕФЕКТ S3 воспроизведён: прогон с меньшим anchor откатил курсор назад",
    dayCursor === T2 && nightCursor === T1,
  );

  finish();
}

try {
  await main();
} finally {
  sandbox.cleanup();
}
