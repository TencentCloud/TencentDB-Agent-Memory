/**
 * HTTP client for the Knowledge Service (team wikis).
 *
 * The Knowledge Service is a separate HTTP service from the memory Gateway.
 * Every request is a JSON POST carrying the tenant identity in the body and
 * the instance id in the `x-tdai-service-id` header; every response is an
 * envelope `{ code, message, request_id?, data }` where `code === 0` is success.
 * Wiki ids are always parameters, never defaults.
 */

export interface KnowledgeServiceOptions {
  baseUrl: string;
  apiKey?: string;
  serviceId: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface KnowledgeEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

export class KnowledgeServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly serviceId: string;
  private readonly identity: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: KnowledgeServiceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.serviceId = options.serviceId;
    this.identity = {};
    if (options.teamId) this.identity.team_id = options.teamId;
    if (options.userId) this.identity.user_id = options.userId;
    if (options.agentId) this.identity.agent_id = options.agentId;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

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
      if (envelope === null || typeof envelope !== "object") return envelope as T;
      if (envelope.code !== undefined && envelope.code !== 0) {
        const requestId = envelope.request_id ? ` (${envelope.request_id})` : "";
        throw new Error(`Knowledge ${pathname} error ${envelope.code}: ${envelope.message ?? "unknown error"}${requestId}`);
      }
      return ("data" in envelope ? envelope.data : envelope) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export interface WikiPageWrite {
  ref: string;
  content: string;
}

export const WIKI_PAGE_BATCH_LIMIT = 20;

export interface KnowledgeTools {
  listWikis(input?: { limit?: number }): Promise<unknown>;
  searchWiki(input: { wikiId: string; query: string; limit?: number }): Promise<unknown>;
  listWikiPages(input: { wikiId: string; limit?: number }): Promise<unknown>;
  readWikiPages(input: { wikiId: string; refs: string[] }): Promise<unknown>;
  writeWikiPages(input: { wikiId: string; pages: WikiPageWrite[] }): Promise<unknown>;
}

function clampLimit(value: number | undefined, fallback: number, max = 100): number {
  return Math.min(max, Math.max(1, Math.trunc(value ?? fallback)));
}

function assertBatch(kind: string, count: number): void {
  if (count > WIKI_PAGE_BATCH_LIMIT) {
    throw new Error(`${kind}: ${count} given, max is ${WIKI_PAGE_BATCH_LIMIT}; split into multiple calls`);
  }
}

export function createKnowledgeTools(options: KnowledgeServiceOptions): KnowledgeTools {
  const knowledge = new KnowledgeServiceClient(options);
  return {
    listWikis(input = {}) {
      return knowledge.post("/v3/wiki/list", { limit: clampLimit(input.limit, 20) });
    },
    searchWiki(input) {
      return knowledge.post("/v3/wiki/search", { wiki_id: input.wikiId, query: input.query, limit: clampLimit(input.limit, 20) });
    },
    listWikiPages(input) {
      return knowledge.post("/v3/wiki/page/ls", { wiki_id: input.wikiId, limit: clampLimit(input.limit, 20) });
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
