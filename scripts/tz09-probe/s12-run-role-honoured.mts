/**
 * tz-09 — POST /memory/run исполняет НАЗВАННУЮ роль (живой дефект).
 *
 * Найдено на боевом инстансе: запрос с телом `{"role":"night-keeper"}`
 * создал прогон роли `memory-keeper`. Маршрут читал только `?dry=1`, тело
 * не парсил вовсе, и параметр молча пропадал — вызывающий получал Run чужой
 * роли и ни одного признака, что его выбор выброшен.
 *
 * Проба: настоящий gateway в песочнице, две роли на диске. Три запроса —
 * названная роль, несуществующая, выключенная — и пустое тело как контроль
 * обратной совместимости (маршрут появился раньше тела).
 *
 * FALSIFY=drop-role — снимает роль с запроса ровно так, как её терял
 * дофиксовый маршрут: прогон уходит роли по умолчанию, нога ложна.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { listRecentRuns } from "../../src/gateway/control-plane/run-repo.js";
import { must, finish } from "../tz07-probe/assert.mts";

const PORT = 8797;
const DROP_ROLE = process.env.FALSIFY === "drop-role";

const sbx = makeSandbox(["memory-keeper", "night-keeper"]);
process.env.HOME = sbx.home;

// Выключенная роль: 409 должен отличаться от «нет такой роли».
const offDir = path.join(sbx.roleDir, "sleeping-keeper");
fs.mkdirSync(offDir, { recursive: true });
fs.writeFileSync(
  path.join(offDir, "role.json"),
  JSON.stringify({
    name: "sleeping-keeper",
    enabled: false,
    prompt_file: "prompt.md",
  }),
  "utf-8",
);
fs.writeFileSync(path.join(offDir, "prompt.md"), "sleeping", "utf-8");

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

async function post(
  body: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/memory/run`, {
    method: "POST",
    headers: { "x-memory-token": token, "content-type": "application/json" },
    ...(body === null ? {} : { body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  console.log(
    `POST /memory/run ${body ?? "(пустое тело)"} -> ${res.status} ${JSON.stringify(json)}`,
  );
  return { status: res.status, json };
}

/** Ждём строку Run для этого запроса: она создаётся до запуска ребёнка. */
async function runIdOf(runId: string): Promise<string | undefined> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = listRecentRuns(sbx.dataDir).find((r) => r.runId === runId);
    if (row) return row.roleId;
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}

const named = await post(DROP_ROLE ? "{}" : '{"role":"night-keeper"}');
const roleId = await runIdOf(String(named.json.runId));
console.log(`  прогон создан для роли: ${roleId}`);
must(
  "названная роль исполняется, а не подменяется дефолтной",
  roleId === "night-keeper",
);

const before = listRecentRuns(sbx.dataDir).length;
const unknown = await post('{"role":"no-such-role"}');
const off = await post('{"role":"sleeping-keeper"}');
await new Promise((r) => setTimeout(r, 500));
const after = listRecentRuns(sbx.dataDir).length;
must("несуществующая роль отвергнута кодом 400", unknown.status === 400);
must("выключенная роль отвергнута кодом 409", off.status === 409);
must("отвергнутый запрос не оставляет строк Run", after === before);

// Обратная совместимость: маршрут появился раньше тела, пустой POST жив.
const empty = await post(null);
must("пустое тело по-прежнему принимается", empty.status === 202);

await gateway.stop();
sbx.cleanup();
finish();
