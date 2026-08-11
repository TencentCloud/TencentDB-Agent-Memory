/**
 * tz-02 критерий 1d: запись индекса несёт дайджест байтов блока, и он сходится
 * с тем, что лежит на диске.
 *
 * До Ф2 запись состояла только из метаданных, РАЗОБРАННЫХ из файла, поэтому
 * «индекс согласован с блоками» проверить было нечем: индекс, собранный из
 * устаревшего снимка, выглядел ровно как свежий. Дайджест делает расхождение
 * наблюдаемым.
 *
 * Писателя два (живой `syncSceneIndex` ядра и запасной
 * `syncSceneIndexPerProject` гейтвея), поэтому проба гоняет ОБА: поле,
 * заполненное одним из них, ничего не гарантирует про второй.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=stale-digest — файл правят ПОСЛЕ пересборки. Дайджест
 * записи остаётся от прежних байтов, и совпадение обязано стать false; если
 * оно осталось true, проба не измеряет ничего.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import {
  syncSceneIndex,
  readSceneIndex,
} from "../../src/core/scene/scene-index.js";
import { syncSceneIndexPerProject } from "../../src/gateway/apply-executor/scene-index-fallback.js";
import type { ApplyExecutorDeps } from "../../src/gateway/apply-executor/apply-executor-deps.js";
import type { Logger } from "../../src/core/types.js";

const STALE = process.env.FALSIFY === "stale-digest";
const PROJECT = "/repo/alpha";
const FILE = "scene-a.md";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`  warn: ${m}`),
  error: () => undefined,
};

const block = (body: string) =>
  [
    "-----META-START-----",
    "created: 2026-08-01T00:00:00Z",
    "updated: 2026-08-01T00:00:00Z",
    `summary: ${FILE}`,
    "heat: 1",
    "-----META-END-----",
    "",
    body,
    "",
  ].join("\n");

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;

// Слаг на диске — то, во что превращается projectId; берём его из самого
// ядра, чтобы запасной писатель адресовал ТОТ ЖЕ каталог.
const { projectSlug } = await import("../../src/core/scene/scene-paths.js");
const slug = projectSlug(PROJECT);
const blocksDir = path.join(dataDir, "scene_blocks", slug);
fs.mkdirSync(blocksDir, { recursive: true });
const blockPath = path.join(blocksDir, FILE);
fs.writeFileSync(blockPath, block("original"));

const onDisk = () =>
  createHash("sha256")
    .update(fs.readFileSync(blockPath, "utf-8"))
    .digest("hex");

const indexPath = path.join(
  dataDir,
  ".metadata",
  "scene_index",
  `${slug}.json`,
);
const digestOf = () => {
  const entries = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Array<{
    filename: string;
    digest?: string;
  }>;
  return entries.find((e) => e.filename === FILE)?.digest ?? "";
};

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

// --- писатель 1: живой syncSceneIndex ядра ---------------------------------
await syncSceneIndex(dataDir, PROJECT);
if (STALE) fs.writeFileSync(blockPath, block("ПРАВКА-ПОСЛЕ-ИНДЕКСА-1"));
console.log(`живой писатель: дайджест записи ${digestOf().slice(0, 12)}…`);
console.log(
  `  дайджест записи совпал с содержимым файла: ${digestOf() === onDisk()} (должно быть true)`,
);

// Читатель отдаёт поле наружу, а не роняет его на белом списке.
const viaReader = (await readSceneIndex(dataDir, PROJECT)).find(
  (e) => e.filename === FILE,
);
console.log(
  `  читатель отдал дайджест: ${(viaReader?.digest ?? "") === digestOf()} (должно быть true)`,
);

// --- писатель 2: запасной writer гейтвея -----------------------------------
fs.writeFileSync(blockPath, block("ПРАВКА-2"));
const deps = { dataDir, logger: silent } as unknown as ApplyExecutorDeps;
await syncSceneIndexPerProject(deps, new Set([slug]));
if (STALE) fs.writeFileSync(blockPath, block("ПРАВКА-ПОСЛЕ-ИНДЕКСА-2"));
console.log(`запасной писатель: дайджест записи ${digestOf().slice(0, 12)}…`);
console.log(
  `  дайджест записи совпал с содержимым файла: ${digestOf() === onDisk()} (должно быть true)`,
);

sbx.cleanup();
