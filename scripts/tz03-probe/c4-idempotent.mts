/**
 * tz-03a Ф4 — финализация идемпотентна по runId, а курсор двигается только
 * после полного apply (ТЗ deliverable 03a :27, критерий 2 :86).
 *
 * Проверяется ПАРА правил, а не одно: курсор двигается только при
 * `state = 'applied'`, но отметка прогона роли ставится ВСЕГДА — иначе роль,
 * которой запретили продвижение, пойдёт на повтор каждый тик.
 *
 * ФАЛЬСИФИКАЦИИ:
 *   FALSIFY=no-marker    — игнорировать отметку идемпотентности.
 *   FALSIFY=advance-first — двигать курсор до проверки состояния прогона.
 *   FALSIFY=skip-stamp   — не ставить отметку роли на заблокированном пути.
 *   FALSIFY=keep-claim   — не возвращать притязание после упавшей финализации.
 */
import fs from "node:fs";
import path from "node:path";
import { finalizeCheckpointAfterRun } from "../../src/gateway/consolidation/checkpoint-gate.js";
import { advanceCheckpoint } from "../../src/gateway/consolidation/checkpoint-advance.js";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { EMPTY_L0_CURSOR } from "../../src/gateway/consolidation/diff-builder.js";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import {
  createRun,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { checkpointFinalizedAt } from "../../src/gateway/control-plane/checkpoint-claim.js";
import type { OrchestratorContext } from "../../src/gateway/consolidation/context.js";
import type { RunSummary } from "../../src/gateway/consolidation/types.js";
import type { RunState } from "../../src/gateway/control-plane/run-types.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);

const T1 = "2026-08-01T00:00:00.000Z";
const T2 = "2026-08-02T00:00:00.000Z";
const NOW = "2026-08-03T00:00:00.000Z";

const sandbox = makeSandbox([]);
const dbPath = path.join(sandbox.dataDir, "vectors.db");
const cp = new ConsolidationCheckpoint(sandbox.dataDir);
const ctx = {
  dataDir: sandbox.dataDir,
  checkpoint: cp,
  now: () => Date.parse(NOW),
  logger: { debug: () => {}, warn: () => {} },
} as unknown as OrchestratorContext;

function seedStore(): void {
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
  } finally {
    db.close();
  }
}

function summaryOf(role: string, ok: boolean): RunSummary {
  return {
    role,
    status: ok ? "ok" : "failed",
    startedAt: T1,
    finishedAt: NOW,
    recordsPresented: 1,
    overLimitBlocks: 0,
    applied: { merges: [], deletes: [], rewrites: [] },
  } as unknown as RunSummary;
}

/** Прогон в control-plane, доведённый до нужного состояния. */
function makeRun(runId: string, state: RunState): void {
  createRun(
    sandbox.dataDir,
    {
      runId,
      roleId: "memory-keeper",
      contractHash: "h",
      contractJson: "{}",
      binding: "local",
    } as never,
    NOW,
  );
  updateRun(sandbox.dataDir, runId, { state }, NOW);
}

/** Финализация — под фальсификацией с подменённым поведением. */
async function finalize(runId: string, role: string, ok = true): Promise<void> {
  const summary = summaryOf(role, ok);
  const advance = { anchor: { recordedAt: T2, recordId: "r2" } };
  if (FALSIFY === "advance-first") {
    // Старый порядок: сначала двигаем, потом (не) смотрим на состояние.
    await advanceCheckpoint(ctx, EMPTY_L0_CURSOR, 1, summary, advance.anchor);
    return;
  }
  if (FALSIFY === "no-marker") {
    // Отметка игнорируется: любой applied-прогон двигает курсор снова.
    await advanceCheckpoint(ctx, EMPTY_L0_CURSOR, 1, summary, advance.anchor);
    return;
  }
  if (FALSIFY === "skip-stamp") {
    const { readRun } =
      await import("../../src/gateway/control-plane/run-repo.js");
    if (readRun(sandbox.dataDir, runId)?.state === "applied") {
      await finalizeCheckpointAfterRun({
        ctx,
        runId,
        advance,
        cursor: EMPTY_L0_CURSOR,
        newL0: 1,
        summary,
      });
    }
    return; // заблокированный путь молча ничего не отмечает
  }
  await finalizeCheckpointAfterRun({
    ctx,
    runId,
    advance,
    cursor: EMPTY_L0_CURSOR,
    newL0: 1,
    summary,
  });
}

async function main(): Promise<void> {
  seedStore();

  // --- 1. Повтор того же runId после «краша» ничего не меняет ---------------
  makeRun("run-applied", "applied");
  await finalize("run-applied", "memory-keeper");
  const first = await cp.read();
  await finalize("run-applied", "memory-keeper"); // повтор после краша
  const second = await cp.read();
  console.log(
    `  первый: ${first.l0Cursor}/${first.l0CursorId} count=${first.l0Count}; ` +
      `повтор: ${second.l0Cursor}/${second.l0CursorId} count=${second.l0Count}`,
  );
  must(
    "повтор того же runId не меняет ни курсор, ни счётчик",
    second.l0Cursor === first.l0Cursor &&
      second.l0CursorId === first.l0CursorId &&
      second.l0Count === first.l0Count &&
      first.l0Cursor === T2,
  );
  must(
    "отметка финализации записана в control-plane",
    checkpointFinalizedAt(sandbox.dataDir, "run-applied") !== "",
  );

  // --- 2. Частичный apply курсор не двигает --------------------------------
  await cp.update((d) => {
    d.l0Cursor = "";
    d.l0CursorId = "";
    d.l0Count = 0;
    d.roles = {};
  });
  makeRun("run-partial", "needs-reconciliation");
  await finalize("run-partial", "night-keeper", false);
  const afterPartial = await cp.read();
  console.log(
    `  частичный apply → курсор "${afterPartial.l0Cursor}", ` +
      `роль отмечена: ${afterPartial.roles["night-keeper"] !== undefined}`,
  );
  must(
    "частичный apply (needs-reconciliation) не двигает курсор",
    afterPartial.l0Cursor === "",
  );

  // --- 3. failed тоже не двигает, но повторяемость роли сохранена ----------
  makeRun("run-failed", "failed");
  await finalize("run-failed", "night-keeper", false);
  const afterFailed = await cp.read();
  const night = afterFailed.roles["night-keeper"];
  console.log(
    `  failed → курсор "${afterFailed.l0Cursor}", lastRunAt="${night?.lastRunAt}", ` +
      `consecutiveFailures=${night?.consecutiveFailures}`,
  );
  must("failed не двигает курсор", afterFailed.l0Cursor === "");
  must(
    "у неуспешного прогона lastRunAt не обновлён, а счётчик отказов вырос",
    night !== undefined &&
      night.lastRunAt === "" &&
      (night.consecutiveFailures ?? 0) === 2,
  );

  // --- 4. Отказ owner-гварда при статусе ok: курсор держим, роль отмечаем ---
  // Строка прогона осталась в `running` — updateRun отказал другому владельцу.
  makeRun("run-refused", "running");
  await finalize("run-refused", "memory-keeper");
  const afterRefused = await cp.read();
  const keeper = afterRefused.roles["memory-keeper"];
  console.log(
    `  owner-отказ → курсор "${afterRefused.l0Cursor}", lastRunAt="${keeper?.lastRunAt}"`,
  );
  must(
    "прогон не в applied → курсор не двинулся",
    afterRefused.l0Cursor === "",
  );
  must(
    "но роль отмечена — иначе повтор каждый тик",
    keeper !== undefined && keeper.lastRunAt === NOW,
  );

  // --- 5. Упавшая финализация ВОЗВРАЩАЕТ притязание -------------------------
  // Иначе отметка переживает работу, ради которой была взята, и продвижение
  // этого прогона теряется навсегда (например, лок чекпойнта истёк по таймауту
  // после kill -9 держателя).
  makeRun("run-boom", "applied");
  const boomCtx = {
    ...ctx,
    checkpoint: {
      update: () => {
        throw new Error("checkpoint lock still held — simulated");
      },
      read: () => cp.read(),
    },
  } as unknown as OrchestratorContext;
  let threw = false;
  try {
    await finalizeCheckpointAfterRun({
      ctx: boomCtx,
      runId: "run-boom",
      advance: { anchor: { recordedAt: T2, recordId: "r2" } },
      cursor: EMPTY_L0_CURSOR,
      newL0: 1,
      summary: summaryOf("memory-keeper", true),
    });
  } catch {
    threw = true;
  }
  const markAfterBoom =
    FALSIFY === "keep-claim"
      ? "2026-01-01T00:00:00.000Z" // старое поведение: отметка осталась
      : checkpointFinalizedAt(sandbox.dataDir, "run-boom");
  console.log(
    `  упавшая финализация: бросила=${threw}, отметка после="${markAfterBoom}"`,
  );
  must(
    "притязание возвращено, следующая попытка сможет продвинуть курсор",
    threw && markAfterBoom === "",
  );

  // --- 6. Сломанный control-plane не превращает прогон в ошибку -------------
  // Конвенция run-outcome.ts: control-plane — это состояние, а не сам прогон.
  const cpDb = path.join(sandbox.dataDir, ".metadata", "control-plane.db");
  fs.writeFileSync(cpDb, "не база данных", "utf-8");
  let brokeRun = false;
  const cursorBefore = (await cp.read()).l0Cursor;
  try {
    await finalizeCheckpointAfterRun({
      ctx,
      runId: "run-applied",
      advance: { anchor: { recordedAt: T2, recordId: "r2" } },
      cursor: EMPTY_L0_CURSOR,
      newL0: 1,
      summary: summaryOf("memory-keeper", true),
    });
  } catch {
    brokeRun = true;
  }
  const cursorAfter = (await cp.read()).l0Cursor;
  console.log(
    `  сломанный control-plane: прогон упал=${brokeRun}, курсор "${cursorBefore}" → "${cursorAfter}"`,
  );
  must(
    "сломанный control-plane держит курсор, но прогон не падает",
    !brokeRun && cursorAfter === cursorBefore,
  );

  finish();
}

try {
  await main();
} finally {
  sandbox.cleanup();
}
