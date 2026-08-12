/**
 * tz-04 S3 live probe: the metric reacts to the scoring, on both strategies.
 *
 * A meter that does not move when the scoring moves is a constant. Before Ф6
 * that was literally true of `hybrid`: `searchHybrid` accepted `scoreThreshold`
 * and ignored it, so on the DEFAULT strategy no threshold sweep could ever
 * change a number. This probe drives the real pipeline over its own sandbox
 * store and demands a >15 pp drop from an absurd threshold on `embedding` AND
 * on `hybrid`.
 *
 * The corpus queries are deliberately NOT lexical matches of the stored text:
 * the similarity threshold governs the cosine leg, and the keyword leg must
 * keep working regardless (a BM25 hit is not a similarity). With FTS silent,
 * hybrid stands on the cosine leg alone — which is exactly where the threshold
 * has to be visible.
 *
 * FALSIFY=ignore-threshold — the absurd threshold is not passed to the config
 * (the pre-fix behaviour reproduced at the call site). Expected outcome,
 * pinned: no drop on either strategy.
 */
import { parseConfig } from "../../src/config.js";
import { runRecallProbe } from "../../src/gateway/probe.js";
import { must, finish } from "../tz07-probe/assert.mts";
import { makeCorpusStore, OWN } from "./corpus-store.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const ABSURD = 0.99;
/** tz-04 S3: below this the "sensitivity" is noise, not a signal. */
const MIN_DROP_PP = 15;

const sbx = await makeCorpusStore(
  "tz04-s3",
  [
    {
      id: "own-1",
      content: "деплой идёт через rsync без --delete",
      type: "instruction",
      projectId: OWN,
      vector: [0.6, 0.8],
    },
    {
      id: "own-2",
      content: "деплой прода делается вручную",
      type: "episodic",
      projectId: OWN,
      vector: [0.6, 0.8],
    },
  ],
  // The query points elsewhere: cosine ≈ 0.6 — comfortably above the live
  // threshold (0.2) and far below the absurd one.
  [1, 0],
);
sbx.writeCorpus([
  {
    id: "q1",
    query: "как раскатывается сервис",
    expected: ["rsync"],
    projectId: OWN,
    expectedRecordIds: ["own-1"],
    expectedType: "instruction",
    scopeRelation: "own",
    origin: "store-derived",
  },
  {
    id: "q2",
    query: "как выкатывают продакшн",
    expected: ["вручную"],
    projectId: OWN,
    expectedRecordIds: ["own-2"],
    expectedType: "episodic",
    scopeRelation: "own",
    origin: "store-derived",
  },
]);

async function recallAt10(
  strategy: "embedding" | "hybrid",
  threshold: number,
): Promise<number> {
  const cfg = parseConfig({
    recall: {
      strategy,
      maxResults: 10,
      scoreThreshold: threshold,
      crossProject: "decay",
    },
    probe: { corpusPath: "probe-corpus.json", topK: 10 },
  });
  const result = await runRecallProbe({
    dataDir: sbx.dir,
    cfg,
    vectorStore: sbx.store,
    embeddingService: sbx.embedding,
  });
  return result.metrics.recallAt10;
}

const strict = FALSIFY === "ignore-threshold" ? 0.2 : ABSURD;
const rows: Array<{
  strategy: "embedding" | "hybrid";
  base: number;
  cut: number;
}> = [];
for (const strategy of ["embedding", "hybrid"] as const) {
  rows.push({
    strategy,
    base: await recallAt10(strategy, 0.2),
    cut: await recallAt10(strategy, strict),
  });
}

console.log(`FALSIFY=${FALSIFY || "(нет)"} (порог отсечения=${strict})`);
for (const r of rows) {
  console.log(
    `  ${r.strategy.padEnd(10)} R@10: ${r.base.toFixed(3)} → ${r.cut.toFixed(3)} ` +
      `(Δ=${((r.cut - r.base) * 100).toFixed(1)}пп)`,
  );
}

for (const r of rows) {
  must(
    `${r.strategy}: абсурдный порог роняет метрику более чем на ${MIN_DROP_PP} пп`,
    (r.base - r.cut) * 100 > MIN_DROP_PP,
  );
}
must(
  "на живом пороге обе стратегии что-то находят — падение не с нуля",
  rows.every((r) => r.base > 0),
);

sbx.cleanup();
finish();
