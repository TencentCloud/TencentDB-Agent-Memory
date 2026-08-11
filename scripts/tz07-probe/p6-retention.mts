/**
 * tz-07 Ф6, критерий 6 / инвариант `inspectable-run`: сессия роли живёт до
 * истечения retention, а не до ближайшей уборки.
 *
 * Долг tz-06: со снятым `--no-session` сессии копятся без границ, и до этого
 * пакета их не удалял никто, кроме общего age-прохода, который сносил весь
 * run-каталог ЦЕЛИКОМ — вместе с сессией, тремя уровнями ниже.
 *
 * ФАЛЬСИФИКАЦИЯ (S4): один и тот же старый прогон при коротком и при длинном
 * retention. Короткий обязан удалить, длинный — сохранить. Одинаковое
 * поведение = значение не читается, и «retention» существует только на бумаге.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCleanup } from "../../src/gateway/cleanup.js";
import type { Logger } from "../../src/core/types.js";
import { must, finish } from "./assert.mts";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const HOUR = 3_600_000;
const now = Date.now();

function makeRun(scratchRoot: string, ageHours: number): string {
  const session = path.join(
    scratchRoot,
    "run-old",
    "attempts",
    "attempt-1",
    "session",
  );
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "transcript.jsonl"), "{}\n", "utf-8");
  // Несессионное содержимое той же попытки — оно чистится по intervalHours.
  const out = path.join(scratchRoot, "run-old", "attempts", "attempt-1", "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "result.json"), "{}", "utf-8");

  const old = new Date(now - ageHours * HOUR);
  for (const p of [
    path.join(session, "transcript.jsonl"),
    session,
    path.join(out, "result.json"),
    out,
    path.join(scratchRoot, "run-old", "attempts", "attempt-1"),
    path.join(scratchRoot, "run-old", "attempts"),
    path.join(scratchRoot, "run-old"),
  ]) {
    fs.utimesSync(p, old, old);
  }
  return session;
}

async function leg(sessionRetentionHours: number): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-p6-"));
  const dataDir = path.join(home, "data");
  const scratchRoot = path.join(home, "scratch");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(scratchRoot, { recursive: true });
  // Прогон старше общего интервала уборки (24 ч) — то есть уборка до него
  // ДОБИРАЕТСЯ; вопрос только в том, переживёт ли сессия.
  const session = makeRun(scratchRoot, 48);
  const outFile = path.join(
    scratchRoot,
    "run-old",
    "attempts",
    "attempt-1",
    "out",
    "result.json",
  );

  const stats = await runCleanup({
    dataDir,
    scratchRoot,
    hostTaskRoots: [],
    home,
    sessionRetentionHours,
    config: { enabled: true, intervalHours: 24, paths: [] },
    now: () => now,
    logger: silent,
  });

  const sessionAlive = fs.existsSync(session);
  // inspectable-run: артефакты прогона обязаны жить столько же, сколько сессия,
  // иначе транскрипт без result.json — это не «разбираемый прогон».
  const artefactsAlive = fs.existsSync(outFile);
  console.log(
    `retention=${String(sessionRetentionHours).padStart(5)}ч → сессия жива: ${String(sessionAlive).padEnd(5)} | артефакты живы: ${String(artefactsAlive).padEnd(5)} | removedDirs=${stats.removedDirs} errors=${stats.errors.length}`,
  );
  // Обе ноги — машинно проверяемые: короткий retention обязан снести и сессию,
  // и артефакты, длинный — сохранить оба. Печать без проверки делала бы
  // критерий 6 отчётом для человека, а не чеком.
  const short = sessionRetentionHours < 24;
  must(
    `retention=${sessionRetentionHours}ч: сессия ${short ? "удалена" : "жива"}`,
    short ? !sessionAlive : sessionAlive,
  );
  must(
    `retention=${sessionRetentionHours}ч: артефакты ${short ? "удалены" : "живы"}`,
    short ? !artefactsAlive : artefactsAlive,
  );
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("прогон старше 24 ч (общий интервал уборки), сессия внутри него:");
// Заведомо короткий retention: сессия обязана исчезнуть.
await leg(1);
// Заведомо длинный: обязана выжить, и вместе с ней — каталог-контейнер.
await leg(9999);
console.log(
  "ожидание: первая строка — всё false, вторая — всё true; иначе retention не читается",
);

finish();
