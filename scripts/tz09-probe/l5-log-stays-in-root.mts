/**
 * tz-log Ф6 — gateway с НАЗВАННЫМ корнем пишет лог только под свой корень.
 *
 * Живой дефект: `./tdai-gateway.yaml` в репозитории задаёт
 * `logging.file: ~/.pi/agent-memory/tdai/logs/gateway-dev.log`, а cwd-конфиг
 * читает ЛЮБОЙ процесс, запущенный из этого каталога. Поэтому каждый прогон
 * тестов и проб дописывал свои строки в БОЕВОЙ лог оператора: замерено —
 * `npx vitest run src/gateway/capture-floor.test.ts` добавлял ~11 КБ и 324
 * строки про /tmp-песочницы. Файл, по которому читают прогон, наполнялся
 * чужими деревьями — ровно то гадание, ради конца которого лог и метили.
 *
 * Проба: настоящий gateway в песочнице, конфиг с чужим абсолютным лог-файлом.
 * Ни одной строки в чужом файле, все строки — под корнем песочницы.
 *
 * FALSIFY=leak — собирает логгер так, как это делал server.ts до фикса
 * (logFile прямо из конфига): чужой файл наполняется, обе ноги ложны.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSandbox } from "./sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";
import { createDevLogger, flushLogs } from "../../src/utils/dev-logger.js";
import { must, finish } from "../tz07-probe/assert.mts";

const PORT = 8799;
const LEAK = process.env.FALSIFY === "leak";

const sbx = makeSandbox([]);
process.env.HOME = sbx.home;

/** «Чужое дерево» — на живом инстансе это был боевой лог оператора. */
const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "tz-log-foreign-"));
const foreignLog = path.join(foreignDir, "gateway-dev.log");

const cfgPath = path.join(sbx.home, "tdai-gateway.yaml");
fs.writeFileSync(
  cfgPath,
  [
    "server:",
    "  host: 127.0.0.1",
    `  port: ${PORT}`,
    "data:",
    `  baseDir: ${sbx.dataDir}`,
    "logging:",
    `  file: ${foreignLog}`,
    "  level: debug",
  ].join("\n"),
  "utf-8",
);
process.env.TDAI_GATEWAY_CONFIG = cfgPath;

if (LEAK) {
  // Дофиксовая обвязка: logFile берётся из конфига как есть, корень не спросили.
  const logger = createDevLogger({
    tag: "[tdai-gateway]",
    logFile: foreignLog,
  });
  logger.info("Gateway listening on http://127.0.0.1:0");
  await flushLogs();
} else {
  const gateway = new TdaiGateway();
  await gateway.start();
  await gateway.stop();
  await flushLogs();
}

const foreign = fs.existsSync(foreignLog)
  ? fs.readFileSync(foreignLog, "utf-8")
  : "";
const ownLog = path.join(sbx.dataDir, "logs", "gateway-dev.log");
const own = fs.existsSync(ownLog) ? fs.readFileSync(ownLog, "utf-8") : "";
console.log(
  `чужой файл: ${foreign.length} байт, свой (${ownLog}): ${own.length} байт`,
);

must("gateway с названным корнем не пишет в чужой лог-файл", foreign === "");
must(
  "его строки лежат под собственным корнем",
  own.includes("Gateway listening"),
);

fs.rmSync(foreignDir, { recursive: true, force: true });
sbx.cleanup();
finish();
