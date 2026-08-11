/**
 * tz-03a Ф3 — курсор монотонен (ТЗ A2b :76, критерий 3 :87, S3 :121-124).
 *
 * Сценарий ТЗ: day и night идут параллельно, night стартовал раньше и
 * финиширует ВТОРЫМ с меньшим anchor'ом. Против собственного снимка старта
 * его anchor выглядит движением вперёд, и курсор откатывается. Проверяются
 * ОБА значения: курсор равен максимальному, и счётчик посчитан по этому же
 * максимальному курсору, а не по отвергнутому анкеру.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=prev-snapshot — сравнивать со снимком старта, как
 * было. Краснеют обе ноги.
 */
import path from "node:path";
import {
  advanceCheckpoint,
  cursorGte,
} from "../../src/gateway/consolidation/checkpoint-advance.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import {
  countL0UpTo,
  cursorOfCheckpoint,
  EMPTY_L0_CURSOR,
  type L0Cursor,
} from "../../src/gateway/consolidation/diff-builder.js";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { RunSummary } from "../../src/gateway/consolidation/types.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);

const EARLY = "2026-08-01T00:00:00.000Z";
const LATE = "2026-08-02T00:00:00.000Z";

const sandbox = makeSandbox([]);
const dbPath = path.join(sandbox.dataDir, "vectors.db");
const cp = new ConsolidationCheckpoint(sandbox.dataDir);
const ctx = {
  dataDir: sandbox.dataDir,
  checkpoint: cp,
  logger: { debug: () => {} },
} as unknown as OrchestratorContext;

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
    ins.run("r1", EARLY);
    ins.run("r2", LATE);
    ins.run("r3", LATE);
  } finally {
    db.close();
  }
}

function summaryOf(role: string): RunSummary {
  return {
    role,
    status: "ok",
    startedAt: EARLY,
    finishedAt: LATE,
    recordsPresented: 1,
    overLimitBlocks: 0,
    applied: { merges: [], deletes: [], rewrites: [] },
  } as unknown as RunSummary;
}

/**
 * Под фальсификацией финализация повторяет старое поведение: решение
 * принимается по снимку старта, а не по живому значению.
 */
async function finalize(
  role: string,
  startSnapshot: L0Cursor,
  anchor: L0Cursor,
): Promise<void> {
  if (FALSIFY === "prev-snapshot") {
    await cp.update((d) => {
      if (anchor.recordedAt && cursorGte(anchor, startSnapshot)) {
        d.l0Cursor = anchor.recordedAt;
        d.l0CursorId = anchor.recordId;
      }
      d.l0Count = countL0UpTo(dbPath, cursorOfCheckpoint(d)) ?? d.l0Count;
    });
    return;
  }
  await advanceCheckpoint(ctx, startSnapshot, 0, summaryOf(role), anchor);
}

async function main(): Promise<void> {
  seedStore();

  // Оба прогона стартовали с пустого курсора — это их общий снимок старта.
  const startSnapshot = EMPTY_L0_CURSOR;

  // day финиширует первым и доводит курсор до самой свежей пары.
  await finalize("memory-keeper", startSnapshot, {
    recordedAt: LATE,
    recordId: "r3",
  });
  const afterDay = await cp.read();
  console.log(`  после day: ${afterDay.l0Cursor}/${afterDay.l0CursorId}`);

  // night финиширует вторым, его anchor МЕНЬШЕ.
  await finalize("night-keeper", startSnapshot, {
    recordedAt: EARLY,
    recordId: "r1",
  });
  const afterNight = await cp.read();
  console.log(
    `  после night: ${afterNight.l0Cursor}/${afterNight.l0CursorId}, l0Count=${afterNight.l0Count}`,
  );

  must(
    "курсор равен максимальному из двух, а не последнему записанному",
    afterNight.l0Cursor === LATE && afterNight.l0CursorId === "r3",
  );

  const factByMax = countL0UpTo(dbPath, {
    recordedAt: LATE,
    recordId: "r3",
  });
  const factByRejected = countL0UpTo(dbPath, {
    recordedAt: EARLY,
    recordId: "r1",
  });
  console.log(
    `  факт по максимальному курсору ${factByMax}, по отвергнутому ${factByRejected}`,
  );
  must(
    "счётчик посчитан по максимальному курсору, а не по отвергнутому анкеру",
    afterNight.l0Count === factByMax && factByMax !== factByRejected,
  );

  finish();
}

try {
  await main();
} finally {
  sandbox.cleanup();
}
