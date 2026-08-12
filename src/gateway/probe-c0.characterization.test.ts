/**
 * tz-04 C0 — what the meter actually reacts to, pinned BEFORE the baseline.
 *
 * A metric is only worth taking once the levers behind it are known to move
 * the answer. Each lever gets its own case, and one of them pins a fact rather
 * than a wish: on the default `hybrid` strategy `scoreThreshold` changes
 * NOTHING — `searchHybrid` takes the threshold and never applies it. Tuning
 * that knob on the deployed default would have looked like "no effect from
 * scoring", which is a measurement artefact, not a property of recall. Ф6 of
 * this package changes that; until then this test states the truth.
 */
import { describe, it, expect } from "vitest";
import { parseConfig } from "../config.js";
import { searchMemoriesWithDetails } from "../core/hooks/auto-recall.js";
import { computeProbeResults, type ProbeCorpus } from "./probe.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { IMemoryStore, L1SearchResult } from "../core/store/types.js";

const OWN = "/repo/own";
const OTHER = "/repo/other";

function row(
  record_id: string,
  score: number,
  type: string,
  project_id: string,
): L1SearchResult {
  return {
    record_id,
    content: `note ${record_id}`,
    type,
    priority: 50,
    scene_name: "",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "s",
    session_id: "s",
    metadata_json: "{}",
    project_id,
    scope: "project",
  };
}

/**
 * A store that answers both legs with the same fixed rows and ignores the
 * store-side scope filter — the JS legs are what this test characterizes.
 */
function fixedStore(rows: L1SearchResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    searchL1Vector: async () => rows,
    searchL1Fts: async () => rows.map((r) => ({ ...r })),
    getCapabilities: () => ({ nativeHybridSearch: false }),
  } as unknown as IMemoryStore;
}

const fakeEmbedding: EmbeddingService = {
  embed: async () => new Float32Array(4),
} as unknown as EmbeddingService;

const ROWS = [
  row("instr-1", 0.6, "instruction", OWN),
  row("epis-1", 0.5, "episodic", OWN),
  row("foreign-1", 0.55, "episodic", OTHER),
];

/** Ranked record ids the pipeline returns for one config. */
async function ids(
  overrides: Record<string, unknown>,
  strategy: "keyword" | "embedding" | "hybrid",
  projectId = OWN,
): Promise<string[]> {
  const cfg = parseConfig({ recall: { strategy, ...overrides } });
  const result = await searchMemoriesWithDetails(
    "note",
    "/tmp",
    cfg,
    undefined,
    strategy,
    fixedStore(ROWS),
    fakeEmbedding,
    projectId,
  );
  return result.items.map((i) => i.memoryId);
}

describe("tz-04 C0: the levers the meter is supposed to react to", () => {
  it("scoreThreshold changes the answer on embedding", async () => {
    const loose = await ids(
      { scoreThreshold: 0, crossProject: "decay" },
      "embedding",
    );
    const strict = await ids(
      { scoreThreshold: 0.99, crossProject: "decay" },
      "embedding",
    );
    expect(loose.length).toBeGreaterThan(0);
    expect(strict).toEqual([]);
  });

  it("scoreThreshold does NOT change the answer on hybrid (pinned defect, fixed in Ф6)", async () => {
    const loose = await ids(
      { scoreThreshold: 0, crossProject: "decay" },
      "hybrid",
    );
    const strict = await ids(
      { scoreThreshold: 0.99, crossProject: "decay" },
      "hybrid",
    );
    expect(strict).toEqual(loose);
    expect(strict.length).toBeGreaterThan(0);
  });

  it("typeWeights change the order", async () => {
    const flat = await ids(
      {
        scoreThreshold: 0,
        crossProject: "decay",
        typeWeights: { instruction: 1, episodic: 1 },
      },
      "embedding",
    );
    const episodicFirst = await ids(
      {
        scoreThreshold: 0,
        crossProject: "decay",
        typeWeights: { instruction: 0.1, episodic: 2 },
      },
      "embedding",
    );
    expect(flat[0]).toBe("instr-1");
    expect(episodicFirst[0]).not.toBe("instr-1");
  });

  it("the query's projectId changes the answer (cross-project decay fires)", async () => {
    const asOwner = await ids(
      {
        scoreThreshold: 0,
        crossProject: "decay",
        crossProjectDecay: 0.5,
        defaultCrossProjectMultiplier: 0.1,
      },
      "embedding",
      OWN,
    );
    const asStranger = await ids(
      {
        scoreThreshold: 0,
        crossProject: "decay",
        crossProjectDecay: 0.5,
        defaultCrossProjectMultiplier: 0.1,
      },
      "embedding",
      OTHER,
    );
    // Same rows, different project context → different ranking. Without the
    // projectId reaching the pipeline these two would be identical.
    expect(asOwner).not.toEqual(asStranger);
    expect(asStranger[0]).toBe("foreign-1");
  });

  it("the probe hands the query's project down to the search", async () => {
    const seen: Array<{ query: string; projectId: string }> = [];
    const corpus: ProbeCorpus = {
      queries: [
        { id: "q1", query: "note", expected: ["note"], projectId: OWN },
      ],
    };
    await computeProbeResults(corpus, 10, async (query, projectId) => {
      seen.push({ query, projectId });
      return { items: [] };
    });
    expect(seen).toEqual([{ query: "note", projectId: OWN }]);
  });
});
