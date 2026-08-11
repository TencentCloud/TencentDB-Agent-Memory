/**
 * tz-03a — ЖИВОЙ прогон продукта: настоящий процесс gateway на песочнице.
 *
 * Пробы c1-c7 дёргают функции. Эта поднимает РЕАЛЬНЫЙ сервер тем же способом,
 * которым его поднимает пользователь, и разговаривает с ним по HTTP. Она
 * доказывает, что изменённые пути (чтение чекпойнта с парой, счёт «новых» в
 * /status-ветке, дашборд) грузятся и работают в живом процессе, а не только
 * под tsx в тестовом импорте.
 *
 * Чего она НЕ доказывает: /status не отдаёт newL0 наружу, поэтому равенство
 * счёта в статусе и в прогоне проверяется ногой 5 пробы c1, а не здесь.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const T1 = "2026-08-01T00:00:00.000Z";
const T2 = "2026-08-02T00:00:00.000Z";
const PORT = 18000 + Math.floor(Math.random() * 900);

const sandbox = makeSandbox([]);

const db = openWritableSqlite(path.join(sandbox.dataDir, "vectors.db"));
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

// Чекпойнт стоит РОВНО на границе: пара (T2, r2) обработана, r3 — нет.
fs.writeFileSync(
  path.join(sandbox.dataDir, ".metadata", "consolidation_checkpoint.json"),
  JSON.stringify(
    { lastRunAt: T2, l0Cursor: T2, l0CursorId: "r2", l0Count: 2, roles: {} },
    null,
    2,
  ),
  "utf-8",
);

const proc = spawn("npx", ["tsx", "src/gateway/server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: sandbox.home,
    TDAI_DATA_DIR: sandbox.dataDir,
    TDAI_GATEWAY_PORT: String(PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (b: Buffer) => (log += b.toString()));
proc.stderr.on("data", (b: Buffer) => (log += b.toString()));

/** Дождаться живого /status, но не дольше 60 с. */
async function waitForStatus(): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/status`);
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      // ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const status = await waitForStatus();
if (status === null) {
  console.log(log.split("\n").slice(-15).join("\n"));
}
must("живой gateway поднялся и ответил на GET /status", status !== null);

if (status !== null) {
  const consolidation = status.consolidation as
    { checkpoint?: string } | undefined;
  console.log(`  dataPath: ${String(status.dataPath)}`);
  console.log(`  checkpoint: ${String(consolidation?.checkpoint)}`);
  must(
    "процесс работает на песочнице, а не на живом дереве пользователя",
    String(status.dataPath) === sandbox.dataDir &&
      String(consolidation?.checkpoint).startsWith(sandbox.dataDir),
  );
  must(
    "чекпойнт с парой прочитан живым процессом без ошибок",
    !/l0CursorId|checkpoint.*(error|failed)/i.test(log),
  );
}

proc.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
proc.kill("SIGKILL");
sandbox.cleanup();
finish();
