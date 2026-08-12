/**
 * tz-04 S1 live probe: the measurement is reproducible.
 *
 * A baseline you cannot re-take is a screenshot, not a measurement. Two runs
 * over the same store and the same corpus must print the same four numbers —
 * otherwise every "delta" in this package is noise.
 *
 * FALSIFY=jitter — a random tie-break is added to the score of every retrieved
 * item between the two runs (exactly what an unseeded RNG in ranking would
 * do). Expected outcome, pinned: the two runs disagree.
 */
import { parseConfig } from "../../src/config.js";
import { runRecallProbe, type ProbeMetrics } from "../../src/gateway/probe.js";
import { must, finish } from "../tz07-probe/assert.mts";
import { makeCorpusStore, OWN, OTHER } from "./corpus-store.mts";

const FALSIFY = process.env.FALSIFY ?? "";

const sbx = await makeCorpusStore("tz04-s1", [
  {
    id: "own-1",
    content: "деплой идёт через rsync без --delete",
    type: "instruction",
    projectId: OWN,
    vector: [1, 0],
  },
  {
    id: "own-2",
    content: "деплой прода делается вручную",
    type: "episodic",
    projectId: OWN,
    vector: [0.9, 0.1],
  },
  {
    id: "alien-1",
    content: "деплой идёт через kubectl rollout",
    type: "episodic",
    projectId: OTHER,
    vector: [0.8, 0.2],
  },
]);
sbx.writeCorpus([
  {
    id: "q1",
    query: "деплой",
    expected: ["rsync"],
    projectId: OWN,
    expectedRecordIds: ["own-1"],
    expectedType: "instruction",
    scopeRelation: "own",
    origin: "store-derived",
  },
  {
    id: "q2",
    query: "деплой прода",
    expected: ["вручную"],
    projectId: OWN,
    expectedRecordIds: ["own-2"],
    expectedType: "episodic",
    scopeRelation: "own",
    origin: "store-derived",
  },
]);

const cfg = parseConfig({
  recall: {
    strategy: "keyword",
    maxResults: 10,
    scoreThreshold: 0,
    crossProject: "decay",
  },
  probe: { corpusPath: "probe-corpus.json", topK: 10 },
});

async function measure(jitter: boolean): Promise<ProbeMetrics> {
  const result = await runRecallProbe({
    dataDir: sbx.dir,
    cfg,
    vectorStore: sbx.store,
    embeddingService: sbx.embedding,
    ...(jitter
      ? {
          // An unseeded tie-break inside ranking: same store, same corpus,
          // different order — and therefore different metrics.
          search: async (query: string, projectId: string) => {
            const { searchMemoriesWithDetails } =
              await import("../../src/core/hooks/auto-recall.js");
            const r = await searchMemoriesWithDetails(
              query,
              sbx.dir,
              cfg,
              undefined,
              "keyword",
              sbx.store,
              sbx.embedding,
              projectId,
            );
            return {
              items: [...r.items].sort(() => Math.random() - 0.5).slice(0, 1),
              diagnostics: r.diagnostics,
            };
          },
        }
      : {}),
  });
  return result.metrics;
}

const first = await measure(false);
const second = await measure(FALSIFY === "jitter");

const line = (m: ProbeMetrics): string =>
  `P@5=${m.precisionAt5.toFixed(3)} P@10=${m.precisionAt10.toFixed(3)} R@5=${m.recallAt5.toFixed(3)} R@10=${m.recallAt10.toFixed(3)}`;
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);
console.log(`  прогон 1: ${line(first)}`);
console.log(`  прогон 2: ${line(second)}`);

must(
  "два прогона на неизменном корпусе дают одинаковые числа",
  JSON.stringify(first) === JSON.stringify(second),
);
must("измеренное отличается от нуля — мерили не пустоту", first.recallAt10 > 0);

sbx.cleanup();
finish();
