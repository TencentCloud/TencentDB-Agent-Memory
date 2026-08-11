/**
 * L1 near-dup deterministic dedup tests.
 *
 * Verifies that a restated task description (near-identical wording, same
 * type) is forced to "update" against the existing record instead of being
 * stored as a new row — the anti-"капы" guard. Runs against a REAL VectorStore
 * on a scratch dir. Embedding fake is word-count based (not length-one-hot),
 * so two restatements with overlapping vocabulary land above NEAR_DUP_SCORE
 * while genuinely different texts stay below — the test proves the threshold
 * semantics, not the fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VectorStore } from "../store/sqlite.js";
import type { EmbeddingService, Logger } from "../types.js";
import { batchDedup, NEAR_DUP_SCORE } from "./l1-dedup.js";
import type { ExtractedMemory, MemoryRecord } from "./l1-writer.js";
import { applyDecisions } from "./l1-extraction-store.js";
import { PROVENANCE_KEY, readProvenance } from "./provenance.js";

const DIMS = 64;

/** Deterministic word-count embedding: hash word → dim, then L2-normalize. */
function embedText(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (const w of text.toLowerCase().split(/\s+/)) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % DIMS] += 1;
  }
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += a[i] * b[i];
  return s;
}

const fakeEmbedding: EmbeddingService = {
  embed: async (text: string) => embedText(text),
  embedBatch: async (texts: string[]) => texts.map((t) => embedText(t)),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function newMem(
  id: string,
  content: string,
  type = "episodic",
): ExtractedMemory & { record_id: string } {
  return {
    record_id: id,
    content,
    type: type as ExtractedMemory["type"],
    priority: 70,
    scene_name: "test-scene",
    source_message_ids: ["s1"],
    metadata: {},
    scope: "project",
  };
}

function existingRecord(
  id: string,
  content: string,
  type = "episodic",
): MemoryRecord {
  return {
    id,
    content,
    type: type as MemoryRecord["type"],
    priority: 70,
    scene_name: "test-scene",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-02T10:00:00Z"],
    createdAt: "2026-08-02T10:00:00Z",
    updatedAt: "2026-08-02T10:00:00Z",
    sessionKey: "test",
    sessionId: "test",
    projectId: "/home/penis/projects/base-extention",
    scope: "project",
  };
}

const PROJECT = "/home/penis/projects/base-extention";

// Two restatements of the same task state — only the iteration number differs.
const EXISTING_TEXT =
  "Пользователь 2026-08-02 продолжил разработку проекта base-extention transport-category завершил планирование итерации 5";
const RESTATED_TEXT =
  "Пользователь 2026-08-02 продолжил разработку проекта base-extention transport-category завершил планирование итерации 6";

// A genuinely different text (different project, different topic).
const DIFFERENT_TEXT =
  "Пользователь настроил деплой сайта portfolio на сервер nginx через docker compose";

// A third text unrelated to both EXISTING_TEXT and DIFFERENT_TEXT.
const UNRELATED_TEXT =
  "Пользователь вечером смотрел кино про космос и пил зелёный чай";

describe("l1 near-dup deterministic dedup", () => {
  let tmp: string;
  let store: VectorStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l1-dedup-"));
    store = new VectorStore(path.join(tmp, "vectors.db"), DIMS, silentLogger);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("restated task (overlapping vocab, same type) is forced to update, not stored", async () => {
    await store.upsertL1(
      existingRecord("m_existing", EXISTING_TEXT),
      embedText(EXISTING_TEXT),
    );

    // Sanity: the restatement is near-identical but NOT byte-identical.
    expect(RESTATED_TEXT).not.toBe(EXISTING_TEXT);
    // And the cosine between the two word-bag vectors is above the threshold.
    expect(
      cosine(embedText(EXISTING_TEXT), embedText(RESTATED_TEXT)),
    ).toBeGreaterThanOrEqual(NEAR_DUP_SCORE);

    const { decisions } = await batchDedup({
      memories: [newMem("m_new", RESTATED_TEXT)],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      projectId: PROJECT,
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("update");
    expect(decisions[0].target_ids).toEqual(["m_existing"]);
  });

  it("different text (low cosine) stays store", async () => {
    await store.upsertL1(
      existingRecord("m_existing2", EXISTING_TEXT),
      embedText(EXISTING_TEXT),
    );

    expect(
      cosine(embedText(EXISTING_TEXT), embedText(DIFFERENT_TEXT)),
    ).toBeLessThan(NEAR_DUP_SCORE);

    const { decisions } = await batchDedup({
      memories: [newMem("m_new2", DIFFERENT_TEXT)],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      projectId: PROJECT,
    });

    expect(decisions).toHaveLength(1);
    // Low cosine → no forced update → LLM path; with no llmRunner the
    // CleanContextRunner path fails and safely falls back to store.
    expect(decisions[0].action).toBe("store");
  });

  it("same text but different type is NOT forced (type must match)", async () => {
    await store.upsertL1(
      existingRecord("m_existing3", EXISTING_TEXT, "persona"),
      embedText(EXISTING_TEXT),
    );

    const { decisions } = await batchDedup({
      memories: [newMem("m_new3", RESTATED_TEXT)],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      projectId: PROJECT,
    });

    // type mismatch → not forced; falls to LLM path → safe fallback store
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("store");
  });

  it("mixed batch: one forced near-dup + one non-dup → both decided correctly", async () => {
    await store.upsertL1(
      existingRecord("m_existing4", EXISTING_TEXT),
      embedText(EXISTING_TEXT),
    );
    await store.upsertL1(
      existingRecord("m_existing5", DIFFERENT_TEXT),
      embedText(DIFFERENT_TEXT),
    );

    const { decisions } = await batchDedup({
      memories: [
        newMem("m_new4", RESTATED_TEXT), // near-dup of m_existing4 → forced update
        newMem("m_new5", UNRELATED_TEXT), // unrelated to both existing → store
      ],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      projectId: PROJECT,
    });

    expect(decisions).toHaveLength(2);
    const byId = new Map(decisions.map((d) => [d.record_id, d]));
    expect(byId.get("m_new4")?.action).toBe("update");
    expect(byId.get("m_new4")?.target_ids).toEqual(["m_existing4"]);
    expect(byId.get("m_new5")?.action).toBe("store");
  });

  it("NEAR_DUP_SCORE constant is exported and >= 0.85", () => {
    expect(NEAR_DUP_SCORE).toBeGreaterThanOrEqual(0.85);
  });
});

/**
 * tz-05 Ф2 (критерии 3a, 3b): the provenance chain has to survive the ORDINARY
 * path — a near-dup update from a normal extraction — not just the rare apply.
 * The vector recall leg is the one that used to drop it: it built candidates
 * with `metadata: {}` while the FTS leg parsed `metadata_json`.
 */
describe("provenance survives a near-dup update", () => {
  let tmp: string;
  let store: VectorStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l1-prov-"));
    store = new VectorStore(path.join(tmp, "vectors.db"), DIMS, silentLogger);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const firstStep = {
    role: "extractor",
    action: "store",
    at: "2026-08-01T00:00:00.000Z",
  };

  async function seedWithChain(id: string, text: string): Promise<void> {
    const record = existingRecord(id, text);
    record.metadata = {
      [PROVENANCE_KEY]: {
        source: "user-input",
        createdAt: firstStep.at,
        chain: [firstStep],
      },
    } as MemoryRecord["metadata"];
    await store.upsertL1(record, embedText(text));
  }

  async function chainOfStored(): Promise<unknown[]> {
    const rows = await store.queryL1Records();
    const withChain = rows
      .map((row) => readProvenance(JSON.parse(row.metadata_json || "{}")))
      .filter((provenance) => provenance !== undefined);
    expect(withChain).toHaveLength(1);
    return withChain[0]!.chain;
  }

  it("keeps the earlier step when the vector leg forces an update", async () => {
    await seedWithChain("m_chain", EXISTING_TEXT);
    const memory = newMem("m_new_chain", RESTATED_TEXT);

    const { decisions, previousMetadata } = await batchDedup({
      memories: [memory],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      projectId: PROJECT,
    });
    expect(decisions[0].action).toBe("update");
    // The candidate itself must carry the chain — this is the leg that lost it.
    expect(readProvenance(previousMetadata.get("m_chain"))?.chain).toEqual([
      firstStep,
    ]);

    await applyDecisions({
      memoriesWithIds: [memory],
      decisions,
      previousMetadata,
      baseDir: tmp,
      sessionKey: "test",
      projectId: PROJECT,
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
    });

    const chain = await chainOfStored();
    expect(chain).toHaveLength(2);
    expect(chain[0]).toEqual(firstStep);
    expect((chain[1] as { action: string }).action).toBe("update");
  });

  it("carries candidate metadata on the FTS leg too", async () => {
    await seedWithChain("m_chain_fts", EXISTING_TEXT);

    const { previousMetadata } = await batchDedup({
      memories: [newMem("m_new_fts", RESTATED_TEXT)],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      // No embedding service → Tier 2 FTS keyword recall.
      projectId: PROJECT,
    });

    expect(readProvenance(previousMetadata.get("m_chain_fts"))?.chain).toEqual([
      firstStep,
    ]);
  });

  it("a forged incoming chain does not replace the server-side one", async () => {
    await seedWithChain("m_chain_forged", EXISTING_TEXT);
    const memory = newMem("m_new_forged", RESTATED_TEXT);
    memory.metadata = {
      [PROVENANCE_KEY]: {
        source: "manual",
        createdAt: "1970-01-01T00:00:00.000Z",
        chain: [],
      },
    } as ExtractedMemory["metadata"];

    const { decisions, previousMetadata } = await batchDedup({
      memories: [memory],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      projectId: PROJECT,
    });

    await applyDecisions({
      memoriesWithIds: [memory],
      decisions,
      previousMetadata,
      baseDir: tmp,
      sessionKey: "test",
      projectId: PROJECT,
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
    });

    const rows = await store.queryL1Records();
    const provenance = readProvenance(
      JSON.parse(rows[0]!.metadata_json || "{}"),
    );
    expect(provenance?.source).toBe("user-input");
    expect(provenance?.createdAt).toBe(firstStep.at);
    expect(provenance?.chain[0]).toEqual(firstStep);
  });
});
