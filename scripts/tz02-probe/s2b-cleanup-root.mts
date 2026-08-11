/**
 * tz-02 критерий 2, вторая половина: уборка (`server.ts:262`) метёт ТОТ ЖЕ
 * корень, который задан инстансу, а не свой собственный.
 *
 * Грепа тут мало: он зелёный при любой подстановке, включая неверную. Двух
 * хардкодов одного выражения ровно потому и не должно быть — разъехавшись, они
 * дают уборку, которая чистит пустоту, и scratch, который копится вечно.
 *
 * Проба поднимает ЖИВОЙ гейтвей (CleanupTimer.start() метёт сразу, cleanup.ts:282)
 * и кладёт по протухшему каталогу в ОБА корня — заданный конфигом и прежний
 * дефолтный.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=hardcoded-root — проба ожидает уборку в прежнем
 * дефолтном корне. `уборка вычистила заданный корень` обязано стать false.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { TdaiGateway } from "../../src/gateway/server.js";

const HARDCODED = process.env.FALSIFY === "hardcoded-root";
const PORT = 8796;
const THREE_DAYS_AGO = Date.now() - 3 * 24 * 3_600_000;

const sbx = makeSandbox([]);
process.env.HOME = sbx.home;

const configured = path.join(sbx.home, "configured-scratch");
const oldDefault = path.join(path.dirname(sbx.dataDir), "tdai-memory-keeper");

/** Протухшая директория прогона: то, что уборка и обязана сносить по возрасту. */
function plantStale(root: string): string {
  const dir = path.join(root, "run-stale");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), "{}", "utf-8");
  fs.utimesSync(dir, THREE_DAYS_AGO / 1000, THREE_DAYS_AGO / 1000);
  return dir;
}
const staleConfigured = plantStale(configured);
const staleOld = plantStale(oldDefault);

const cfgPath = path.join(sbx.home, "tdai-gateway.yaml");
fs.writeFileSync(
  cfgPath,
  [
    "server:",
    "  host: 127.0.0.1",
    `  port: ${PORT}`,
    "data:",
    `  baseDir: ${sbx.dataDir}`,
    `  scratchRoot: ${configured}`,
    "memory:",
    "  consolidation:",
    "    enabled: false",
    "  cleanup:",
    "    enabled: true",
    "    intervalHours: 1",
  ].join("\n"),
  "utf-8",
);
process.env.TDAI_GATEWAY_CONFIG = cfgPath;

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
const gateway = new TdaiGateway();
await gateway.start();
// Первый проход уборки запускается из start() и синхронен внутри run(), но
// идёт через промис — даём ему круг.
await new Promise((r) => setTimeout(r, 1000));
await gateway.stop();

const wanted = HARDCODED ? staleOld : staleConfigured;
const other = HARDCODED ? staleConfigured : staleOld;
console.log(`мели корень: ${path.dirname(wanted)}`);
console.log(
  `уборка вычистила заданный корень: ${!fs.existsSync(wanted)} (должно быть true)`,
);
console.log(
  `прежний дефолтный корень не тронут: ${fs.existsSync(other)} (должно быть true)`,
);

sbx.cleanup();
fs.rmSync(configured, { recursive: true, force: true });
