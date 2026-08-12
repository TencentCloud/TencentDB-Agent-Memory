/**
 * tz-09 — прогон, который отказал, не остаётся живым (живой дефект).
 *
 * Найдено на боевом инстансе: 78 прогонов из 86 закрыты как `orphan-run`, а
 * ручной прогон, чей ребёнок упал (у провайдера кончились кредиты, HTTP 402),
 * остался в состоянии `running` навсегда. Причина: класс отказа
 * `invalid-role-output` не терминален для Run (P9 §4.2 — реакция «новая
 * попытка»), и `finalizeRunOutcome` возвращал Run в `running`. Но повторную
 * попытку ТОГО ЖЕ Run продукт не делает: каждый запуск роли создаёт новый Run
 * (execute-run.ts), а бюджет ретраев диспетчер считает по чекпойнту роли
 * (dispatcher.ts:94). Значит Run висел до следующего старта gateway, где
 * recovery метила его `orphan-run` — и статистика прогонов превращалась в
 * мусор.
 *
 * Проба: настоящий gateway в песочнице, настоящий ручной прогон, ребёнок
 * падает сам (под песочным HOME нет кредов). Затем gateway перезапускается —
 * закрытый прогон recovery трогать не должна.
 *
 * FALSIFY=stay-running — оставляет прогон в `running`, как до фикса: обе ноги
 * ложны (Run жив после отказа, и рестарт метит его orphan-run).
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import {
  listRecentRuns,
  updateRun,
} from "../../src/gateway/control-plane/run-repo.js";
import { claimRun } from "../../src/gateway/control-plane/lease.js";
import { must, finish } from "../tz07-probe/assert.mts";

const PORT = 8796;
const LIVE = new Set(["created", "claimed", "running", "reviewed", "applying"]);
const sbx = makeSandbox(["memory-keeper"]);
process.env.HOME = sbx.home;

const cfgPath = path.join(sbx.home, "tdai-gateway.yaml");
fs.writeFileSync(
  cfgPath,
  [
    "server:",
    "  host: 127.0.0.1",
    `  port: ${PORT}`,
    "data:",
    `  baseDir: ${sbx.dataDir}`,
    "memory:",
    "  consolidation:",
    "    enabled: true",
  ].join("\n"),
  "utf-8",
);
process.env.TDAI_GATEWAY_CONFIG = cfgPath;

const gateway = new TdaiGateway();
await gateway.start();
const token = fs
  .readFileSync(
    path.join(path.dirname(sbx.dataDir), "tdai-gateway.token"),
    "utf-8",
  )
  .trim();

const res = await fetch(`http://127.0.0.1:${PORT}/memory/run`, {
  method: "POST",
  headers: { "x-memory-token": token, "content-type": "application/json" },
  body: "{}",
});
console.log(`POST /memory/run -> ${res.status}`);

// Ждём, пока прогон закончится: класс отказа записан финализацией.
const deadline = Date.now() + 60_000;
let row = listRecentRuns(sbx.dataDir)[0];
while (Date.now() < deadline && (row?.errorClass ?? null) === null) {
  await new Promise((r) => setTimeout(r, 500));
  row = listRecentRuns(sbx.dataDir)[0];
}
if (process.env.FALSIFY === "stay-running" && row !== undefined) {
  // Дофиксовое поведение: нетерминальный класс возвращал Run в `running`.
  updateRun(
    sbx.dataDir,
    row.runId,
    { state: "running" },
    new Date().toISOString(),
  );
  row = listRecentRuns(sbx.dataDir)[0];
}
console.log(
  `после отказа: state=${row?.state} errorClass=${row?.errorClass} finishedAt=${row?.finishedAt}`,
);
must(
  "отказавший прогон закрыт, а не оставлен живым",
  row !== undefined && !LIVE.has(row.state),
);

await gateway.stop();

// Рестарт процесса = НОВЫЙ pid. В пробе оба gateway живут в одном процессе,
// поэтому владелец подменяется на мёртвый pid — ровно то, что recovery видит
// после настоящего рестарта (owner.ts: ownerIsGone).
if (row !== undefined) {
  claimRun(sbx.dataDir, row.runId, "penis:999999", {
    nowMs: Date.now(),
    ttlMs: 600_000,
    force: true,
  });
}

// Рестарт: recovery не должна находить, что подбирать.
const second = new TdaiGateway();
await second.start();
await second.stop();
const after = listRecentRuns(sbx.dataDir).find((r) => r.runId === row?.runId);
console.log(
  `после рестарта: state=${after?.state} errorClass=${after?.errorClass}`,
);
must(
  "рестарт gateway не превращает закрытый прогон в orphan-run",
  after?.errorClass !== "orphan-run",
);

sbx.cleanup();
finish();
