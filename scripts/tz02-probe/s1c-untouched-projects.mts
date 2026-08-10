/**
 * tz-02 критерий 1c / S6-подмножество: apply, тронувший ОДИН слаг, не
 * переписывает индексы прочих проектов.
 *
 * До Ф1 пересборка шла по всем слагам сразу (`syncSceneIndexAllProjects`),
 * поэтому persona-only apply бампал mtime индекса проекта, которого он не
 * касался, — а любой параллельный писатель того проекта терял свою запись на
 * этом круге.
 *
 * Мерим mtime и inode: содержимое может совпасть байт в байт, и тогда только
 * они и покажут, что файл переписали.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=sync-all — пересобрать оба слага, как до Ф1.
 * Индекс нетронутого проекта обязан поехать.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { syncSceneIndex } from "../../src/gateway/apply-executor/apply-route.js";
import type { ApplyExecutorDeps } from "../../src/gateway/apply-executor/apply-executor-deps.js";
import type { Logger } from "../../src/core/types.js";

const SYNC_ALL = process.env.FALSIFY === "sync-all";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`  warn: ${m}`),
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
const blocks = path.join(dataDir, "scene_blocks");
for (const slug of ["project-a", "project-b"]) {
  fs.mkdirSync(path.join(blocks, slug), { recursive: true });
  fs.writeFileSync(
    path.join(blocks, slug, "scene-1.md"),
    `# scene\n\n${slug}\n`,
  );
}
const deps = { dataDir, logger: silent } as unknown as ApplyExecutorDeps;

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
await syncSceneIndex(deps, new Set(["project-a", "project-b"]));

const indexB = path.join(dataDir, ".metadata", "scene_index", "project-b.json");
const before = fs.statSync(indexB);

// Правим ТОЛЬКО project-a и пересобираем то, что назвал бы дифф.
fs.writeFileSync(
  path.join(blocks, "project-a", "scene-1.md"),
  "# scene\n\nchanged\n",
);
await new Promise((r) => setTimeout(r, 20));
await syncSceneIndex(
  deps,
  SYNC_ALL ? new Set(["project-a", "project-b"]) : new Set(["project-a"]),
);

const after = fs.statSync(indexB);
const untouched = after.mtimeMs === before.mtimeMs && after.ino === before.ino;
console.log(
  `индекс project-b: mtime ${before.mtimeMs} → ${after.mtimeMs}, ` +
    `inode ${before.ino} → ${after.ino}`,
);
console.log(
  `индексы прочих проектов не переписаны: ${untouched} (должно быть true)`,
);

const indexA = path.join(dataDir, ".metadata", "scene_index", "project-a.json");
console.log(
  `индекс тронутого проекта пересобран: ` +
    `${fs.readFileSync(indexA, "utf-8").includes("scene-1.md")} (должно быть true)`,
);

sbx.cleanup();
