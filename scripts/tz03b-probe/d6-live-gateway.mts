/**
 * tz-03b — ЖИВОЙ прогон продукта: настоящий процесс gateway на песочнице.
 *
 * Пробы d1-d5 дёргают функции. Эта поднимает РЕАЛЬНЫЙ сервер тем же способом,
 * которым его поднимает пользователь, шлёт ему настоящий HTTP-запрос на
 * мутирующий маршрут (POST /memory/feedback) и смотрит, что счётчики в
 * checkpoint-файле проставились сами — то есть подписка наблюдателя реально
 * стоит в боевом пути запуска, а не только в тестах.
 *
 * Заодно печатается секция memory_health.md — тот самый названный потребитель.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import { layerCountersSection } from "../../src/gateway/consolidation/checkpoint-report.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const PORT = 18900 + Math.floor(Math.random() * 90);
const sandbox = makeSandbox([]);

// Схему стора создаёт САМ gateway при инициализации — рукописная таблица
// l1_records уронила бы инициализацию в degraded, и проба мерила бы не то.
// Поэтому строки вставляются ПОСЛЕ подъёма процесса (см. ниже).
const dbPath = path.join(sandbox.dataDir, "vectors.db");
fs.mkdirSync(path.join(sandbox.dataDir, "scene_blocks", "_global"), {
  recursive: true,
});
fs.writeFileSync(
  path.join(sandbox.dataDir, "scene_blocks", "_global", "scene.md"),
  "# сцена",
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
if (status === null) console.log(log.split("\n").slice(-15).join("\n"));
must("живой gateway поднялся и ответил на GET /status", status !== null);

if (status !== null) {
  console.log(`  dataPath: ${String(status.dataPath)}`);
  console.log(
    `  vectorStore: ${String(status.vectorStore)}, status: ${String(status.status)}`,
  );
  must(
    "живой процесс поднял стор, а не деградировал",
    status.vectorStore === true,
  );
  must(
    "процесс работает на песочнице, а не на живом дереве пользователя",
    String(status.dataPath) === sandbox.dataDir,
  );

  // Три записи в НАСТОЯЩУЮ схему, которую создал сам процесс.
  const db = openWritableSqlite(dbPath);
  try {
    const ins = db.prepare(
      "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time) " +
        "VALUES (?, ?, 'episodic', 10, '2026-08-01', '2026-08-01')",
    );
    ins.run("a", "живая запись один");
    ins.run("b", "живая запись два");
    ins.run("c", "живая запись три");
  } finally {
    db.close();
  }

  // Настоящий мутирующий запрос по HTTP. Токен — сосед dataDir (token.ts:39).
  const token = fs
    .readFileSync(
      path.join(path.dirname(sandbox.dataDir), "tdai-gateway.token"),
      "utf-8",
    )
    .trim();

  const res = await fetch(`http://127.0.0.1:${PORT}/memory/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-memory-token": token,
    },
    body: JSON.stringify({ keys: ["живая запись"] }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(
    `  POST /memory/feedback → ${res.status} ${JSON.stringify(body)}`,
  );
  must("мутирующий маршрут ответил 200", res.status === 200);
  must("и действительно поднял приоритет записям", Number(body.bumped) > 0);

  await new Promise((r) => setTimeout(r, 500));
  const cpFile = path.join(
    sandbox.dataDir,
    ".metadata",
    "consolidation_checkpoint.json",
  );
  const saved = fs.existsSync(cpFile)
    ? (JSON.parse(fs.readFileSync(cpFile, "utf-8")) as Record<string, unknown>)
    : {};
  console.log(
    `  checkpoint после живого запроса: l1Count=${String(saved.l1Count)}, sceneCount=${String(saved.sceneCount)}`,
  );
  must(
    "живой процесс сам проставил счётчики — подписка стоит в боевом пути запуска",
    saved.l1Count === 3 && saved.sceneCount === 1,
  );

  console.log("  --- секция memory_health.md ---");
  for (const line of layerCountersSection(sandbox.dataDir))
    console.log(`  ${line}`);
  must(
    "секция отчёта показывает совпадение с носителем",
    layerCountersSection(sandbox.dataDir).some((l) =>
      l.includes("l1Count: 3 (matches the carrier)"),
    ),
  );
}

proc.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
proc.kill("SIGKILL");
sandbox.cleanup();
finish();
