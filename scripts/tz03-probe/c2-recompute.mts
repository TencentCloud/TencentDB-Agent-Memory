/**
 * tz-03a Ф2 — счётчик пересчитывается, а не накапливается
 * (ТЗ A2 :64-72, A2a :75, критерий 1a :85, S2a :116-119).
 *
 * `+=` не умеет уменьшаться: после TTL-чистки он молча расходится с фактом, а
 * повторная финализация того же прогона его задваивает. Формула A2 считает
 * значение из стора по тому же курсору, который только что записан.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=increment — вернуть накопление. Краснеют ноги
 * «равен факту после повтора» и «упал после чистки».
 */
import path from "node:path";
import { advanceCheckpoint } from "../../src/gateway/consolidation/checkpoint-advance.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import {
  countL0UpTo,
  countNewL0Since,
  cursorOfCheckpoint,
  EMPTY_L0_CURSOR,
} from "../../src/gateway/consolidation/diff-builder.js";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { RunSummary } from "../../src/gateway/consolidation/types.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);

const OLD = "2026-08-01T00:00:00.000Z";
const MID = "2026-08-02T00:00:00.000Z";
const NEW = "2026-08-03T00:00:00.000Z";

const sandbox = makeSandbox([]);
const dbPath = path.join(sandbox.dataDir, "vectors.db");
const cp = new ConsolidationCheckpoint(sandbox.dataDir);

function withDb<T>(fn: (db: ReturnType<typeof openWritableSqlite>) => T): T {
  const db = openWritableSqlite(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedStore(): void {
  withDb((db) => {
    db.exec(
      "CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY, recorded_at TEXT)",
    );
    db.exec("CREATE INDEX idx_l0_recorded ON l0_conversations(recorded_at)");
    const ins = db.prepare(
      "INSERT INTO l0_conversations (record_id, recorded_at) VALUES (?, ?)",
    );
    ins.run("r1", OLD);
    ins.run("r2", MID);
    ins.run("r3", MID);
    ins.run("r4", NEW);
    // Пустой recorded_at не считается ни новым, ни обработанным (ТЗ A2).
    ins.run("r5", "");
  });
}

function summaryOf(role: string): RunSummary {
  return {
    role,
    status: "ok",
    startedAt: OLD,
    finishedAt: NEW,
    recordsPresented: 4,
    overLimitBlocks: 0,
    applied: { merges: [], deletes: [], rewrites: [] },
  } as unknown as RunSummary;
}

const ctx = {
  dataDir: sandbox.dataDir,
  checkpoint: cp,
  logger: { debug: () => {} },
} as unknown as OrchestratorContext;

/** Под фальсификацией счётчик снова накапливается поверх записанного. */
async function finalize(newL0: number): Promise<void> {
  const before = (await cp.read()).l0Count;
  await advanceCheckpoint(ctx, EMPTY_L0_CURSOR, newL0, summaryOf("keeper"));
  if (FALSIFY === "increment") {
    await cp.update((d) => {
      d.l0Count = before + newL0;
    });
  }
}

async function main(): Promise<void> {
  seedStore();

  // --- 1. Счётчик равен факту по предикату A2 -------------------------------
  await finalize(4);
  const d1 = await cp.read();
  const fact1 = countL0UpTo(dbPath, cursorOfCheckpoint(d1)) ?? -1;
  console.log(`  после первого прогона: l0Count=${d1.l0Count}, факт=${fact1}`);
  must("счётчик равен факту по предикату A2", d1.l0Count === fact1);

  // --- 2. Повтор того же прогона не меняет значение -------------------------
  await finalize(4);
  const d2 = await cp.read();
  const fact2 = countL0UpTo(dbPath, cursorOfCheckpoint(d2)) ?? -1;
  console.log(`  после повтора: l0Count=${d2.l0Count}, факт=${fact2}`);
  must(
    "повтор не задваивает — счётчик всё ещё равен факту",
    d2.l0Count === fact2,
  );

  // --- 3. Инвариант: обработанные + новые = все непустые --------------------
  const processed = countL0UpTo(dbPath, cursorOfCheckpoint(d2)) ?? -1;
  const fresh = countNewL0Since(dbPath, cursorOfCheckpoint(d2)) ?? -1;
  const total =
    withDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM l0_conversations WHERE recorded_at != ''",
            )
            .get() as { c: number } | null
        )?.c,
    ) ?? -1;
  console.log(`  обработано ${processed} + новых ${fresh} = ${total}?`);
  must(
    "ни одна строка не принадлежит обоим множествам и ни одна не выпала",
    processed + fresh === total && total === 4,
  );

  // --- 4. После TTL-чистки счётчик УМЕНЬШАЕТСЯ ------------------------------
  const beforeCleanup = (await cp.read()).l0Count;
  withDb((db) =>
    db.exec(
      `DELETE FROM l0_conversations WHERE recorded_at != '' AND recorded_at < '${MID}'`,
    ),
  );
  await finalize(0);
  const d3 = await cp.read();
  const fact3 = countL0UpTo(dbPath, cursorOfCheckpoint(d3)) ?? -1;
  console.log(
    `  после TTL-чистки: было ${beforeCleanup}, стало ${d3.l0Count}, факт=${fact3}`,
  );
  must(
    "после TTL-чистки счётчик упал и снова равен факту",
    d3.l0Count < beforeCleanup && d3.l0Count === fact3,
  );

  finish();
}

try {
  await main();
} finally {
  sandbox.cleanup();
}
