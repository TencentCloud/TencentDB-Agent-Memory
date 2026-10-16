import { createHash, randomUUID } from "node:crypto";
import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import { hasClientEmbedding, type EmbeddingService } from "../embedding.js";
import { DEFAULT_ISOLATION_ID } from "../isolation.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  StoreInitResult,
  StoreLogger,
  L1SearchResult,
  L1FtsResult,
  L1RecordRow,
  L1QueryFilter,
  L1CountFilter,
  L1PaginatedFilter,
  L1PaginatedResult,
  L0SearchResult,
  L0FtsResult,
  L0QueryRow,
  L0SessionGroup,
  L0Record,
  L0CountFilter,
  L0PaginatedFilter,
  L0PaginatedResult,
  ProfileRecord,
  ProfileSyncRecord,
  ProfileFilter,
  IsolationFilter,
  AuditEntry,
  AuditQueryFilter,
  KnowledgeEntity,
  KnowledgeType,
  KnowledgeListResult,
  BatchDeleteResult,
  MemoryContentClearFilter,
  MemoryContentClearResult,
} from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLayer,
  type MemoryGenerationRefRecord,
} from "../../memory-generation-log/types.js";
import type {
  MemoryPromptListFilter,
  MemoryPromptRecord,
  MemoryPromptSettingListFilter,
  MemoryPromptSettingLogFilter,
  MemoryPromptSettingLogRecord,
  MemoryPromptSettingRecord,
  MemoryPromptTargetType,
} from "../../memory-prompt/types.js";
import {
  type L0Doc,
  type L1Doc,
  l0RecordToDoc,
  l1RecordToDoc,
  docToL0QueryRow,
  docToL0SearchResult,
  docToL1RecordRow,
  docToL1SearchResult,
  groupL0RowsBySession,
  isoToEpochMs,
} from "../mongodb/doc-mappers.js";
import { encodeDocument, encodeFtsQuery, encodeQuery, type QdrantSparseVector } from "./sparse.js";
import { mongoSearchScoreToScore } from "../tokenize.js";
import { ProfileVersionConflictError } from "../profile-row-store.js";

const TAG = "[memory-tdai][qdrant]";
const SPARSE = "bm25";
const TENANT = "_tenant";
const DEFAULT_TENANT = "default";
const RRF_K = 60;
const PAGE = 256;
const EMBED_BATCH = 32;
const BACKFILL_SWEEP_MS = 10 * 60_000;

const backfillRuns = new Map<string, Promise<void>>();
const backfillQueued = new Map<string, QdrantMemoryStore>();
const openStores = new Map<string, Set<QdrantMemoryStore>>();
const sharedClients = new Map<string, QdrantClient>();
const collectionSetups = new Map<string, Promise<void>>();

type Kind =
  | "l0" | "l1" | "profiles" | "audit" | "knowledge" | "memory_prompts"
  | "memory_prompt_settings" | "memory_prompt_setting_logs" | "memory_generation_refs";
type Filter = Schemas["Filter"];
type Condition = Schemas["Condition"];
type Payload = Record<string, unknown>;
type Hit = { payload: Payload; score: number };
type HybridParams = { query?: string; queryEmbedding?: Float32Array; topK?: number; filter?: IsolationFilter };

const INDEXES: Record<Kind, [string[], string[]]> = {
  l0: [["session_key", "session_id", "team_id", "user_id", "agent_id", "task_id", "_text_hash"], ["recorded_at_ms", "timestamp"]],
  l1: [["session_key", "session_id", "team_id", "user_id", "agent_id", "task_id", "type", "_text_hash"], ["updated_time_ms"]],
  profiles: [["type", "teamId", "userId", "agentId"], ["version"]],
  audit: [["record_id", "layer", "action", "team_id", "agent_id", "user_id", "task_id"], ["updated_at_ms"]],
  knowledge: [["team_id", "type"], ["_updated_ms"]],
  memory_prompts: [["status", "layer"], ["updated_at_ms"]],
  memory_prompt_settings: [["memory_prompt_id", "target_type", "team_id", "agent_id", "layer"], ["updated_at_ms"]],
  memory_prompt_setting_logs: [["before_memory_prompt_id", "after_memory_prompt_id", "team_id", "agent_id", "action"], ["operated_at_ms"]],
  memory_generation_refs: [[], []],
};

export interface QdrantMemoryStoreOptions {
  url: string;
  apiKey?: string;
  collectionPrefix: string;
  tenant?: string;
  embedding?: EmbeddingService;
  queryEmbeddingTimeoutMs?: number;
  logger?: StoreLogger;
}

export function qdrantClientParams(rawUrl: string): { url: string; prefix?: string } {
  const u = URL.canParse(rawUrl) ? new URL(rawUrl) : undefined;
  if (u?.protocol !== "http:" && u?.protocol !== "https:") {
    throw new Error(`${TAG} QDRANT_URL must be an http(s) URL, got ${JSON.stringify(rawUrl)}`);
  }
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const prefix = u.pathname.replace(/\/+$/, "");
  return { url: `${u.protocol}//${u.hostname}:${port}`, ...(prefix ? { prefix } : {}) };
}

function toPointId(id: string): string {
  const h = createHash("md5").update(id).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class QdrantMemoryStore implements IMemoryStore {
  private readonly client: QdrantClient;
  private readonly prefix: string;
  private readonly tenant: string;
  private readonly logger?: StoreLogger;
  private readonly embedding?: EmbeddingService;
  private readonly queryEmbeddingTimeoutMs?: number;
  private readonly dims: number = 0;
  private readonly dense: string = "";
  private readonly backfillKey: string;
  private initPromise?: Promise<void>;
  private ready = false;
  private degraded = false;
  private closed = false;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(opts: QdrantMemoryStoreOptions) {
    const clientKey = `${opts.url}\0${opts.apiKey ?? ""}`;
    let client = sharedClients.get(clientKey);
    if (!client) {
      client = new QdrantClient({
        ...qdrantClientParams(opts.url),
        apiKey: opts.apiKey || undefined,
        timeout: 10_000,
        checkCompatibility: false,
      });
      sharedClients.set(clientKey, client);
    }
    this.client = client;
    this.prefix = opts.collectionPrefix;
    this.tenant = opts.tenant ?? DEFAULT_TENANT;
    this.logger = opts.logger;
    this.queryEmbeddingTimeoutMs = opts.queryEmbeddingTimeoutMs;
    if (hasClientEmbedding(opts.embedding) && opts.embedding.getDimensions() > 0) {
      const { provider, model } = opts.embedding.getProviderInfo();
      this.embedding = opts.embedding;
      this.dims = opts.embedding.getDimensions();
      this.dense = `dense_${this.dims}_${createHash("sha256").update(`${provider}\0${model}`).digest("hex").slice(0, 8)}`;
    }
    this.backfillKey = `${opts.url}|${this.prefix}|${this.dense}`;
  }

  async init(): Promise<StoreInitResult> {
    this.initPromise ??= (async () => {
      const setupKey = this.backfillKey;
      let setup = collectionSetups.get(setupKey);
      if (!setup) {
        const created: Promise<void> = Promise.all((Object.keys(INDEXES) as Kind[]).map((kind) => this.ensureCollection(kind)))
          .then(() => undefined)
          .catch((err) => {
            if (collectionSetups.get(setupKey) === created) collectionSetups.delete(setupKey);
            throw err;
          });
        setup = created;
        collectionSetups.set(setupKey, setup);
      }
      await setup;
      this.ready = true;
      this.degraded = false;
      if (this.dense && !this.closed) {
        if (!openStores.has(this.backfillKey)) openStores.set(this.backfillKey, new Set());
        openStores.get(this.backfillKey)!.add(this);
        this.requestBackfill();
        this.sweepTimer = setInterval(() => this.requestBackfill(), BACKFILL_SWEEP_MS);
        this.sweepTimer.unref?.();
      }
    })().catch((err) => {
      this.initPromise = undefined;
      this.degraded = true;
      throw err;
    });
    await this.initPromise;
    return { needsReindex: false };
  }

  private async ensureInit(): Promise<void> {
    if (!this.ready) await this.init();
  }

  private name(kind: Kind): string {
    return `${this.prefix}_${kind}`;
  }

  private async ensureCollection(kind: Kind): Promise<void> {
    const name = this.name(kind);
    const isVector = kind === "l0" || kind === "l1";
    const exists = async () => (await this.client.collectionExists(name)).exists;
    if (!(await exists())) {
      await tolerateRace(
        () => this.client.createCollection(name, {
          vectors: isVector && this.dense ? { [this.dense]: { size: this.dims, distance: "Cosine" } } : {},
          ...(isVector ? { sparse_vectors: { [SPARSE]: { modifier: "idf" } }, hnsw_config: { m: 0, payload_m: 16 } } : {}),
        }),
        exists,
      );
    }
    const info = await this.client.getCollection(name);
    if (isVector && this.dense && !(this.dense in (info.config.params.vectors ?? {}))) {
      await tolerateRace(
        () => this.client.createVectorName(name, this.dense, { dense: { size: this.dims, distance: "Cosine" } } as Schemas["VectorNameConfig"], { wait: true }),
        async () => this.dense in ((await this.client.getCollection(name)).config.params.vectors ?? {}),
      );
    }
    const [keyword, integer] = INDEXES[kind];
    const schemas: Array<[string, Schemas["PayloadFieldSchema"]]> = [
      [TENANT, { type: "keyword", is_tenant: true }],
      ...keyword.map((f): [string, Schemas["PayloadFieldSchema"]] => [f, { type: "keyword", enable_hnsw: false }]),
      ...integer.map((f): [string, Schemas["PayloadFieldSchema"]] => [f, { type: "integer", enable_hnsw: false }]),
    ];
    for (const [field, field_schema] of schemas) {
      if (field in (info.payload_schema ?? {})) continue;
      await this.client.createPayloadIndex(name, { field_name: field, field_schema, wait: true });
    }
  }

  private requestBackfill(): void {
    const key = this.backfillKey;
    if (!this.dense || this.closed) return;
    const queued = backfillQueued.has(key);
    backfillQueued.set(key, this);
    if (queued) return;
    const run = (backfillRuns.get(key) ?? Promise.resolve()).then(async () => {
      const queuedBy = backfillQueued.get(key)!;
      backfillQueued.delete(key);
      const store = queuedBy.closed ? openStores.get(key)?.values().next().value : queuedBy;
      if (!store) return;
      try {
        await store.embedPoints(
          { must_not: [{ has_vector: store.dense }] },
          (text) => store.embedding!.embed(text),
          (texts) => store.embedding!.embedBatch(texts),
        );
      } catch (err) {
        store.logger?.warn?.(`${TAG} dense backfill stopped (retried on the next sweep): ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    backfillRuns.set(key, run);
    void run.finally(() => {
      if (backfillRuns.get(key) === run) backfillRuns.delete(key);
    });
  }

  async waitForVectorBackfill(): Promise<void> {
    for (let run = backfillRuns.get(this.backfillKey); run; run = backfillRuns.get(this.backfillKey)) await run;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: this.dims > 0,
      ftsSearch: this.ready,
      nativeHybridSearch: this.dims > 0,
      sparseVectors: true,
      profileRows: true,
    };
  }

  isFtsAvailable(): boolean {
    return this.ready;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.sweepTimer);
    openStores.get(this.backfillKey)?.delete(this);
  }

  private pid(id: string): string {
    return toPointId(JSON.stringify([this.tenant, id]));
  }

  private hasIds(ids: string[]): Condition {
    return { has_id: ids.map((id) => this.pid(id)) };
  }

  private scoped(filter?: Filter): Filter {
    const must = filter?.must ?? [];
    return { ...filter, must: [{ key: TENANT, match: { value: this.tenant } }, ...(Array.isArray(must) ? must : [must])] };
  }

  private denseVector(embedding: Float32Array | undefined): number[] | undefined {
    if (!this.dims || !embedding) return undefined;
    if (embedding.length !== this.dims) {
      this.logger?.warn?.(`${TAG} ignoring embedding with ${embedding.length} dims (expected ${this.dims})`);
      return undefined;
    }
    return Array.from(embedding);
  }

  private vectors(text: string, embedding?: Float32Array): Record<string, number[] | QdrantSparseVector> {
    const out: Record<string, number[] | QdrantSparseVector> = {};
    const sparse = encodeDocument(text);
    if (sparse.indices.length > 0) out[SPARSE] = sparse;
    const dense = this.denseVector(embedding);
    if (dense) out[this.dense] = dense;
    return out;
  }

  private memoryPoint(id: string, text: string, doc: { tokens: string }, embedding?: Float32Array): Schemas["PointStruct"] {
    const { tokens: _tokens, ...payload } = doc;
    return { id: this.pid(id), vector: this.vectors(text, embedding), payload: { ...payload, [TENANT]: this.tenant, _text_hash: textHash(text) } };
  }

  private async upsertMemory(kind: "l0" | "l1", id: string, text: string, doc: { tokens: string }, embedding?: Float32Array): Promise<void> {
    await this.ensureInit();
    const point = this.memoryPoint(id, text, doc, embedding);
    await this.client.upsert(this.name(kind), { wait: true, points: [point] });
    if (!(this.dense in (point.vector as object))) this.requestBackfill();
  }

  private async putRecords(kind: Kind, records: Array<[id: string, payload: Payload]>): Promise<void> {
    if (records.length === 0) return;
    await this.ensureInit();
    await this.client.upsert(this.name(kind), {
      wait: true,
      points: records.map(([id, payload]) => ({ id: this.pid(id), vector: {}, payload: { ...payload, [TENANT]: this.tenant } })),
    });
  }

  private async getRecords<T>(kind: Kind, ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    await this.ensureInit();
    const points = await this.client.retrieve(this.name(kind), { ids: ids.map((id) => this.pid(id)), with_payload: true });
    const byId = new Map(points.map((p) => [String(p.id), p.payload ?? {}]));
    return ids.flatMap((id) => {
      const payload = byId.get(this.pid(id));
      return payload ? [toRecord<T>(payload)] : [];
    });
  }

  private async find(
    kind: Kind,
    filter?: Filter,
    order?: { key: string; desc?: boolean; offset?: number; limit: number; tie?: string },
    fields?: string[],
  ): Promise<Payload[]> {
    await this.ensureInit();
    const name = this.name(kind);
    filter = this.scoped(filter);
    if (!order) return (await this.scrollAll(name, filter, fields ? { include: fields } : true)).map((p) => p.payload ?? {});
    const offset = order.offset ?? 0;
    const n = offset + order.limit;
    if (order.limit <= 0) return [];
    const with_payload = fields ? { include: [...fields, order.key, ...(order.tie ? [order.tie] : [])] } : true;
    let points = (await this.client.scroll(name, {
      filter,
      limit: n,
      order_by: { key: order.key, direction: order.desc ? "desc" : "asc" },
      with_payload,
    })).points;
    const keyOf = (p: Schemas["Record"]) => Number(p.payload?.[order.key]);
    if (points.length === n) {
      const edge = keyOf(points[n - 1]);
      const tied = await this.scrollAll(name, { ...filter, must: [...(filter.must as Condition[]), { key: order.key, range: { gte: edge, lte: edge } }] }, with_payload);
      points = [...points.filter((p) => keyOf(p) !== edge), ...tied];
    }
    const tieOf = (p: Schemas["Record"]) => String(order.tie ? p.payload?.[order.tie] : p.id);
    const sign = order.desc ? -1 : 1;
    points.sort((a, b) => sign * (keyOf(a) - keyOf(b) || (tieOf(a) < tieOf(b) ? -1 : tieOf(a) > tieOf(b) ? 1 : 0)));
    return points.slice(offset, n).map((p) => p.payload ?? {});
  }

  private async scrollAll(name: string, filter: Filter, with_payload: Schemas["WithPayloadInterface"]): Promise<Schemas["Record"][]> {
    const out: Schemas["Record"][] = [];
    let offset: Schemas["ExtendedPointId"] | undefined;
    do {
      const res = await this.client.scroll(name, { filter, limit: PAGE, offset, with_payload });
      out.push(...res.points);
      offset = (res.next_page_offset ?? undefined) as Schemas["ExtendedPointId"] | undefined;
    } while (offset !== undefined);
    return out;
  }

  private async count(kind: Kind, filter?: Filter): Promise<number> {
    await this.ensureInit();
    return (await this.client.count(this.name(kind), { filter: this.scoped(filter), exact: true })).count;
  }

  private async deleteWhere(kind: Kind, must: Condition[]): Promise<number> {
    const filter = { must };
    const n = await this.count(kind, filter);
    if (n > 0) await this.client.delete(this.name(kind), { wait: true, filter: this.scoped(filter) });
    return n;
  }

  private async deleteExpired(kind: "l0" | "l1", key: string, cutoffIso: string): Promise<number> {
    const cutoffMs = isoToEpochMs(cutoffIso);
    if (cutoffMs <= 0) return 0;
    const filter = { must: [{ key, range: { lt: cutoffMs } }] };
    const expired = await this.count(kind, filter);
    if (expired === 0) return 0;
    const total = await this.count(kind);
    if (expired / total > 0.8) {
      this.logger?.warn?.(`${TAG} [${kind}-deleteExpired] BLOCKED: would delete ${expired}/${total} (>80%), cutoff=${cutoffIso}`);
      return 0;
    }
    return this.deleteWhere(kind, filter.must);
  }

  private async embedPoints(
    filter: Filter | undefined,
    embedOne: (text: string) => Promise<Float32Array>,
    embedBatch?: (texts: string[]) => Promise<Float32Array[]>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    const counts = { l1Count: 0, l0Count: 0 };
    for (const [kind, field, layer] of [["l1", "content", "L1"], ["l0", "message_text", "L0"]] as const) {
      const name = this.name(kind);
      const total = onProgress ? (await this.client.count(name, { filter, exact: true })).count : 0;
      let done = 0;
      let offset: Schemas["ExtendedPointId"] | undefined;
      do {
        if (this.closed) return counts;
        const page = await this.client.scroll(name, { filter, limit: EMBED_BATCH, offset, with_payload: [field] });
        const items = page.points
          .map((p) => ({ id: p.id, text: String(p.payload?.[field] ?? "") }))
          .filter((i) => i.text);
        const texts = items.map((i) => i.text);
        let embeddings: Array<Float32Array | undefined> | undefined;
        if (embedBatch) embeddings = await embedBatch(texts).catch(() => undefined);
        embeddings ??= (await Promise.allSettled(texts.map(embedOne))).map((r) => (r.status === "fulfilled" ? r.value : undefined));
        if (texts.length > 0 && embeddings.every((e) => !e)) {
          this.logger?.warn?.(`${TAG} ${name}: embedding failed for a whole page, stopping`);
          return counts;
        }
        const operations = items.flatMap((item, n) => {
          const dense = this.denseVector(embeddings[n]);
          return dense
            ? [{
              update_vectors: {
                points: [{ id: item.id, vector: { [this.dense]: dense } }],
                update_filter: { must: [{ key: "_text_hash", match: { value: textHash(item.text) } }] },
              },
            }]
            : [];
        });
        if (operations.length > 0) await this.client.batchUpdate(name, { wait: true, operations });
        counts[kind === "l1" ? "l1Count" : "l0Count"] += operations.length;
        done += page.points.length;
        onProgress?.(done, total, layer);
        offset = (page.next_page_offset ?? undefined) as Schemas["ExtendedPointId"] | undefined;
      } while (offset !== undefined);
    }
    return counts;
  }

  async upsertL1(record: MemoryRecord, embedding?: Float32Array): Promise<boolean> {
    await this.upsertMemory("l1", record.id, record.content, l1RecordToDoc(record), embedding);
    return true;
  }

  async deleteL1(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    return (await this.deleteWhere("l1", [this.hasIds([recordId]), ...isolation(filter)])) > 0;
  }

  async deleteL1Batch(recordIds: string[], filter?: IsolationFilter): Promise<boolean> {
    if (recordIds.length > 0) await this.deleteWhere("l1", [this.hasIds(recordIds), ...isolation(filter)]);
    return true;
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    return this.deleteExpired("l1", "updated_time_ms", cutoffIso);
  }

  async countL1(filter?: L1CountFilter): Promise<number> {
    return this.count("l1", l1Filter(filter));
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    const must = [
      ...(filter?.recordIds?.length ? [this.hasIds(filter.recordIds)] : []),
      ...match({
        session_key: filter?.sessionKey,
        session_id: filter?.sessionId,
        task_id: filter?.taskId,
        team_id: filter?.teamId,
        user_id: filter?.userId,
        agent_id: filter?.agentId,
      }),
      ...range("updated_time_ms", { gt: filter?.updatedAfter === undefined ? undefined : isoToEpochMs(filter.updatedAfter) }),
    ];
    return (await this.find("l1", toFilter(must))).map((d) => docToL1RecordRow(d as unknown as L1Doc));
  }

  async getAllL1Texts(): Promise<Array<{ record_id: string; content: string; updated_time: string }>> {
    const docs = await this.find("l1", undefined, undefined, ["_id", "content", "updated_time"]);
    return docs.map((d) => ({ record_id: String(d._id), content: String(d.content ?? ""), updated_time: String(d.updated_time ?? "") }));
  }

  async queryL1Paginated(filter: L1PaginatedFilter): Promise<L1PaginatedResult> {
    const f = l1Filter(filter);
    const [docs, total] = await Promise.all([
      this.find("l1", f, { key: "updated_time_ms", desc: true, offset: filter.offset, limit: filter.limit }),
      this.count("l1", f),
    ]);
    return { rows: docs.map((d) => docToL1RecordRow(d as unknown as L1Doc)), total };
  }

  async searchL1Vector(queryEmbedding: Float32Array, topK = 10, _queryText?: string, filter?: IsolationFilter): Promise<L1SearchResult[]> {
    const dense = this.denseVector(queryEmbedding);
    if (!dense) return [];
    return (await this.denseSearch("l1", dense, topK, filter)).map(toL1Result);
  }

  async searchL1Fts(ftsQuery: string, limit = 10, filter?: IsolationFilter): Promise<L1FtsResult[]> {
    return (await this.sparseSearch("l1", encodeFtsQuery(ftsQuery), limit, filter)).map(bm25Normalized).map(toL1Result);
  }

  async searchL1Hybrid(params: HybridParams): Promise<L1SearchResult[]> {
    return (await this.hybridSearch("l1", params)).map(toL1Result);
  }

  async upsertL0(record: L0Record, embedding?: Float32Array): Promise<boolean> {
    await this.upsertMemory("l0", record.id, record.messageText, l0RecordToDoc(record), embedding);
    return true;
  }

  async insertL0Batch(records: L0Record[]): Promise<number> {
    if (records.length === 0) return 0;
    await this.ensureInit();
    const name = this.name("l0");
    const dup = records.find((r, i) => records.findIndex((o) => o.id === r.id) !== i);
    if (dup) throw new Error(`${TAG} insertL0Batch: duplicate record id ${dup.id}`);
    const [existing] = await this.client.retrieve(name, { ids: records.map((r) => this.pid(r.id)), with_payload: ["_id"] });
    if (existing) throw new Error(`${TAG} insertL0Batch: duplicate record id ${String(existing.payload?._id)}`);
    await this.client.upsert(name, {
      wait: true,
      update_mode: "insert_only",
      points: records.map((r) => this.memoryPoint(r.id, r.messageText, l0RecordToDoc(r))),
    });
    this.requestBackfill();
    return records.length;
  }

  async deleteL0(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    return (await this.deleteWhere("l0", [this.hasIds([recordId]), ...isolation(filter)])) > 0;
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    return this.deleteExpired("l0", "recorded_at_ms", cutoffIso);
  }

  async deleteL0BySession(sessionId: string, filter?: IsolationFilter): Promise<number> {
    return this.deleteWhere("l0", [...match({ session_id: sessionId }), ...isolation(filter)]);
  }

  async countL0(filter?: L0CountFilter): Promise<number> {
    return this.count("l0", l0Filter(filter));
  }

  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    const must = [...match({ session_key: sessionKey }), ...range("recorded_at_ms", { gt: afterRecordedAtMs || undefined })];
    const docs = await this.find("l0", { must }, { key: "recorded_at_ms", limit });
    return docs.map((d) => {
      const row = docToL0QueryRow(d as unknown as L0Doc);
      row.session_id = (row.session_id || "").trim() || DEFAULT_ISOLATION_ID;
      return row;
    });
  }

  async queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0SessionGroup[]> {
    return groupL0RowsBySession(await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit));
  }

  async getAllL0Texts(): Promise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    const docs = await this.find("l0", undefined, undefined, ["_id", "message_text", "recorded_at"]);
    return docs.map((d) => ({ record_id: String(d._id), message_text: String(d.message_text ?? ""), recorded_at: String(d.recorded_at ?? "") }));
  }

  async queryL0Paginated(filter: L0PaginatedFilter): Promise<L0PaginatedResult> {
    const f = l0Filter(filter);
    const [docs, total] = await Promise.all([
      this.find("l0", f, { key: "recorded_at_ms", desc: true, offset: filter.offset, limit: filter.limit }),
      this.count("l0", f),
    ]);
    return { rows: docs.map((d) => docToL0QueryRow(d as unknown as L0Doc)), total };
  }

  async searchL0Vector(queryEmbedding: Float32Array, topK = 10, _queryText?: string, filter?: IsolationFilter): Promise<L0SearchResult[]> {
    const dense = this.denseVector(queryEmbedding);
    if (!dense) return [];
    return (await this.denseSearch("l0", dense, topK, filter)).map(toL0Result);
  }

  async searchL0Fts(ftsQuery: string, limit = 10, filter?: IsolationFilter): Promise<L0FtsResult[]> {
    return (await this.sparseSearch("l0", encodeFtsQuery(ftsQuery), limit, filter)).map(bm25Normalized).map(toL0Result);
  }

  async searchL0Hybrid(params: HybridParams): Promise<L0SearchResult[]> {
    return (await this.hybridSearch("l0", params)).map(toL0Result);
  }

  private async query(kind: Kind, request: Omit<Schemas["QueryRequest"], "with_payload">): Promise<Hit[]> {
    await this.ensureInit();
    const res = await this.client.query(this.name(kind), { ...request, with_payload: true });
    return res.points.map((p) => ({ payload: p.payload ?? {}, score: p.score }));
  }

  private denseSearch(kind: Kind, dense: number[], topK: number, filter?: IsolationFilter): Promise<Hit[]> {
    return this.query(kind, { query: dense, using: this.dense, filter: this.scoped(toFilter(isolation(filter))), limit: Math.max(1, topK) });
  }

  private async sparseSearch(kind: Kind, sparse: QdrantSparseVector, limit: number, filter?: IsolationFilter): Promise<Hit[]> {
    if (sparse.indices.length === 0) return [];
    return this.query(kind, { query: sparse, using: SPARSE, filter: this.scoped(toFilter(isolation(filter))), limit: Math.max(1, limit) });
  }

  private async hybridSearch(kind: Kind, params: HybridParams): Promise<Hit[]> {
    const topK = Math.max(1, params.topK ?? 10);
    const text = params.query ?? "";
    let dense = this.denseVector(params.queryEmbedding);
    if (!dense && this.embedding && text) {
      try {
        const opts = this.queryEmbeddingTimeoutMs ? { timeoutMs: this.queryEmbeddingTimeoutMs } : undefined;
        dense = this.denseVector(await this.embedding.embed(text, opts));
      } catch (err) {
        this.logger?.warn?.(`${TAG} query embedding failed, using keyword only: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const sparse = encodeQuery(text);
    if (!dense) return (await this.sparseSearch(kind, sparse, topK, params.filter)).map(bm25Normalized);
    if (sparse.indices.length === 0) return this.denseSearch(kind, dense, topK, params.filter);
    const filter = this.scoped(toFilter(isolation(params.filter)));
    const candidates = Math.max(topK * 2, 20);
    return this.query(kind, {
      prefetch: [
        { query: dense, using: this.dense, filter, limit: candidates },
        { query: sparse, using: SPARSE, filter, limit: candidates },
      ],
      query: { rrf: { k: RRF_K } },
      filter,
      limit: topK,
    });
  }

  async reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    await this.ensureInit();
    if (!this.dims) return { l1Count: 0, l0Count: 0 };
    return this.embedPoints(this.scoped(), embedFn, undefined, onProgress);
  }

  async pullProfiles(): Promise<ProfileRecord[]> {
    return this.queryProfiles();
  }

  async queryProfilesByIds(ids: string[]): Promise<ProfileRecord[]> {
    return this.getRecords<ProfileRecord>("profiles", ids);
  }

  async queryProfiles(filter?: ProfileFilter): Promise<ProfileRecord[]> {
    const rows = (await this.find("profiles", profileFilter(filter))).map((p) => toRecord<ProfileRecord>(p));
    const prefix = filter?.pathPrefix;
    return prefix ? rows.filter((r) => r.filename.startsWith(prefix)) : rows;
  }

  async countProfiles(filter?: ProfileFilter): Promise<number> {
    return filter?.pathPrefix ? (await this.queryProfiles(filter)).length : this.count("profiles", profileFilter(filter));
  }

  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    for (const { baselineVersion, ...r } of records) {
      const record: ProfileRecord = { ...r, teamId: r.teamId ?? "", agentId: r.agentId ?? "", userId: r.userId ?? "", sessionId: r.sessionId ?? "" };
      if (baselineVersion === undefined) await this.putRecords("profiles", [[record.id, { ...record }]]);
      else await this.putProfileIfBaseline(record, baselineVersion);
    }
  }

  private async putProfileIfBaseline(record: ProfileRecord, baseline: number): Promise<void> {
    await this.ensureInit();
    const name = this.name("profiles");
    const id = this.pid(record.id);
    const conflict = () => new ProfileVersionConflictError(record.id, baseline, TAG);
    const tokensOf = async () => {
      const [p] = await this.client.retrieve(name, { ids: [id], with_payload: ["version", "_write_tokens"] });
      return p && { version: Number(p.payload?.version), tokens: (p.payload?._write_tokens as string[] | undefined) ?? [] };
    };
    const current = await tokensOf();
    if (current && current.version !== baseline) throw conflict();
    const token = randomUUID();
    await this.client.upsert(name, {
      wait: true,
      points: [{ id, vector: {}, payload: { ...record, [TENANT]: this.tenant, _write_tokens: [...(current?.tokens ?? []), token].slice(-16) } }],
      update_filter: { must: [{ key: "version", match: { value: baseline } }] },
    });
    if (!(await tokensOf())?.tokens.includes(token)) throw conflict();
  }

  async deleteProfiles(recordIds: string[]): Promise<void> {
    if (recordIds.length > 0) await this.deleteWhere("profiles", [this.hasIds(recordIds)]);
  }

  async clearMemoryContent(filter: MemoryContentClearFilter): Promise<MemoryContentClearResult> {
    if (!filter.teamId || !filter.agentId) {
      throw new Error(`${TAG} clearMemoryContent requires teamId + agentId (got team=${filter.teamId}, agent=${filter.agentId})`);
    }
    const scope = match({ team_id: filter.teamId, agent_id: filter.agentId, user_id: filter.userId });
    const profileScope = match({ teamId: filter.teamId, agentId: filter.agentId, userId: filter.userId });
    const [l0Deleted, l1Deleted, profilesDeleted] = await Promise.all([
      this.deleteWhere("l0", scope),
      this.deleteWhere("l1", scope),
      this.deleteWhere("profiles", profileScope),
    ]);
    return { l0Deleted, l1Deleted, profilesDeleted };
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.putRecords("audit", [[entry.audit_id, { ...entry }]]);
  }

  async queryAudit(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const must = [
      ...match({
        record_id: filter.record_id,
        layer: filter.layer,
        action: filter.action,
        team_id: filter.team_id,
        agent_id: filter.agent_id,
        user_id: filter.user_id,
        task_id: filter.task_id,
      }),
      ...range("updated_at_ms", { gte: filter.since_ms, lte: filter.until_ms }),
    ];
    const order = { key: "updated_at_ms", desc: true, offset: filter.offset, limit: Math.min(filter.limit ?? 100, 1000) };
    return (await this.find("audit", toFilter(must), order)).map((p) => toRecord<AuditEntry>(p));
  }

  private async putKnowledge(entity: KnowledgeEntity): Promise<KnowledgeEntity> {
    await this.putRecords("knowledge", [[entity.knowledge_id, { ...entity, _updated_ms: Date.parse(entity.updated_at) }]]);
    return entity;
  }

  async createKnowledge(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): Promise<KnowledgeEntity> {
    const now = new Date().toISOString();
    return this.putKnowledge({ ...input, created_at: now, updated_at: now });
  }

  async getKnowledge(knowledgeId: string): Promise<KnowledgeEntity | null> {
    return (await this.getRecords<KnowledgeEntity>("knowledge", [knowledgeId]))[0] ?? null;
  }

  async updateKnowledge(
    knowledgeId: string,
    patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>,
  ): Promise<KnowledgeEntity | null> {
    const current = await this.getKnowledge(knowledgeId);
    if (!current) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return this.putKnowledge({ ...current, ...defined, updated_at: new Date().toISOString() });
  }

  async deleteKnowledge(knowledgeIds: string[], teamId?: string): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of knowledgeIds) {
      if ((await this.deleteWhere("knowledge", [this.hasIds([id]), ...match({ team_id: teamId })])) > 0) result.deleted_ids.push(id);
      else result.failed.push({ id, reason: "not_found" });
    }
    return result;
  }

  async listKnowledge(input: {
    team_id: string;
    type?: KnowledgeType;
    knowledge_ids?: string[];
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeListResult> {
    const filter = {
      must: [...match({ team_id: input.team_id, type: input.type }), ...(input.knowledge_ids?.length ? [this.hasIds(input.knowledge_ids)] : [])],
    };
    const [docs, total] = await Promise.all([
      this.find("knowledge", filter, { key: "_updated_ms", desc: true, offset: input.offset, limit: input.limit ?? 100 }),
      this.count("knowledge", filter),
    ]);
    return { items: docs.map((p) => toRecord<KnowledgeEntity>(p)), total };
  }

  async upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]): Promise<void> {
    await this.putRecords("memory_generation_refs", records.map((r) => [r.generation_ref_id, { ...r }]));
  }

  async getMemoryGenerationRef(layer: MemoryGenerationLayer, memoryId: string): Promise<MemoryGenerationRefRecord | null> {
    const [ref] = await this.getRecords<MemoryGenerationRefRecord>("memory_generation_refs", [buildMemoryGenerationRefId(layer, memoryId)]);
    return ref && ref.memory_id === memoryId && ref.layer === layer ? ref : null;
  }

  async countMemoryPrompts(): Promise<number> {
    return this.count("memory_prompts");
  }

  async createMemoryPrompt(record: MemoryPromptRecord): Promise<MemoryPromptRecord> {
    await this.putRecords("memory_prompts", [[record.memory_prompt_id, { ...record }]]);
    return record;
  }

  async getMemoryPrompts(ids: string[]): Promise<MemoryPromptRecord[]> {
    return this.getRecords<MemoryPromptRecord>("memory_prompts", ids);
  }

  async listMemoryPrompts(filter: MemoryPromptListFilter): Promise<MemoryPromptRecord[]> {
    const docs = await this.find(
      "memory_prompts",
      { must: match({ status: "active", layer: filter.layer || undefined }) },
      { key: "updated_at_ms", desc: filter.timeOrder !== "asc", offset: Math.max(filter.offset ?? 0, 0), limit: pageLimit(filter.limit), tie: "memory_prompt_id" },
    );
    return docs.map((p) => toRecord<MemoryPromptRecord>(p));
  }

  async updateMemoryPrompt(
    id: string,
    patch: { name?: string; prompt?: string; updated_by?: string; updated_at_ms: number },
  ): Promise<MemoryPromptRecord | null> {
    const [current] = await this.getMemoryPrompts([id]);
    if (!current || current.status !== "active") return null;
    if ((patch.name ?? current.name) === current.name && (patch.prompt ?? current.prompt) === current.prompt) return current;
    return this.createMemoryPrompt({
      ...current,
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      updated_by: patch.updated_by,
      updated_at_ms: patch.updated_at_ms,
      version: current.version + 1,
    });
  }

  async getMemoryPromptSettings(ids: string[]): Promise<MemoryPromptSettingRecord[]> {
    return this.getRecords<MemoryPromptSettingRecord>("memory_prompt_settings", ids);
  }

  async listMemoryPromptSettings(filter: MemoryPromptSettingListFilter): Promise<MemoryPromptSettingRecord[]> {
    const must = match({
      memory_prompt_id: filter.memoryPromptId || undefined,
      target_type: filter.targetType || undefined,
      team_id: filter.teamId || undefined,
      agent_id: filter.agentId || undefined,
      layer: filter.layer || undefined,
    });
    const docs = await this.find(
      "memory_prompt_settings",
      toFilter(must),
      { key: "updated_at_ms", desc: filter.timeOrder !== "asc", offset: Math.max(filter.offset ?? 0, 0), limit: pageLimit(filter.limit), tie: "setting_id" },
    );
    return docs.map((p) => toRecord<MemoryPromptSettingRecord>(p));
  }

  async upsertMemoryPromptSettings(records: MemoryPromptSettingRecord[], logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    await this.putRecords("memory_prompt_settings", records.map((r) => [r.setting_id, { ...r }]));
    await this.putSettingLogs(logs);
  }

  async clearMemoryPromptSettings(ids: string[], logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    if (ids.length > 0) await this.deleteWhere("memory_prompt_settings", [this.hasIds(ids)]);
    await this.putSettingLogs(logs);
  }

  async deleteMemoryPrompts(ids: string[], operatorId?: string): Promise<{
    deleted_prompt_ids: string[];
    cleared_settings: Record<MemoryPromptTargetType, number>;
  }> {
    const cleared: Record<MemoryPromptTargetType, number> = { instance: 0, team: 0, agent: 0 };
    if ((await this.getMemoryPrompts(ids)).length !== ids.length) return { deleted_prompt_ids: [], cleared_settings: cleared };

    const now = Date.now();
    await this.client.setPayload(this.name("memory_prompts"), {
      wait: true,
      points: ids.map((id) => this.pid(id)),
      payload: { status: "deleting", updated_at_ms: now },
    });
    const settings = (await this.find("memory_prompt_settings", { must: [{ key: "memory_prompt_id", match: { any: ids } }] }))
      .map((p) => toRecord<MemoryPromptSettingRecord>(p));
    await this.putSettingLogs(settings.map((s) => {
      cleared[s.target_type] += 1;
      return {
        setting_log_id: `mpsl:delete:${s.setting_id}:${s.memory_prompt_id}`,
        target_type: s.target_type,
        team_id: s.team_id,
        agent_id: s.agent_id,
        layer: s.layer,
        action: "clear",
        reason: "prompt_deleted",
        before_memory_prompt_id: s.memory_prompt_id,
        operator_id: operatorId,
        operated_at_ms: now,
      };
    }));
    if (settings.length > 0) await this.deleteWhere("memory_prompt_settings", [this.hasIds(settings.map((s) => s.setting_id))]);
    await this.deleteWhere("memory_prompts", [this.hasIds(ids)]);
    return { deleted_prompt_ids: ids, cleared_settings: cleared };
  }

  async queryMemoryPromptSettingLogs(filter: MemoryPromptSettingLogFilter): Promise<MemoryPromptSettingLogRecord[]> {
    const must: Condition[] = [
      ...(filter.memoryPromptId
        ? [{ should: match({ before_memory_prompt_id: filter.memoryPromptId, after_memory_prompt_id: filter.memoryPromptId }) }]
        : []),
      ...match({ team_id: filter.teamId || undefined, agent_id: filter.agentId || undefined, action: filter.action || undefined }),
      ...range("operated_at_ms", { gte: filter.startTimeMs, lte: filter.endTimeMs }),
    ];
    const docs = await this.find(
      "memory_prompt_setting_logs",
      toFilter(must),
      { key: "operated_at_ms", desc: filter.timeOrder !== "asc", offset: Math.max(filter.offset ?? 0, 0), limit: pageLimit(filter.limit), tie: "setting_log_id" },
    );
    return docs.map((p) => toRecord<MemoryPromptSettingLogRecord>(p));
  }

  private async putSettingLogs(logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    await this.putRecords("memory_prompt_setting_logs", logs.map((l) => [l.setting_log_id, { ...l }]));
  }
}

async function tolerateRace(create: () => Promise<unknown>, created: () => Promise<boolean>): Promise<void> {
  try {
    await create();
  } catch (err) {
    if (!(await created())) throw err;
  }
}

function textHash(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function toRecord<T>(payload: Payload): T {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !k.startsWith("_"))) as T;
}

function match(fields: Record<string, string | undefined>): Condition[] {
  return Object.entries(fields)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([key, value]) => ({ key, match: { value } }));
}

function range(key: string, bounds: { gt?: number; gte?: number; lte?: number }): Condition[] {
  const defined = Object.fromEntries(Object.entries(bounds).filter(([, v]) => v !== undefined));
  return Object.keys(defined).length > 0 ? [{ key, range: defined }] : [];
}

function toFilter(must: Condition[]): Filter | undefined {
  return must.length > 0 ? { must } : undefined;
}

function pageLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 20, 1), 100);
}

function isolation(f: IsolationFilter | undefined): Condition[] {
  return match({
    team_id: f?.teamId,
    user_id: f?.userId,
    agent_id: f?.agentId,
    session_id: f?.sessionId,
    task_id: f?.taskId,
    session_key: f?.sessionKey,
  });
}

function l1Filter(f: L1CountFilter | undefined): Filter | undefined {
  return toFilter([
    ...match({ type: f?.type, session_id: f?.sessionId, team_id: f?.teamId, user_id: f?.userId, agent_id: f?.agentId, task_id: f?.taskId }),
    ...range("updated_time_ms", {
      gte: f?.timeStart === undefined ? undefined : isoToEpochMs(f.timeStart),
      lte: f?.timeEnd === undefined ? undefined : isoToEpochMs(f.timeEnd),
    }),
  ]);
}

function l0Filter(f: L0CountFilter | undefined): Filter | undefined {
  return toFilter([
    ...match({ session_id: f?.sessionId, team_id: f?.teamId, user_id: f?.userId, agent_id: f?.agentId, task_id: f?.taskId }),
    ...range("timestamp", { gte: f?.timeStartMs, lte: f?.timeEndMs }),
  ]);
}

function profileFilter(f: ProfileFilter | undefined): Filter | undefined {
  return toFilter(match({ type: f?.type, teamId: f?.teamId, userId: f?.userId, agentId: f?.agentId }));
}

function bm25Normalized(hit: Hit): Hit {
  return { ...hit, score: mongoSearchScoreToScore(hit.score) };
}

function toL1Result(hit: Hit): L1SearchResult {
  return docToL1SearchResult(hit.payload as unknown as L1Doc, hit.score);
}

function toL0Result(hit: Hit): L0SearchResult {
  return docToL0SearchResult(hit.payload as unknown as L0Doc, hit.score);
}
