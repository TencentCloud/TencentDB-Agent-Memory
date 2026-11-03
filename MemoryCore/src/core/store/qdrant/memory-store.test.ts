import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { QdrantClient } from "@qdrant/js-client-rest";
import { runMemoryStoreContract } from "../__contract__/memory-store.contract.js";
import type { EmbeddingProviderInfo, EmbeddingService } from "../embedding.js";
import type { IMemoryStore } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { buildFtsQuery } from "../tokenize.js";
import { buildMemoryGenerationRefId } from "../../memory-generation-log/types.js";
import { QdrantMemoryStore, qdrantClientParams } from "./memory-store.js";
import { encodeDocument, encodeQuery } from "./sparse.js";

const QDRANT_URL = process.env.QDRANT_TEST_URL ?? "";
const client = QDRANT_URL ? new QdrantClient({ url: QDRANT_URL, checkCompatibility: false }) : undefined;
const prefixes = new Set<string>();

async function dropPrefix(prefix: string): Promise<void> {
  if (!client) return;
  const { collections } = await client.getCollections();
  await Promise.all(
    collections
      .filter((c) => c.name.startsWith(`${prefix}_`))
      .map((c) => client.deleteCollection(c.name)),
  );
}

afterAll(async () => {
  for (const p of prefixes) await dropPrefix(p);
});

class FakeEmbedding implements EmbeddingService {
  calls = 0;
  constructor(private readonly dims = 32, private readonly model = "fake-v1") {}
  async embed(text: string): Promise<Float32Array> {
    this.calls++;
    const v = new Float32Array(this.dims);
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
      v[h % this.dims] += 1;
    }
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  getDimensions(): number {
    return this.dims;
  }
  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "openai", model: this.model, dimensions: this.dims } as EmbeddingProviderInfo;
  }
  isReady(): boolean {
    return true;
  }
  startWarmup(): void {}
}

function newPrefix(): string {
  const p = `tdai_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  prefixes.add(p);
  return p;
}

async function createStore(
  opts: { prefix?: string; tenant?: string; embedding?: EmbeddingService } = {},
): Promise<QdrantMemoryStore> {
  const store = new QdrantMemoryStore({
    url: QDRANT_URL,
    collectionPrefix: opts.prefix ?? newPrefix(),
    tenant: opts.tenant,
    embedding: opts.embedding,
  });
  await store.init();
  return store;
}

function makeL1(id: string, content: string, over?: Partial<MemoryRecord>): MemoryRecord {
  const ts = new Date().toISOString();
  return {
    id,
    content,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    sessionKey: "sk",
    sessionId: "sid",
    ...over,
  };
}

function makeL0(id: string, text: string, recordedAtMs: number, over?: Record<string, unknown>) {
  return {
    id,
    sessionKey: "sk",
    sessionId: "sid",
    role: "user",
    messageText: text,
    recordedAt: new Date(recordedAtMs).toISOString(),
    timestamp: recordedAtMs,
    ...over,
  } as Parameters<IMemoryStore["upsertL0"]>[0];
}

describe("qdrant sparse BM25 encoding", () => {
  it("weights repeated terms higher and indexes every term a query produces", () => {
    const doc = encodeDocument("TypeScript TypeScript React");
    expect(doc.indices.length).toBe(2);
    const q = encodeQuery(buildFtsQuery("TypeScript")!);
    expect(q.indices.length).toBe(1);
    const i = doc.indices.indexOf(q.indices[0]);
    expect(i).toBeGreaterThanOrEqual(0);
    const other = doc.values[1 - i];
    expect(doc.values[i]).toBeGreaterThan(other);
    for (const text of ["用户喜欢喝咖啡，每天早上一杯", "部署在 k8s 集群上的 Qdrant 服务"]) {
      const indexed = new Set(encodeDocument(text).indices);
      expect(encodeQuery(text).indices.every((idx) => indexed.has(idx))).toBe(true);
    }
  });
});


describe("qdrant endpoint parsing", () => {
  it("uses scheme-default ports and keeps sub-paths", () => {
    expect(qdrantClientParams("https://qdrant.example.com")).toEqual({ url: "https://qdrant.example.com:443" });
    expect(qdrantClientParams("https://host:443")).toEqual({ url: "https://host:443" });
    expect(qdrantClientParams("http://localhost:6333")).toEqual({ url: "http://localhost:6333" });
    expect(qdrantClientParams("http://gw")).toEqual({ url: "http://gw:80" });
    expect(qdrantClientParams("https://gw/qdrant/")).toEqual({ url: "https://gw:443", prefix: "/qdrant" });
    expect(() => qdrantClientParams("ftp://x")).toThrow(/http/);
  });
});

describe.skipIf(!QDRANT_URL)("QdrantMemoryStore (live)", () => {
  runMemoryStoreContract({
    backend: "qdrant",
    createStore: () => createStore(),
    disposeStore: async (store) => {
      await dropPrefix((store as unknown as { prefix: string }).prefix);
    },
  });

  it("dense vector search ranks by similarity and respects isolation", async () => {
    const emb = new FakeEmbedding();
    const store = await createStore({ embedding: emb });
    expect(store.getCapabilities().vectorSearch).toBe(true);
    expect(store.getCapabilities().nativeHybridSearch).toBe(true);

    const docs: Array<[string, string, string]> = [
      ["v-coffee", "user drinks espresso coffee every morning", "team-a"],
      ["v-code", "user writes rust and typescript code", "team-a"],
      ["v-coffee-b", "user drinks espresso coffee every morning", "team-b"],
    ];
    for (const [id, text, team] of docs) {
      await store.upsertL1(makeL1(id, text, { teamId: team, agentId: "agent" } as Partial<MemoryRecord>), await emb.embed(text));
    }

    const q = await emb.embed("espresso coffee");
    const hits = await store.searchL1Vector(q, 3, undefined, { teamId: "team-a" });
    expect(hits.map((h) => h.record_id)).toEqual(["v-coffee", "v-code"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("native hybrid embeds the query itself and fuses dense + BM25", async () => {
    const emb = new FakeEmbedding();
    const store = await createStore({ embedding: emb });
    for (const [id, text] of [
      ["h-1", "deploy the gateway with docker compose"],
      ["h-2", "the user prefers dark mode in the editor"],
      ["h-3", "docker images are pushed to the registry"],
    ]) {
      await store.upsertL1(makeL1(id, text), await emb.embed(text));
    }
    const before = emb.calls;
    const hits = await store.searchL1Hybrid({ query: "docker deploy", topK: 2 });
    expect(emb.calls).toBe(before + 1);
    expect(hits.map((h) => h.record_id)).toContain("h-1");
    expect(hits.map((h) => h.record_id)).not.toContain("h-2");

    await store.upsertL0(makeL0("h-l0", "docker deploy failed with exit code 1", 1_000), await emb.embed("docker deploy failed"));
    const l0 = await store.searchL0Hybrid({ query: "docker deploy", topK: 1 });
    expect(l0[0]?.record_id).toBe("h-l0");
  });

  it("hybrid degrades to keyword-only when query embedding fails", async () => {
    const emb = new FakeEmbedding();
    const store = await createStore({ embedding: emb });
    await store.upsertL1(makeL1("d-1", "kubernetes cluster upgrade notes"), await emb.embed("kubernetes cluster upgrade notes"));
    emb.embed = async () => {
      throw new Error("embedding provider down");
    };
    const hits = await store.searchL1Hybrid({ query: "kubernetes upgrade", topK: 3 });
    expect(hits.map((h) => h.record_id)).toEqual(["d-1"]);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThan(1);
  });

  it("embedding model change adds a new dense vector, backfills it, and never wipes the old one", async () => {
    const prefix = newPrefix();
    const v1 = new FakeEmbedding(32, "fake-v1");
    const store1 = await createStore({ prefix, embedding: v1 });
    await store1.upsertL1(makeL1("r-1", "user drinks espresso coffee"), await v1.embed("user drinks espresso coffee"));
    await store1.upsertL0(makeL0("r-l0", "espresso coffee please", 1_000), await v1.embed("espresso coffee please"));
    await store1.upsertL1(makeL1("r-2", "user writes rust code"));

    const v2 = new FakeEmbedding(48, "fake-v2");
    const store2 = new QdrantMemoryStore({ url: QDRANT_URL, collectionPrefix: prefix, embedding: v2 });
    const init = await store2.init();
    expect(init.needsReindex).toBe(false);
    await store2.waitForVectorBackfill();
    expect(await store2.countL1()).toBe(2);
    expect((await store2.searchL1Vector(await v2.embed("espresso coffee"), 1)).map((h) => h.record_id)).toEqual(["r-1"]);
    expect((await store2.searchL1Vector(await v2.embed("rust code"), 1)).map((h) => h.record_id)).toEqual(["r-2"]);
    expect((await store2.searchL0Vector(await v2.embed("espresso coffee"), 1)).map((h) => h.record_id)).toEqual(["r-l0"]);

    const store1b = new QdrantMemoryStore({ url: QDRANT_URL, collectionPrefix: prefix, embedding: new FakeEmbedding(32, "fake-v1") });
    await store1b.init();
    await store1b.waitForVectorBackfill();
    expect((await store1b.searchL1Vector(await v1.embed("espresso coffee"), 1)).map((h) => h.record_id)).toEqual(["r-1"]);
    expect((await store2.searchL1Vector(await v2.embed("espresso coffee"), 1)).map((h) => h.record_id)).toEqual(["r-1"]);

    expect(await store2.reindexAll((t) => v2.embed(t))).toEqual({ l1Count: 2, l0Count: 1 });
  });

  it("backfills a vector missing after a write, without a restart", async () => {
    const emb = new FakeEmbedding();
    const store = await createStore({ embedding: emb });
    await store.waitForVectorBackfill();
    await store.upsertL1(makeL1("b-1", "user drinks espresso coffee"));
    await store.waitForVectorBackfill();
    expect((await store.searchL1Vector(await emb.embed("espresso coffee"), 1)).map((h) => h.record_id)).toEqual(["b-1"]);
    expect(await store.insertL0Batch([makeL0("b-l0", "espresso coffee please", 1_000), makeL0("b-l0b", "rust code", 2_000)])).toBe(2);
    await store.waitForVectorBackfill();
    expect((await store.searchL0Vector(await emb.embed("espresso coffee"), 1)).map((h) => h.record_id)).toEqual(["b-l0"]);
  });

  it("insertL0Batch rejects an existing id without overwriting it", async () => {
    const store = await createStore();
    await store.insertL0Batch([makeL0("d-1", "original", 1_000)]);
    await expect(store.insertL0Batch([makeL0("d-2", "fresh", 2_000), makeL0("d-1", "clobber", 3_000)])).rejects.toThrow(/duplicate record id d-1/);
    await expect(store.insertL0Batch([makeL0("d-3", "first", 2_000), makeL0("d-3", "second", 3_000)])).rejects.toThrow(/duplicate record id d-3/);
    expect((await store.queryL0ForL1("sk")).map((r) => [r.record_id, r.message_text])).toEqual([["d-1", "original"]]);
  });

  it("pagination over identical timestamps never repeats or skips a row", async () => {
    const store = await createStore();
    const ts = new Date(1_700_000_000_000).toISOString();
    for (let i = 0; i < 40; i++) await store.upsertL1(makeL1(`tie-${i}`, `tied ${i}`, { updatedAt: ts, createdAt: ts }));
    const seen: string[] = [];
    for (let offset = 0; offset < 40; offset += 7) {
      seen.push(...(await store.queryL1Paginated({ limit: 7, offset })).rows.map((r) => r.record_id));
    }
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
  });

  it("tenants share collections but never see each other's data, even under the same ids", async () => {
    const prefix = newPrefix();
    const emb = new FakeEmbedding();
    const a = await createStore({ prefix, tenant: "acme", embedding: emb });
    const b = await createStore({ prefix, tenant: "globex", embedding: emb });
    for (const [store, who] of [[a, "acme"], [b, "globex"]] as const) {
      const l1 = `${who} drinks espresso coffee`;
      await store.upsertL1(makeL1("same-l1", l1), await emb.embed(l1));
      await store.upsertL0(makeL0("same-l0", `${who} espresso coffee`, 1_000), await emb.embed(`${who} espresso coffee`));
      await store.syncProfiles([{
        id: "same-p", type: "l3", filename: "persona.md", content: who, contentMd5: who,
        teamId: "t", agentId: "ag", version: 1, createdAtMs: 1, updatedAtMs: 1,
      }]);
      await store.createMemoryPrompt({
        memory_prompt_id: "same-mp", name: who, layer: "l1", prompt: who, version: 1, status: "active",
        created_at_ms: 1, updated_at_ms: 1,
      });
      await store.createKnowledge({ knowledge_id: "same-k", team_id: "t", type: "wiki", name: who, service_url: "", summary: null, user_id: null });
    }

    const collections = (await client!.getCollections()).collections.filter((c) => c.name.startsWith(`${prefix}_`));
    expect(collections).toHaveLength(9);

    expect(await a.countL1()).toBe(1);
    expect(await a.countL0()).toBe(1);
    expect((await a.queryL1Records({ recordIds: ["same-l1"] })).map((r) => r.content)).toEqual(["acme drinks espresso coffee"]);
    expect((await a.getAllL1Texts()).map((r) => r.content)).toEqual(["acme drinks espresso coffee"]);
    expect((await a.searchL1Hybrid({ query: "espresso coffee", topK: 5 })).map((h) => h.content)).toEqual(["acme drinks espresso coffee"]);
    expect((await a.searchL1Vector(await emb.embed("espresso coffee"), 5)).map((h) => h.content)).toEqual(["acme drinks espresso coffee"]);
    expect((await a.searchL1Fts(buildFtsQuery("espresso")!, 5)).map((h) => h.content)).toEqual(["acme drinks espresso coffee"]);
    expect((await a.queryL0ForL1("sk")).map((r) => r.message_text)).toEqual(["acme espresso coffee"]);
    expect((await a.queryProfilesByIds(["same-p"])).map((p) => p.content)).toEqual(["acme"]);
    expect((await a.pullProfiles()).map((p) => p.content)).toEqual(["acme"]);
    expect((await a.getMemoryPrompts(["same-mp"])).map((p) => p.name)).toEqual(["acme"]);
    expect(await a.countMemoryPrompts()).toBe(1);
    expect((await a.getKnowledge("same-k"))?.name).toBe("acme");
    expect((await a.listKnowledge({ team_id: "t" })).total).toBe(1);

    expect(await b.deleteL1("same-l1")).toBe(true);
    await b.deleteProfiles(["same-p"]);
    expect(await b.deleteL0BySession("sid")).toBe(1);
    await b.deleteMemoryPrompts(["same-mp"]);
    expect(await b.countL1()).toBe(0);
    expect(await a.countL1()).toBe(1);
    expect(await a.countL0()).toBe(1);
    expect(await a.countProfiles()).toBe(1);
    expect(await a.countMemoryPrompts()).toBe(1);
  });

  it("profile optimistic lock rejects stale writers and lets exactly one concurrent writer win", async () => {
    const store = await createStore();
    const base = {
      id: "p-race", type: "l2" as const, filename: "scene_blocks/x.md", content: "v1", contentMd5: "m1",
      teamId: "t", agentId: "a", version: 1, createdAtMs: 1, updatedAtMs: 1,
    };
    await store.syncProfiles([base]);
    for (let round = 0; round < 3; round++) {
      const current = (await store.queryProfilesByIds(["p-race"]))[0];
      const next = current.version + 1;
      const results = await Promise.allSettled([
        store.syncProfiles([{ ...base, content: `a${round}`, version: next, baselineVersion: current.version }]),
        store.syncProfiles([{ ...base, content: `b${round}`, version: next, baselineVersion: current.version }]),
      ]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
      const winner = results[0].status === "fulfilled" ? `a${round}` : `b${round}`;
      expect((await store.queryProfilesByIds(["p-race"]))[0].content).toBe(winner);
    }
    await expect(store.syncProfiles([{ ...base, version: 99, baselineVersion: 1 }])).rejects.toThrow(/optimistic-lock/);
  });

  it("memory prompts, settings, logs and generation refs round-trip", async () => {
    const store = await createStore();
    await store.createMemoryPrompt({
      memory_prompt_id: "mp-1", name: "n", layer: "l1", prompt: "p", version: 1, status: "active",
      created_at_ms: 1, updated_at_ms: 1,
    });
    await store.createMemoryPrompt({
      memory_prompt_id: "mp-2", name: "n2", layer: "l2", prompt: "p2", version: 1, status: "active",
      created_at_ms: 2, updated_at_ms: 2,
    });
    expect(await store.countMemoryPrompts()).toBe(2);
    expect((await store.listMemoryPrompts({ limit: 10 })).map((p) => p.memory_prompt_id)).toEqual(["mp-2", "mp-1"]);
    expect((await store.listMemoryPrompts({ layer: "l1" })).map((p) => p.memory_prompt_id)).toEqual(["mp-1"]);

    const updated = await store.updateMemoryPrompt("mp-1", { prompt: "p-new", updated_at_ms: 5 });
    expect(updated?.version).toBe(2);

    await store.upsertMemoryPromptSettings(
      [{ setting_id: "s-1", target_type: "team", team_id: "t", layer: "l1", memory_prompt_id: "mp-1", updated_at_ms: 3 }],
      [{ setting_log_id: "log-1", target_type: "team", team_id: "t", layer: "l1", action: "apply", reason: "explicit", after_memory_prompt_id: "mp-1", operated_at_ms: 3 }],
    );
    expect((await store.listMemoryPromptSettings({ memoryPromptId: "mp-1" })).map((s) => s.setting_id)).toEqual(["s-1"]);

    const del = await store.deleteMemoryPrompts(["mp-1"], "op");
    expect(del.deleted_prompt_ids).toEqual(["mp-1"]);
    expect(del.cleared_settings.team).toBe(1);
    expect(await store.getMemoryPromptSettings(["s-1"])).toEqual([]);
    const logs = await store.queryMemoryPromptSettingLogs({ memoryPromptId: "mp-1", timeOrder: "asc" });
    expect(logs.map((l) => l.action)).toEqual(["apply", "clear"]);

    await store.upsertMemoryGenerationRefs([{
      generation_ref_id: buildMemoryGenerationRefId("l1", "mem-1"), layer: "l1", memory_id: "mem-1", generation_id: "g",
      generation_log_id: "gl", generation_log_key: "k", memory_prompt_id: "mp-2", memory_prompt_version: 1,
      memory_prompt_source: "team", created_at_ms: 1,
    }]);
    expect((await store.getMemoryGenerationRef("l1", "mem-1"))?.memory_prompt_source).toBe("team");
    expect(await store.getMemoryGenerationRef("l2", "mem-1")).toBeNull();
  });

  it("knowledge and audit entities round-trip with ordering", async () => {
    const store = await createStore();
    await store.createKnowledge({ knowledge_id: "k-1", type: "wiki", service_url: "u", name: "one", summary: null, team_id: "t", user_id: null });
    await new Promise((r) => setTimeout(r, 5));
    await store.createKnowledge({ knowledge_id: "k-2", type: "code-graph", service_url: "u", name: "two", summary: null, team_id: "t", user_id: null });
    expect((await store.listKnowledge({ team_id: "t" })).items.map((k) => k.knowledge_id)).toEqual(["k-2", "k-1"]);
    expect((await store.listKnowledge({ team_id: "t", type: "wiki" })).total).toBe(1);
    expect((await store.updateKnowledge("k-1", { name: "renamed" }))?.name).toBe("renamed");
    expect(await store.updateKnowledge("missing", { name: "x" })).toBeNull();
    const del = await store.deleteKnowledge(["k-2", "missing"], "t");
    expect(del.deleted_ids).toEqual(["k-2"]);
    expect(del.failed).toEqual([{ id: "missing", reason: "not_found" }]);

    for (const [id, ms] of [["a-1", 10], ["a-2", 30], ["a-3", 20]] as const) {
      await store.appendAudit({ audit_id: id, record_id: "r", layer: "L1", action: "update", version: 1, updated_at_ms: ms });
    }
    expect((await store.queryAudit({ record_id: "r" })).map((a) => a.audit_id)).toEqual(["a-2", "a-3", "a-1"]);
    expect((await store.queryAudit({ since_ms: 15, limit: 1 })).map((a) => a.audit_id)).toEqual(["a-2"]);
  });
});
