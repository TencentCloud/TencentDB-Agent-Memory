/**
 * HTTP client for the TencentDB Agent Memory Knowledge Service (team wikis).
 *
 * The Knowledge Service is a separate HTTP service from the memory Gateway.
 * Every request is a JSON POST carrying the tenant identity in the body and
 * the service id in a header, and every response is an envelope
 * `{ code, message, request_id?, data }` where `code === 0` means success.
 *
 * This client is deliberately organisation-agnostic: wiki ids are always
 * parameters, never defaults, and every identity value comes from options or
 * environment variables.
 */

export interface KnowledgeServiceOptions {
  /** Base URL of the Knowledge Service. Defaults to `TDAI_KNOWLEDGE_URL` or `http://127.0.0.1:8424`. */
  baseUrl?: string;
  /** Optional Bearer token. Defaults to `TDAI_KNOWLEDGE_API_KEY`, then `TDAI_GATEWAY_API_KEY`. */
  apiKey?: string;
  /** Sent as the `x-tdai-service-id` header. Defaults to `TDAI_SERVICE_ID` or `default`. */
  serviceId?: string;
  /** Tenant identity sent in every request body. Default to `TDAI_TEAM_ID`, `TDAI_USER_ID`, `TDAI_AGENT_ID`. */
  teamId?: string;
  userId?: string;
  agentId?: string;
  /** Per-request timeout. Defaults to `TDAI_KNOWLEDGE_TIMEOUT_MS` or 15000. Wiki writes and cold stores are slower than Gateway calls. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface KnowledgeEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class KnowledgeServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly serviceId: string;
  private readonly identity: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: KnowledgeServiceOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.TDAI_KNOWLEDGE_URL ?? "http://127.0.0.1:8424").replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.TDAI_KNOWLEDGE_API_KEY ?? process.env.TDAI_GATEWAY_API_KEY;
    this.serviceId = options.serviceId ?? process.env.TDAI_SERVICE_ID ?? "default";
    this.identity = {};
    const teamId = options.teamId ?? process.env.TDAI_TEAM_ID;
    const userId = options.userId ?? process.env.TDAI_USER_ID;
    const agentId = options.agentId ?? process.env.TDAI_AGENT_ID;
    if (teamId) this.identity.team_id = teamId;
    if (userId) this.identity.user_id = userId;
    if (agentId) this.identity.agent_id = agentId;
    this.timeoutMs = options.timeoutMs ?? positiveInteger(process.env.TDAI_KNOWLEDGE_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** POST to the Knowledge Service and unwrap the `{ code, data }` envelope. */
  async post<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": this.serviceId,
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...this.identity, ...body }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Knowledge ${pathname} returned HTTP ${response.status}`);
      }
      const envelope = await response.json() as KnowledgeEnvelope<T> | null;
      if (envelope === null || typeof envelope !== "object") {
        return envelope as T;
      }
      if (envelope.code !== undefined && envelope.code !== 0) {
        const requestId = envelope.request_id ? ` (${envelope.request_id})` : "";
        throw new Error(`Knowledge ${pathname} error ${envelope.code}: ${envelope.message ?? "unknown error"}${requestId}`);
      }
      // A present `data` key (even `null`) is the payload; otherwise the body itself is.
      return ("data" in envelope ? envelope.data : envelope) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export interface ListWikisInput {
  limit?: number;
}

export interface SearchWikiInput {
  wikiId: string;
  query: string;
  limit?: number;
}

export interface ListWikiPagesInput {
  wikiId: string;
  limit?: number;
}

export interface ReadWikiPagesInput {
  wikiId: string;
  refs: string[];
}

export interface WikiPageWrite {
  ref: string;
  content: string;
}

export interface WriteWikiPagesInput {
  wikiId: string;
  pages: WikiPageWrite[];
}

/** Maximum refs per read and pages per write accepted by the Knowledge Service. */
export const WIKI_PAGE_BATCH_LIMIT = 20;

export interface KnowledgeClient {
  listWikis(input?: ListWikisInput): Promise<unknown>;
  searchWiki(input: SearchWikiInput): Promise<unknown>;
  listWikiPages(input: ListWikiPagesInput): Promise<unknown>;
  readWikiPages(input: ReadWikiPagesInput): Promise<unknown>;
  writeWikiPages(input: WriteWikiPagesInput): Promise<unknown>;
}

function clampLimit(value: number | undefined, fallback: number, max = 100): number {
  return Math.min(max, Math.max(1, Math.trunc(value ?? fallback)));
}

function assertBatch(kind: string, count: number): void {
  if (count > WIKI_PAGE_BATCH_LIMIT) {
    throw new Error(`${kind}: ${count} given, max is ${WIKI_PAGE_BATCH_LIMIT}; split into multiple calls`);
  }
}

export function createKnowledgeTools(options: KnowledgeServiceOptions = {}): KnowledgeClient {
  const knowledge = new KnowledgeServiceClient(options);

  return {
    listWikis(input = {}) {
      return knowledge.post("/v3/wiki/list", { limit: clampLimit(input.limit, 20) });
    },

    searchWiki(input) {
      return knowledge.post("/v3/wiki/search", {
        wiki_id: input.wikiId,
        query: input.query,
        limit: clampLimit(input.limit, 20),
      });
    },

    listWikiPages(input) {
      return knowledge.post("/v3/wiki/page/ls", {
        wiki_id: input.wikiId,
        limit: clampLimit(input.limit, 20),
      });
    },

    async readWikiPages(input) {
      assertBatch("wiki page read", input.refs.length);
      return knowledge.post("/v3/wiki/page/read", { wiki_id: input.wikiId, refs: input.refs });
    },

    async writeWikiPages(input) {
      assertBatch("wiki page write", input.pages.length);
      return knowledge.post("/v3/wiki/page/write", { wiki_id: input.wikiId, pages: input.pages });
    },
  };
}

export type KnowledgeTools = KnowledgeClient;
