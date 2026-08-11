/**
 * tz-05 e2 — цепочка provenance через НАСТОЯЩИЙ путь записи.
 *
 * Три последовательные записи одного и того же содержимого идут через
 * `writeMemory` (`l1-writer.ts`) — тот же вызов, которым пишет продукт, — и
 * цепочка обязана нарастать, а не переписываться. Потом сверх лимита: 23 шага
 * должны сложиться в 20 записей, где первая — видимый маркер схлопывания.
 *
 * Последняя нога — путь apply: перестройка индекса сцен после мутации обязана
 * сохранить цепочку L2, а не пересобрать её из front-matter (front-matter лежит
 * внутри песочницы LLM и переписывается моделью).
 *
 * Режимы фальсификации:
 *   FALSIFY=replace-metadata — вызывающий не передаёт `previousMetadata`, ровно
 *     как до Ф2. Цепочка перестаёт расти, и нога про три шага краснеет: это и
 *     есть тот баг, ради которого Ф2 меняла всех троих вызывающих одним диффом.
 *   FALSIFY=apply-trusts-front-matter — вместо настоящей перестройки берётся
 *     копия старого цикла из `scene-index-fallback.ts`, читавшая scope и
 *     provenance из блока. Нога про apply краснеет.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore, buildFtsQuery } from "../../src/core/store/sqlite.js";
import { writeMemory } from "../../src/core/record/l1-writer.js";
import {
  MAX_CHAIN,
  PROVENANCE_KEY,
  readProvenance,
  type Provenance,
} from "../../src/core/record/provenance.js";
import {
  blockDigest,
  readSceneIndexBySlug,
  syncSceneIndexBySlug,
  writeCarrierAttributes,
} from "../../src/core/scene/scene-index.js";
import { parseSceneBlock } from "../../src/core/scene/scene-format.js";
import { syncSceneIndexPerProject } from "../../src/gateway/apply-executor/scene-index-fallback.js";
import type { ApplyExecutorDeps } from "../../src/gateway/apply-executor/apply-executor-deps.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e2-"));
const store = new VectorStore(path.join(dir, "vectors.db"), 8);
await store.init();

const CONTENT = "релиз выкатывается через две стадии";

/** Идентификатор записи, которую переписывает следующий шаг. */
let lastId: string | undefined;

/** Один проход записи. Возвращает цепочку, какой она стала в сторе. */
async function step(
  role: string,
  action: string,
): Promise<Provenance | undefined> {
  const previous = await current();
  const record = await writeMemory({
    memory: {
      content: CONTENT,
      type: "instruction",
      priority: 50,
      scene_name: "release",
      source_message_ids: [],
      metadata: {},
    },
    // Первый шаг — store, дальше update поверх той же записи: именно так
    // выглядит обычный near-dup, на котором цепочка и терялась до Ф2.
    decision: lastId
      ? { record_id: lastId, action: "update", target_ids: [lastId] }
      : { record_id: "", action: "store", target_ids: [] },
    // Фальсификация: путь записи не знает, что было раньше, и кладёт
    // metadata целиком поверх — цепочка теряется на каждом шаге.
    ...(FALSIFY === "replace-metadata"
      ? {}
      : {
          previousMetadata: previous
            ? { [PROVENANCE_KEY]: previous }
            : undefined,
        }),
    provenance: { role, action, source: "role-run" },
    baseDir: dir,
    sessionKey: "probe",
    sessionId: "probe",
    projectId: "/repo/own",
    vectorStore: store,
  });
  lastId = record?.id ?? lastId;
  return current();
}

/** Цепочка записи, как её видит стор. */
async function current(): Promise<Provenance | undefined> {
  if (!lastId) return undefined;
  // Запрос собирается тем же `buildFtsQuery`, что и в продукте: сторона
  // записи сегментирует текст через jieba, и сырое слово мимо этой функции
  // в индекс не попадает.
  const hits = await store.searchL1Fts(
    buildFtsQuery("выкатывается") ?? "",
    50,
    "",
    "decay",
  );
  const hit = hits.find((h) => h.record_id === lastId);
  if (!hit) return undefined;
  const metadata = JSON.parse(hit.metadata_json || "{}") as Record<
    string,
    unknown
  >;
  return readProvenance(metadata);
}

await step("extractor", "store");
await step("keeper", "merge");
const three = await step("critic", "review");
console.log(`  цепочка после трёх шагов: ${JSON.stringify(three?.chain)}`);

must("цепочка после трёх записей содержит три шага", three?.chain.length === 3);
must(
  "источник записи сохранился от первого шага",
  three?.source === "role-run",
);
must(
  "роли идут в порядке записи",
  JSON.stringify(
    (three?.chain ?? []).map((s) => (s as { role?: string }).role),
  ) === JSON.stringify(["extractor", "keeper", "critic"]),
);

for (let i = 3; i < MAX_CHAIN + 3; i += 1) await step(`role-${i}`, "update");
const overflow = await current();
const first = overflow?.chain[0] as {
  collapsed?: number;
  from?: string;
  to?: string;
};
console.log(
  `  после ${MAX_CHAIN + 3} шагов: длина ${overflow?.chain.length}, первая запись ${JSON.stringify(first)}`,
);

must(
  `цепочка не длиннее лимита ${MAX_CHAIN}`,
  overflow?.chain.length === MAX_CHAIN,
);
must(
  "схлопывание видно: первая запись — маркер, а не потерянные шаги",
  first?.collapsed === MAX_CHAIN + 3 - (MAX_CHAIN - 1),
);
must(
  "маркер ровно один — второго не появляется",
  (overflow?.chain ?? []).filter((s) => "collapsed" in (s as object)).length ===
    1,
);

// --- Нога L2: перестройка индекса на пути apply -------------------------
// Мутация через apply трогает блоки сцен и перестраивает индекс проекта. Если
// перестройка верит front-matter, обычный apply стирает цепочку каждого блока,
// у которого копии в front-matter нет, а модель может переписать себе проект,
// отредактировав собственный файл.
const SLUG = "repo-alpha-1234abcd";
const blocksDir = path.join(dir, "scene_blocks", SLUG);
fs.mkdirSync(blocksDir, { recursive: true });

function writeBlock(front: string[]): void {
  fs.writeFileSync(
    path.join(blocksDir, "deploy.md"),
    [
      "-----META-START-----",
      "created: 2026-08-01T00:00:00Z",
      "updated: 2026-08-01T00:00:00Z",
      "summary: deploy notes",
      "heat: 2",
      ...front,
      "-----META-END-----",
      "",
      "body",
      "",
    ].join("\n"),
    "utf-8",
  );
}

const TRUE_CHAIN: Provenance = {
  source: "role-run",
  createdAt: "2026-08-01T00:00:00.000Z",
  chain: [
    { role: "scene-extract", action: "update", at: "2026-08-01T00:00:00.000Z" },
  ],
};

writeBlock([]);
await syncSceneIndexBySlug(dir, SLUG);
await writeCarrierAttributes(
  dir,
  SLUG,
  new Map([
    [
      "deploy.md",
      {
        scope: "project",
        project_id: "/repo/alpha",
        provenance: TRUE_CHAIN,
      },
    ],
  ]),
);

// Модель переписывает свой блок: чужой проект и цепочка, утверждающая, что
// файл написал человек. Форма корректная — одной валидацией не поймать.
writeBlock([
  "scope: global",
  "project_id: /repo/EVIL",
  `provenance: ${JSON.stringify({
    source: "manual",
    createdAt: "2000-01-01T00:00:00.000Z",
    chain: [
      { role: "human", action: "authored", at: "2000-01-01T00:00:00.000Z" },
    ],
  })}`,
]);

/** Копия цикла, который жил в scene-index-fallback.ts до Ф5. */
async function rebuildTrustingFrontMatter(): Promise<void> {
  const raw = fs.readFileSync(path.join(blocksDir, "deploy.md"), "utf-8");
  const block = parseSceneBlock(raw, "deploy.md");
  const indexPath = path.join(dir, ".metadata", "scene_index", `${SLUG}.json`);
  fs.writeFileSync(
    indexPath,
    JSON.stringify(
      [
        {
          filename: "deploy.md",
          summary: block.meta.summary,
          heat: block.meta.heat,
          created: block.meta.created,
          updated: block.meta.updated,
          digest: blockDigest(raw),
          scope: block.meta.scope ?? "",
          project_id: block.meta.project_id ?? "",
          ...(block.meta.provenance
            ? { provenance: block.meta.provenance }
            : {}),
        },
      ],
      null,
      2,
    ),
    "utf-8",
  );
}

if (FALSIFY === "apply-trusts-front-matter") await rebuildTrustingFrontMatter();
else
  await syncSceneIndexPerProject(
    { dataDir: dir } as unknown as ApplyExecutorDeps,
    new Set([SLUG]),
  );

const entry = (await readSceneIndexBySlug(dir, SLUG))[0];
console.log(
  `  индекс после apply: scope=${entry?.scope} project_id=${entry?.project_id} chain=${JSON.stringify(entry?.provenance?.chain)}`,
);
must(
  "перестройка индекса на пути apply сохранила настоящую цепочку L2",
  JSON.stringify(entry?.provenance) === JSON.stringify(TRUE_CHAIN),
);
must(
  "и подделанные в front-matter scope/project_id не доехали до индекса",
  entry?.scope === "project" && entry?.project_id === "/repo/alpha",
);
must(
  "при этом содержимое, которым блок владеет по праву, всё ещё едет",
  entry?.summary === "deploy notes",
);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
