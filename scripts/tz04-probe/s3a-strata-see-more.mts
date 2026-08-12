/**
 * tz-04 S3a live probe: the strata see what the aggregate hides.
 *
 * Cross-project decay only touches foreign rows, so its effect on an aggregate
 * over the strata is diluted — a dead multiplier can look like "a small
 * change". Turning the multiplier off must move the foreign strata MORE than
 * the aggregate; that gap is the whole reason the report is split by stratum.
 *
 * The store is deliberately crowded with same-project neighbours: the
 * measurer's retrieval window is `max(probe.topK, METRIC_CUTOFF_MAX)`, so decay
 * changes a foreign row's RANK, and only a real queue of competitors turns that
 * rank into a missed answer. The scores come from the embedding leg, where the
 * probe controls every cosine exactly, instead of from BM25's tie-breaks.
 *
 * FALSIFY=flat-corpus — the corpus keeps only own-project pairs. Expected
 * outcome, pinned: no foreign stratum exists at all, so the comparison the
 * package relies on cannot even be formed.
 */
import { parseConfig } from "../../src/config.js";
import {
  runRecallProbe,
  type ProbeResult,
  type StratumKey,
} from "../../src/gateway/probe.js";
import { must, finish } from "../tz07-probe/assert.mts";
import { makeCorpusStore, OWN, OTHER, type Seed } from "./corpus-store.mts";
import type { ProbeQuery } from "../../src/gateway/probe.js";

const FALSIFY = process.env.FALSIFY ?? "";

/** A unit vector whose cosine against the query vector [1,0,…] is exactly `c`. */
const atCosine = (c: number): number[] => [c, Math.sqrt(1 - c * c)];

/** Same-project neighbours: the queue a decayed foreign row has to sink below. */
const neighbours: Seed[] = Array.from({ length: 10 }, (_, i) => ({
  id: `own-near-${i}`,
  content: `деплой заметка ${i}`,
  type: "episodic" as const,
  projectId: OWN,
  vector: atCosine(0.7),
}));

const sbx = await makeCorpusStore("tz04-s3a", [
  {
    id: "own-1",
    content: "деплой идёт через rsync без --delete",
    type: "instruction",
    projectId: OWN,
    vector: atCosine(0.95),
  },
  {
    id: "own-2",
    content: "деплой прода делается вручную",
    type: "episodic",
    projectId: OWN,
    vector: atCosine(0.95),
  },
  // The foreign rows are the CLOSEST match of all: without decay they lead the
  // answer, so anything that pushes them out is the multiplier and nothing else.
  {
    id: "alien-1",
    content: "деплой идёт через kubectl rollout",
    type: "instruction",
    projectId: OTHER,
    vector: atCosine(1),
  },
  {
    id: "alien-2",
    content: "деплой прода через helm upgrade",
    type: "episodic",
    projectId: OTHER,
    vector: atCosine(1),
  },
  ...neighbours,
]);

const ownPairs: ProbeQuery[] = [
  {
    id: "own-instr",
    query: "деплой",
    expected: ["rsync"],
    projectId: OWN,
    expectedRecordIds: ["own-1"],
    expectedType: "instruction",
    scopeRelation: "own",
    origin: "store-derived",
  },
  {
    id: "own-epis",
    query: "деплой прода",
    expected: ["вручную"],
    projectId: OWN,
    expectedRecordIds: ["own-2"],
    expectedType: "episodic",
    scopeRelation: "own",
    origin: "store-derived",
  },
];
// A foreign pair asks from OWN but expects the answer that lives in OTHER —
// exactly the case a cross-project multiplier is supposed to push down.
const foreignPairs: ProbeQuery[] = [
  {
    id: "foreign-instr",
    query: "деплой",
    expected: ["kubectl"],
    projectId: OWN,
    expectedRecordIds: ["alien-1"],
    expectedType: "instruction",
    scopeRelation: "foreign",
    origin: "store-derived",
  },
  {
    id: "foreign-epis",
    query: "деплой прода",
    expected: ["helm"],
    projectId: OWN,
    expectedRecordIds: ["alien-2"],
    expectedType: "episodic",
    scopeRelation: "foreign",
    origin: "store-derived",
  },
];
sbx.writeCorpus(
  FALSIFY === "flat-corpus" ? ownPairs : [...ownPairs, ...foreignPairs],
);

/**
 * `defaultCrossProjectMultiplier` is the floor under the prefix-depth decay:
 * at 1.0 the floor swallows the decay (foreign rows keep their score), at 0.1
 * the prefix-depth value (0.5 for these two paths) is what bites.
 */
async function measure(multiplier: number): Promise<ProbeResult> {
  const cfg = parseConfig({
    recall: {
      strategy: "embedding",
      maxResults: 10,
      scoreThreshold: 0,
      crossProject: "decay",
      crossProjectDecay: 0.5,
      defaultCrossProjectMultiplier: multiplier,
    },
    probe: { corpusPath: "probe-corpus.json", topK: 10 },
  });
  return runRecallProbe({
    dataDir: sbx.dir,
    cfg,
    vectorStore: sbx.store,
    embeddingService: sbx.embedding,
  });
}

const mean = (r: ProbeResult, keys: StratumKey[]): number => {
  const present = keys.filter((k) => r.strata[k]);
  return present.length === 0
    ? 0
    : present.reduce((sum, k) => sum + r.strata[k]!.recallAt10, 0) /
        present.length;
};
const FOREIGN: StratumKey[] = ["instruction/foreign", "episodic/foreign"];

const off = await measure(1); // decay effectively disabled
const on = await measure(0.1); // decay biting

const foreignDrop = (mean(off, FOREIGN) - mean(on, FOREIGN)) * 100;
const aggregateDrop = (off.metrics.recallAt10 - on.metrics.recallAt10) * 100;

console.log(`FALSIFY=${FALSIFY || "(нет)"}`);
console.log(
  `  множитель 1.0: агрегат R@10=${off.metrics.recallAt10.toFixed(3)} foreign=${mean(off, FOREIGN).toFixed(3)} страт=${Object.keys(off.strata).length}`,
);
console.log(
  `  множитель 0.1: агрегат R@10=${on.metrics.recallAt10.toFixed(3)} foreign=${mean(on, FOREIGN).toFixed(3)} страт=${Object.keys(on.strata).length}`,
);
console.log(
  `  падение: страта foreign ${foreignDrop.toFixed(1)}пп, агрегат ${aggregateDrop.toFixed(1)}пп`,
);

must(
  "разрез по стратам вообще существует: страта foreign есть в отчёте",
  FOREIGN.every((k) => on.strata[k] !== undefined),
);
must(
  "отключение decay видно на страте foreign сильнее, чем на агрегате",
  foreignDrop > aggregateDrop && foreignDrop > 0,
);

sbx.cleanup();
finish();
