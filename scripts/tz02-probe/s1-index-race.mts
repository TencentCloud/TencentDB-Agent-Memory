/**
 * tz-02 критерий 1a (S1a): два прогона правят РАЗНЫЕ файлы одного слага —
 * в итоговом индексе присутствуют обе правки.
 *
 * Замок на путь файла этого не ловит: файлы разные, гонка идёт за общий
 * индекс слага, который пишется позже и без атомарной подмены. Пересборка не
 * атомарна сама по себе (сначала readdir+чтение, потом запись), поэтому
 * пересборка, НАЧАВШАЯСЯ до чужой правки и ЗАКОНЧИВШАЯСЯ после неё,
 * возвращает индекс к снимку, снятому до первой правки.
 *
 * Ф1 убирает эту возможность тем, что пересборка идёт ВНУТРИ
 * `withStoreApplyLock`: чужая правка не может встать между снимком и записью.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=sync-outside-lock — проба сама воспроизводит
 * ДО-Ф1-порядок: снимает состояние каталога до второй правки и записывает
 * индекс из этого снимка после неё. Вторая правка обязана пропасть из
 * индекса, иначе наблюдение ничего не измеряет.
 */
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import { parseSceneBlock } from "../../src/core/scene/scene-format.js";
import { createHash } from "node:crypto";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const OUTSIDE = process.env.FALSIFY === "sync-outside-lock";
const DIMS = 4;
const SLUG = "project-a";

const v = new Float32Array(DIMS);
v[1] = 1;
const embedding: EmbeddingService = {
  embed: async () => v,
  embedBatch: async (ts: string[]) => ts.map(() => v),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.log(`  warn: ${m}`),
  error: () => undefined,
};

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
const blocksDir = path.join(dataDir, "scene_blocks", SLUG);
fs.mkdirSync(blocksDir, { recursive: true });
/** Формат, который требует валидатор apply (limits.ts META_START/END). */
const block = (name: string, body: string) =>
  [
    "-----META-START-----",
    "created: 2026-08-01T00:00:00Z",
    "updated: 2026-08-01T00:00:00Z",
    `summary: ${name}`,
    "heat: 1",
    "-----META-END-----",
    "",
    body,
    "",
  ].join("\n");
for (const name of ["scene-a.md", "scene-b.md"]) {
  fs.writeFileSync(path.join(blocksDir, name), block(name, "original"));
}

const store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
store.init();
const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore: store,
  embeddingService: embedding,
});

/** Baseline «как при спавне»: apply правит только то, что роль видела. */
const sha = (rel: string) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(dataDir, rel)))
    .digest("hex");

const rewrite = (name: string, body: string) => {
  const rel = `scene_blocks/${SLUG}/${name}`;
  return executor.apply({
    diff: { rewriteBlock: [{ path: rel, content: block(name, body) }] },
    manifest: { baseline: { [rel]: sha(rel) } },
    context: { presentedRecordIds: [] },
  });
};

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

// Снимок каталога ДО второй правки — материал для «пересборки, начавшейся
// раньше»: ровно то, что делала пересборка вне лока.
const staleSnapshot = fs
  .readdirSync(blocksDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const meta = parseSceneBlock(
      fs.readFileSync(path.join(blocksDir, f), "utf-8"),
      f,
    ).meta;
    return {
      filename: f,
      summary: meta.summary,
      heat: meta.heat,
      created: meta.created,
      updated: meta.updated,
    };
  })
  .filter((e) => e.filename !== "scene-b.md");

const [r1, r2] = await Promise.all([
  rewrite("scene-a.md", "ПРАВКА-A"),
  rewrite("scene-b.md", "ПРАВКА-B"),
]);
console.log(
  `apply A: ${r1.status} ${r1.error ?? ""}, apply B: ${r2.status} ${r2.error ?? ""}`,
);

const indexPath = path.join(
  dataDir,
  ".metadata",
  "scene_index",
  `${SLUG}.json`,
);
if (OUTSIDE) {
  // Пересборка, снявшая снимок до правки B и дописавшая его после неё.
  fs.writeFileSync(indexPath, JSON.stringify(staleSnapshot, null, 2), "utf-8");
}

const entries = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Array<{
  filename: string;
}>;
const names = entries.map((e) => e.filename).sort();
console.log(`записи индекса: ${JSON.stringify(names)}`);
console.log(
  `в индексе обе правки: ` +
    `${names.includes("scene-a.md") && names.includes("scene-b.md")} ` +
    `(должно быть true)`,
);
for (const name of ["scene-a.md", "scene-b.md"]) {
  const body = fs.readFileSync(path.join(blocksDir, name), "utf-8");
  console.log(
    `  файл ${name} на диске: ${body.includes("ПРАВКА") ? "правлен" : "исходный"}`,
  );
}

store.close();
sbx.cleanup();
