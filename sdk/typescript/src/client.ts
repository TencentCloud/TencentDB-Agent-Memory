/**
 * TencentDB Agent Memory v2 TypeScript SDK — `MemoryClient`.
 *
 * 18 methods mapping 1:1 to the v2 data-plane API.
 */

import { HttpTransport, type HttpTransportOptions } from "./http.js";
import { MemoryFileReader, createMemoryFileReader } from "./cos.js";
import type {
  AtomicUpdateData,
  AtomicUpdateRequest,
  AtomicDeleteData,
  AtomicQueryData,
  AtomicQueryRequest,
  AtomicSearchData,
  AtomicSearchRequest,
  ConversationAddData,
  ConversationAddRequest,
  ConversationDeleteData,
  ConversationDeleteRequest,
  ConversationQueryData,
  ConversationQueryRequest,
  ConversationSearchData,
  ConversationSearchRequest,
  CoreFile,
  CoreWriteData,
  CoreWriteRequest,
  OffloadCompactData,
  OffloadCompactRequest,
  OffloadIngestData,
  OffloadIngestRequest,
  OffloadReadRefData,
  OffloadReadRefRequest,
  OffloadQueryMmdData,
  OffloadQueryMmdRequest,
  ScenarioFile,
  ScenarioListData,
  ScenarioListRequest,
  ScenarioReadRequest,
  ScenarioRmRequest,
  ScenarioWriteData,
  ScenarioWriteRequest,
} from "./types.js";

const V2 = "/v2";

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export interface MemoryClientConfig {
  /** Base URL, e.g. `https://memory.tencentyun.com` */
  endpoint: string;
  /** Bearer token */
  apiKey: string;
  /** Memory instance ID (sent via `x-tdai-service-id` header). */
  serviceId: string;
  /** Request timeout in ms (default 30 000). */
  timeout?: number;
  /** Whether to reject invalid TLS certificates. Default: false (self-signed friendly). */
  rejectUnauthorized?: boolean;
}

/**
 * Transport interface for testing — inject a mock that satisfies this.
 */
export interface Transport {
  post<T>(path: string, body?: Record<string, unknown>): Promise<T>;
}

export class MemoryClient {
  private readonly http: Transport;
  private readonly config: MemoryClientConfig | null;

  constructor(config: MemoryClientConfig);
  constructor(transport: Transport);
  constructor(configOrTransport: MemoryClientConfig | Transport) {
    if ("post" in configOrTransport) {
      this.http = configOrTransport;
      this.config = null;
    } else {
      const cfg = configOrTransport;
      if (!cfg.serviceId) throw new Error("serviceId must be provided");
      this.config = cfg;
      this.http = new HttpTransport({
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        serviceId: cfg.serviceId,
        timeout: cfg.timeout,
        rejectUnauthorized: cfg.rejectUnauthorized,
      });
    }
  }

  // -- L0 Conversation ---------------------------------------------------

  addConversation(params: ConversationAddRequest): Promise<ConversationAddData> {
    return this.http.post(`${V2}/conversation/add`, params as unknown as Record<string, unknown>);
  }

  queryConversation(params: ConversationQueryRequest = {}): Promise<ConversationQueryData> {
    return this.http.post(`${V2}/conversation/query`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  searchConversation(params: ConversationSearchRequest): Promise<ConversationSearchData> {
    return this.http.post(`${V2}/conversation/search`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  deleteConversation(params: ConversationDeleteRequest): Promise<ConversationDeleteData> {
    return this.http.post(`${V2}/conversation/delete`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  // -- L1 Atomic ---------------------------------------------------------

  updateAtomic(params: AtomicUpdateRequest): Promise<AtomicUpdateData> {
    return this.http.post(`${V2}/atomic/update`, params as unknown as Record<string, unknown>);
  }

  queryAtomic(params: AtomicQueryRequest = {}): Promise<AtomicQueryData> {
    return this.http.post(`${V2}/atomic/query`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  searchAtomic(params: AtomicSearchRequest): Promise<AtomicSearchData> {
    return this.http.post(`${V2}/atomic/search`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  deleteAtomic(params: { ids: string[] }): Promise<AtomicDeleteData> {
    return this.http.post(`${V2}/atomic/delete`, params as unknown as Record<string, unknown>);
  }

  // -- L2 Scenario -------------------------------------------------------

  listScenarios(params: ScenarioListRequest = {}): Promise<ScenarioListData> {
    return this.http.post(`${V2}/scenario/ls`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  readScenario(params: ScenarioReadRequest): Promise<ScenarioFile> {
    return this.http.post(`${V2}/scenario/read`, params as unknown as Record<string, unknown>);
  }

  writeScenario(params: ScenarioWriteRequest): Promise<ScenarioWriteData> {
    return this.http.post(`${V2}/scenario/write`, params as unknown as Record<string, unknown>);
  }

  rmScenario(params: ScenarioRmRequest): Promise<void> {
    return this.http.post(`${V2}/scenario/rm`, params as unknown as Record<string, unknown>);
  }

  // -- L3 Core ------------------------------------------------------------

  readCore(): Promise<CoreFile> {
    return this.http.post(`${V2}/core/read`, {});
  }

  writeCore(params: CoreWriteRequest): Promise<CoreWriteData> {
    return this.http.post(`${V2}/core/write`, params as unknown as Record<string, unknown>);
  }

  // -- Offload -----------------------------------------------------------

  /**
   * Send tool pairs (+ optional context) to offload server for L1 processing.
   * Fire-and-forget usage: caller can `.catch()` without blocking.
   */
  offloadIngest(params: OffloadIngestRequest): Promise<OffloadIngestData> {
    return this.http.post(`${V2}/offload/ingest`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  /**
   * Request server-side context compaction.
   * Returns compacted messages + report, or throws on failure.
   */
  offloadCompact(params: OffloadCompactRequest): Promise<OffloadCompactData> {
    return this.http.post(`${V2}/offload/compact`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  /**
   * Recover an archived tool result referenced by a compacted message.
   */
  offloadReadRef(params: OffloadReadRefRequest): Promise<OffloadReadRefData> {
    return this.http.post(`${V2}/offload/read-ref`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  /**
   * Query MMD task graphs for a session.
   * limit=1 returns only the current active MMD (fast path).
   */
  offloadQueryMmd(params: OffloadQueryMmdRequest): Promise<OffloadQueryMmdData> {
    return this.http.post(`${V2}/offload/query-mmd`, stripUndefined(params as unknown as Record<string, unknown>));
  }

  // -- File read (memory pipeline artifacts) ----------------------------

  /**
   * Read a memory pipeline artifact (e.g. `persona.md`, `scene_blocks/*.md`)
   * by relative path.
   *
   * @param path Relative path within the memory space, e.g.
   *   `"scene_blocks/cooking-recipes.md"` or `"persona.md"`.
   * @returns File content as string.
   */
  async readFile(path: string): Promise<string> {
    if (!this.fileReader) {
      if (!this.config) {
        throw new Error("readFile requires MemoryClient to be constructed with config (endpoint/apiKey/serviceId), not a raw Transport");
      }
      this.fileReader = createMemoryFileReader({
        endpoint: this.config.endpoint,
        apiKey: this.config.apiKey,
        serviceId: this.config.serviceId!,
      });
    }
    return this.fileReader.read(path);
  }

  private fileReader: MemoryFileReader | null = null;
}
