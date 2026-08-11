/**
 * tz-02 S6: каталог сцен целиком никто не сносит.
 *
 * `profile-sync.ts:151-155` делает `rm -rf` каталога и `rename` поверх — на
 * снимке это видно как «все файлы разом получили новый inode», даже когда
 * содержимое совпало байт в байт. При включённой консолидации этот путь
 * недостижим (inline-гейт), и правки идут только через apply, который трогает
 * ровно названные файлы.
 *
 * Меряем inode, а не содержимое: подмена каталога сохраняет байты и меняет
 * идентичность файлов — параллельный писатель после такой подмены пишет в
 * файл, которого больше нет в дереве.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=consolidation-off — гейт снят, L2-раннер идёт своей
 * дорогой и делает pull. Проба обязана показать ПОЛНУЮ подмену; если и там
 * inode целы, наблюдение слепое и первая половина ничего не доказала.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { ApplyExecutor } from "../../src/gateway/apply-executor.js";
import { createL2Runner } from "../../src/utils/pipeline-factory/l2-runner.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { Logger } from "../../src/core/types.js";

const OFF = process.env.FALSIFY === "consolidation-off";
const DIMS = 4;
const SLUG = "project-a";
const TOUCHED = "scene-a.md";
const UNTOUCHED = ["scene-b.md", "scene-c.md"];

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

const sbx = makeSandbox([]);
const dataDir = sbx.dataDir;
const blocksDir = path.join(dataDir, "scene_blocks", SLUG);
fs.mkdirSync(blocksDir, { recursive: true });
for (const name of [TOUCHED, ...UNTOUCHED]) {
  fs.writeFileSync(path.join(blocksDir, name), block(name, "original"));
}

const inodes = () =>
  Object.fromEntries(
    [TOUCHED, ...UNTOUCHED].map((n) => {
      const p = path.join(blocksDir, n);
      return [n, fs.existsSync(p) ? fs.statSync(p).ino : -1];
    }),
  );
const before = inodes();

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

// Тот самый путь, который сносит каталог. При включённой консолидации раннер
// обязан быть no-op'ом и не дойти до pull'а.
const pulled: string[] = [];
const store = {
  pullProfiles: async () => {
    pulled.push("pull");
    // Снимок «из облака»: те же имена, ДРУГИЕ файлы.
    return [TOUCHED, ...UNTOUCHED].map((name) => {
      const content = block(name, "из стора");
      return {
        id: `${SLUG}/${name}`,
        type: "l2" as const,
        filename: `${SLUG}/${name}`,
        content,
        contentMd5: createHash("md5").update(content).digest("hex"),
        version: 1,
        createdAtMs: 0,
      };
    });
  },
  isDegraded: () => false,
};
const l2 = createL2Runner({
  pluginDataDir: dataDir,
  cfg: { consolidation: { enabled: !OFF } } as never,
  openclawConfig: {},
  vectorStore: store as never,
  logger: logger as never,
});
try {
  await l2("session-1", undefined);
} catch (err) {
  // За pull'ом идёт настоящая экстракция сцен, которой в песочнице нечем
  // работать; для наблюдения важно только то, что уже случилось с каталогом.
  console.log(
    `  раннер упал после pull: ${(err as Error).message.slice(0, 60)}`,
  );
}
console.log(`pullProfiles вызван: ${pulled.length} раз(а)`);

// Настоящая правка одного блока — через apply, единственного писателя.
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
const vectorStore = new VectorStore(
  path.join(dataDir, "vectors.db"),
  DIMS,
  logger,
);
vectorStore.init();
const rel = `scene_blocks/${SLUG}/${TOUCHED}`;
const executor = new ApplyExecutor({
  dataDir,
  logger,
  vectorStore,
  embeddingService: embedding,
});
const res = await executor.apply({
  diff: { rewriteBlock: [{ path: rel, content: block(TOUCHED, "ПРАВКА") }] },
  manifest: {
    baseline: {
      [rel]: createHash("sha256")
        .update(fs.readFileSync(path.join(dataDir, rel)))
        .digest("hex"),
    },
  },
  context: { presentedRecordIds: [] },
});
console.log(`apply: ${res.status} ${res.error ?? ""}`);
vectorStore.close();

const after = inodes();
const survived = UNTOUCHED.every((n) => after[n] === before[n] && after[n] > 0);
console.log(`inode до:    ${JSON.stringify(before)}`);
console.log(`inode после: ${JSON.stringify(after)}`);
console.log(
  `изменились только применённые файлы: ${survived} (должно быть true)`,
);
console.log(`inode прочих сохранён: ${survived} (должно быть true)`);

sbx.cleanup();
