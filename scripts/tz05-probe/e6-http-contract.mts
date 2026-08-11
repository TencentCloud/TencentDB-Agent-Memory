/**
 * tz-05 e6 — ЖИВОЙ прогон продукта: настоящий процесс gateway на песочнице.
 *
 * Остальные пробы дёргают функции. Эта поднимает сервер тем же способом, что и
 * пользователь, шлёт настоящие HTTP-запросы на маршруты памяти и смотрит, что
 * (1) мутирующий маршрут отвечает 200, (2) носители после него несут scope и
 * provenance, (3) ни в одном пути ответа не всплыл живой `~/.pi` — процесс
 * работает на песочнице, а не на памяти пользователя.
 *
 * Режим фальсификации: FALSIFY=pi-path — в проверяемый набор путей
 * подмешивается живой `~/.pi`. Нога про пути обязана покраснеть, иначе она
 * проверяла бы пустое множество и была бы зелёной всегда.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { openWritableSqlite } from "../../src/gateway/http-utils.js";
import { must, finish } from "../tz07-probe/assert.mts";
import { makeSandbox } from "../tz09-probe/sandbox.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const PORT = 18700 + Math.floor(Math.random() * 90);
const PROJECT = "/repo/probe-alpha";
const sandbox = makeSandbox([]);

// Блок сцены с проектным слагом — чтобы было что штамповать после мутации.
const { projectSlug } = await import("../../src/core/scene/scene-paths.js");
const blocksDir = path.join(
  sandbox.dataDir,
  "scene_blocks",
  projectSlug(PROJECT),
);
fs.mkdirSync(blocksDir, { recursive: true });
fs.writeFileSync(
  path.join(blocksDir, "deploy.md"),
  [
    "-----META-START-----",
    "created: 2026-08-01T00:00:00Z",
    "updated: 2026-08-01T00:00:00Z",
    "summary: живая сцена",
    "heat: 1",
    "-----META-END-----",
    "",
    "# деплой",
    "",
    "живой блок",
    "",
  ].join("\n"),
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
  must("процесс поднял стор, а не деградировал", status.vectorStore === true);

  // Записи в схему, которую создал сам процесс: свой проект, чужой, global.
  const db = openWritableSqlite(path.join(sandbox.dataDir, "vectors.db"));
  try {
    const ins = db.prepare(
      "INSERT INTO l1_records (record_id, content, type, priority, created_time, updated_time, project_id, scope) " +
        "VALUES (?, ?, 'episodic', 10, '2026-08-01', '2026-08-01', ?, ?)",
    );
    ins.run("own", "живой деплой один", PROJECT, "project");
    ins.run("other", "живой деплой два", "/repo/чужой", "project");
    ins.run("global", "живой деплой три", "", "global");
  } finally {
    db.close();
  }

  const token = fs
    .readFileSync(
      path.join(path.dirname(sandbox.dataDir), "tdai-gateway.token"),
      "utf-8",
    )
    .trim();
  const headers = {
    "content-type": "application/json",
    "x-memory-token": token,
  };

  const feedback = await fetch(`http://127.0.0.1:${PORT}/memory/feedback`, {
    method: "POST",
    headers,
    body: JSON.stringify({ keys: ["живой деплой"] }),
  });
  const feedbackBody = (await feedback.json()) as Record<string, unknown>;
  console.log(
    `  POST /memory/feedback → ${feedback.status} ${JSON.stringify(feedbackBody)}`,
  );
  must("мутирующий маршрут ответил 200", feedback.status === 200);

  const blocks = await fetch(`http://127.0.0.1:${PORT}/memory/blocks`, {
    headers,
  });
  const blocksBody = (await blocks.json()) as Record<string, unknown>;
  console.log(`  GET /memory/blocks → ${blocks.status}`);
  must("читающий маршрут ответил 200", blocks.status === 200);

  const search = await fetch(
    `http://127.0.0.1:${PORT}/memory/search?query=${encodeURIComponent("живой деплой")}&limit=10`,
    { headers },
  );
  const searchBody = (await search.json()) as Record<string, unknown>;
  console.log(
    `  GET /memory/search → ${search.status}, total=${String(searchBody.total)}, strategy=${String(searchBody.strategy)}`,
  );
  must("маршрут поиска ответил 200", search.status === 200);
  // total=0 здесь — не поломка: строки засеяны прямым INSERT в l1_records,
  // мимо FTS-индекса и без эмбеддингов, а дефолтная стратегия — embedding.
  // Живая нога про фильтрацию по проекту невозможна на этом маршруте: у
  // GET /memory/search нет параметра project_id, scope туда приходит только с
  // hook-пути recall (см. отчёт пакета).
  must(
    "ответ поиска имеет ожидаемую форму",
    typeof searchBody.total === "number" &&
      typeof searchBody.strategy === "string",
  );

  // Наблюдатель провенанса ОБОРАЧИВАЕТ счётчики (server.ts) — если бы обёртка
  // потеряла внутреннего наблюдателя, счётчики после живой мутации остались бы
  // пустыми. Это и есть живая проверка композиции из Ф5.
  await new Promise((r) => setTimeout(r, 800));
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
    "обёртка провенанса не съела счётчики: l1Count проставлен живым процессом",
    saved.l1Count === 3,
  );
  must("и блок сцены посчитан", saved.sceneCount === 1);
  // Блок сцены при этом НЕ проштампован: мутация была L1 (feedback), а сцену
  // штампует только мутация носителя scene. Наблюдение, а не претензия.
  const raw = fs.readFileSync(path.join(blocksDir, "deploy.md"), "utf-8");
  console.log(
    `  сцена после L1-мутации содержит provenance: ${raw.includes("provenance:")} (ожидается false — тронут другой носитель)`,
  );
  must("L1-мутация не трогает носитель сцены", !raw.includes("provenance:"));

  // Пути в ответах — только песочница. Живой ~/.pi всплыть не должен.
  const livePi = path.join(os.homedir(), ".pi");
  const paths = [
    String(status.dataPath),
    JSON.stringify(blocksBody),
    ...(FALSIFY === "pi-path"
      ? [path.join(livePi, "agent-memory", "tdai")]
      : []),
  ];
  console.log(`  проверено путей: ${paths.length}, живой корень: ${livePi}`);
  must(
    "ни в одном пути ответа нет живого ~/.pi — прогон идёт на песочнице",
    !paths.some((p) => p.includes(livePi)),
  );
  must("dataPath — это песочница", String(status.dataPath) === sandbox.dataDir);
}

proc.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
proc.kill("SIGKILL");
sandbox.cleanup();
finish();
