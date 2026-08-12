/**
 * tz-10a p3 — probe измеряет попадание чужого проекта, а не только precision.
 *
 * Probe звал recall БЕЗ `projectId` (tz-10 :21), поэтому чужая запись была для
 * него неотличима от своей: инвариант `project-recall-measurable` нечем было
 * проверить. Проба гоняет настоящий `runRecallProbe` над настоящим
 * `VectorStore` и корпусом с позитивом своего проекта и семантически близким
 * негативом чужого (S4).
 *
 * FALSIFY=drop-project — у запроса отбирается projectId (дофиксовое
 * поведение). Ожидаемый исход пиннится одним значением: `leakageRate === null`
 * — без проектного контекста запрос вообще не участвует в замере утечки.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { runRecallProbe } from "../../src/gateway/probe.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const OWN = "/repo/own";
const OTHER = "/repo/other";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz10a-p3-"));
const store = new VectorStore(path.join(dir, "vectors.db"), 8);
await store.init();

function record(id: string, content: string, projectId: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-12T00:00:00.000Z"],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    sessionKey: "probe",
    sessionId: "probe",
    projectId,
    scope: "project",
  } as MemoryRecord;
}

const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
await store.upsertL1(
  record("own-1", "деплой идёт через rsync без --delete", OWN),
  VEC,
);
await store.upsertL1(
  record("alien-1", "деплой идёт через kubectl rollout", OTHER),
  VEC,
);

// Корпус пишется на диск ровно там, откуда его читает продукт.
const corpusPath = path.join(dir, "probe-corpus.json");
fs.writeFileSync(
  corpusPath,
  JSON.stringify(
    {
      queries: [
        {
          id: "deploy",
          query: "деплой",
          expected: ["rsync"],
          ...(FALSIFY === "drop-project" ? {} : { projectId: OWN }),
          foreignExpected: ["kubectl"],
        },
      ],
    },
    null,
    2,
  ),
  "utf-8",
);

// `decay` — боевой режим: чужой проект не отсекается, а понижается, поэтому
// попадание в выдачу возможно и обязано быть измеримым.
const cfg = parseConfig({
  recall: {
    strategy: "keyword",
    maxResults: 5,
    scoreThreshold: 0,
    crossProject: "decay",
    crossProjectDecay: 0.5,
    defaultCrossProjectMultiplier: 0.3,
  },
  probe: { corpusPath: "probe-corpus.json", topK: 5 },
});

const fakeEmbedding: EmbeddingService = {
  embed: async () => VEC,
} as unknown as EmbeddingService;

const result = await runRecallProbe({
  dataDir: dir,
  cfg,
  vectorStore: store,
  embeddingService: fakeEmbedding,
});

console.log(
  `status=${result.status} precision@k=${result.precisionAtK} leakageRate=${result.leakageRate}`,
);
for (const q of result.evaluated) {
  console.log(
    `  запрос ${q.id} project=${q.projectId || "(нет)"} foreignHits=${q.foreignHits}`,
  );
  for (const i of q.items) {
    console.log(
      `    id=${i.memoryId} project=${i.projectId} raw=${i.raw.toExponential(3)} final=${i.final.toExponential(3)} reasons=${i.reasons.join("|")} relevant=${i.relevant} foreign=${i.foreign}`,
    );
  }
}

const leaked = result.evaluated[0]?.items.find((i) => i.foreign);

must(
  "утечка посчитана числом, а не осталась догадкой",
  typeof result.leakageRate === "number",
);
must(
  "чужая запись названа поимённо: id, проект и оба счёта",
  leaked !== undefined &&
    leaked.memoryId === "alien-1" &&
    leaked.projectId === OTHER &&
    leaked.final < leaked.raw &&
    leaked.reasons.some((r) => r.startsWith("decay:")),
);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
