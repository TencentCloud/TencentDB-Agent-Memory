import { createHash } from "node:crypto";
import { Agent } from "undici";
import {
  MemoryClient,
  type Transport,
} from "@tencentdb-agent-memory/memory-sdk-ts-v2";

type ServerConfig = {
  url?: string;
  apiKey?: string;
  instanceId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  rejectUnauthorized?: boolean;
};

type PluginConfig = { server?: ServerConfig };
type MemoryAuthority =
  | { kind: "operator"; scopes: readonly string[]; connId?: string }
  | {
      kind: "session";
      sessionKey: string;
      sessionId?: string;
      sandboxed: boolean;
      audience?:
        | { kind: "owner-private"; agentId: string }
        | { kind: "conversation"; agentId: string; sessionKey: string; sessionId: string };
    }
  | { kind: "host"; operation: string };

type MemoryCallerContext = {
  authority: MemoryAuthority;
  assertCurrent(): void;
  signal?: AbortSignal;
};

type OpenParams = {
  cfg: Record<string, unknown>;
  agentId: string;
  context: MemoryCallerContext;
  purpose?: "default" | "status" | "cli";
};

type SearchRequest = {
  query: string;
  maxResults?: number;
  minScore?: number;
  cursor?: string;
  sources?: Array<"memory" | "sessions">;
  lexicalOnly?: boolean;
  activeProjectKeys?: readonly string[];
};

type GetRequest = {
  reference: { providerId: string; id: string; revision?: string; fragment?: string };
  from?: number;
  lines?: number;
};

type SearchHit = {
  reference: { providerId: string; id: string };
  excerpt: string;
  score?: number;
  source: "memory" | "sessions";
  citations?: Array<{ label: string; reference: { providerId: string; id: string } }>;
};

type SearchPage = {
  hits: SearchHit[];
  coverage?: "complete" | "partial";
  warning?: string;
};

type CachedReference = {
  source: "memory" | "sessions";
  query: string;
  limit: number;
  rawId: string;
  fallbackId?: string;
  label: string;
};

type ProviderHandle = {
  capabilities: {
    sources: readonly ("memory" | "sessions")[];
    pagination: boolean;
    candidates: readonly ("trigger" | "project")[];
    projectFilter: boolean;
  };
  search(request: SearchRequest): Promise<SearchPage>;
  get(request: GetRequest): Promise<{
    status: "ok";
    reference: { providerId: string; id: string };
    text: string;
    citations?: Array<{ label: string; reference: { providerId: string; id: string } }>;
    truncated?: boolean;
    from?: number;
    lines?: number;
    nextFrom?: number;
  } | { status: "not_found" }>;
  health(): Promise<{ status: "ready" | "degraded" | "unavailable"; message?: string }>;
  close(): Promise<void>;
};

type ScopedTransportOptions = {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  signal: AbortSignal;
  assertActive(): void;
  dispatcher?: Agent;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_CACHED_REFERENCES = 500;
const MAX_EXCERPT_CHARS = 1_200;
const MAX_GET_LINES = 200;
const MAX_GET_CHARS = 64_000;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function boundedLimit(value: unknown, fallback = 10): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(value)));
}

function makeTransport(options: ScopedTransportOptions): Transport {
  return {
    async post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
      options.assertActive();
      const url = `${options.endpoint.replace(/\/+$/, "")}${path}`;
      const fetchOptions: RequestInit & { dispatcher?: Agent } = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "x-tdai-service-id": options.serviceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: options.signal,
      };
      if (options.dispatcher) fetchOptions.dispatcher = options.dispatcher;

      const response = await fetch(url, fetchOptions as RequestInit);
      options.assertActive();
      let envelope: { code?: number; message?: string; request_id?: string; data?: T };
      try {
        envelope = await response.json() as typeof envelope;
      } catch {
        throw new Error(
          response.ok
            ? "Memory Gateway returned an invalid JSON response"
            : `Memory Gateway request failed (HTTP ${response.status})`,
        );
      }
      options.assertActive();
      if (!response.ok || envelope.code !== 0) {
        const message = nonEmpty(envelope.message) ?? `HTTP ${response.status}`;
        const requestId = nonEmpty(envelope.request_id);
        throw new Error(requestId ? `${message} (request ${requestId})` : message);
      }
      return (envelope.data ?? {}) as T;
    },
  };
}

function textPage(text: string, from?: number, lines?: number) {
  const allLines = text.split(/\r?\n/);
  const requestedFrom = typeof from === "number" && Number.isFinite(from) ? Math.floor(from) : 1;
  const requestedCount = typeof lines === "number" && Number.isFinite(lines)
    ? Math.floor(lines)
    : MAX_GET_LINES;
  const start = Math.max(0, requestedFrom - 1);
  const requestedLines = Math.max(1, Math.min(MAX_GET_LINES, requestedCount));
  const selected = allLines.slice(start, start + requestedLines);
  let resultText = selected.join("\n");
  let characterTruncated = false;
  if (resultText.length > MAX_GET_CHARS) {
    resultText = resultText.slice(0, MAX_GET_CHARS);
    characterTruncated = true;
  }
  const nextFrom = start + selected.length + 1;
  const lineTruncated = start + selected.length < allLines.length;
  return {
    text: resultText,
    from: start + 1,
    lines: selected.length,
    truncated: characterTruncated || lineTruncated,
    ...(!characterTruncated && lineTruncated ? { nextFrom } : {}),
  };
}

function fallbackConversationId(message: {
  role?: string;
  timestamp?: string;
  content?: string;
}): string {
  return digest(`${message.role ?? ""}\0${message.timestamp ?? ""}\0${message.content ?? ""}`);
}

function resolveCallerScope(params: OpenParams, config: PluginConfig) {
  params.context.assertCurrent();
  params.context.signal?.throwIfAborted();

  const hostAgentId = nonEmpty(params.agentId);
  if (!hostAgentId) {
    return { error: "OpenClaw did not provide an agent scope" } as const;
  }

  const authority = params.context.authority;
  let sessionId: string | undefined;
  let canSearchSessions = false;
  let canSearch = authority.kind !== "host";

  if (authority.kind === "session") {
    const audience = authority.audience;
    if (!audience || audience.agentId !== hostAgentId) {
      return { error: "a current host-minted memory audience is required" } as const;
    }
    if (audience.kind === "conversation") {
      const audienceSessionId = nonEmpty(audience.sessionId);
      const audienceSessionKey = nonEmpty(audience.sessionKey);
      if (
        !audienceSessionId ||
        !audienceSessionKey ||
        (nonEmpty(authority.sessionId) && authority.sessionId !== audienceSessionId) ||
        authority.sessionKey !== audienceSessionKey
      ) {
        return { error: "the memory audience does not match the current session" } as const;
      }
      sessionId = audienceSessionId;
      canSearchSessions = true;
    }
  }

  const server = config.server ?? {};
  const teamId = nonEmpty(server.teamId);
  const userId = nonEmpty(server.userId);
  // The host resolves the active agent for every open(). A static plugin
  // setting must never collapse multiple OpenClaw agents into one Gateway ID.
  const agentId = hostAgentId;
  const endpoint = nonEmpty(server.url);
  const apiKey = nonEmpty(server.apiKey);
  const serviceId = nonEmpty(server.instanceId);
  if (!teamId || !userId || !agentId || !endpoint || !apiKey || !serviceId) {
    return { error: "server URL, API key, instance, and isolation IDs must be configured" } as const;
  }

  let isHttps: boolean;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "server URL must use HTTP or HTTPS" } as const;
    }
    isHttps = parsed.protocol === "https:";
  } catch {
    return { error: "server URL must be a valid HTTP(S) URL" } as const;
  }

  return {
    scope: { teamId, agentId, userId, sessionId },
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    serviceId,
    rejectUnauthorized: server.rejectUnauthorized !== false,
    isHttps,
    canSearchSessions,
    canSearch,
  } as const;
}

/**
 * Native OpenClaw provider-runtime adapter. Each open() creates a caller-bound
 * lease and each operation uses the official v3 SDK over an abort-aware transport.
 */
export function createNativeMemoryProviderRuntime(pluginId: string, config: PluginConfig) {
  const openHandles = new Map<string, Set<() => Promise<void>>>();

  return {
    async open(params: OpenParams): Promise<{ provider: ProviderHandle | null; error?: string }> {
      const resolved = resolveCallerScope(params, config);
      if ("error" in resolved) {
        return { provider: null, error: resolved.error };
      }

      const { scope, endpoint, apiKey, serviceId } = resolved;
      const dispatcher =
        !resolved.rejectUnauthorized && resolved.isHttps
          ? new Agent({ connect: { rejectUnauthorized: false } })
          : undefined;
      const controllers = new Set<AbortController>();
      const references = new Map<string, CachedReference>();
      let closed = false;
      let inflight = 0;
      let drained: (() => void) | undefined;
      const handlesForAgent = openHandles.get(params.agentId) ?? new Set<() => Promise<void>>();
      openHandles.set(params.agentId, handlesForAgent);

      const assertCurrent = (controller?: AbortController) => {
        if (closed) throw new Error("memory provider handle is closed");
        params.context.assertCurrent();
        controller?.signal.throwIfAborted();
      };

      const withOperation = async <T>(
        run: (client: MemoryClient, assertActive: () => void) => Promise<T>,
        timeoutMs = DEFAULT_TIMEOUT_MS,
      ): Promise<T> => {
        if (closed) throw new Error("memory provider handle is closed");
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(params.context.signal?.reason);
        if (params.context.signal?.aborted) {
          abortFromCaller();
        } else {
          params.context.signal?.addEventListener("abort", abortFromCaller, { once: true });
        }
        const timer = setTimeout(
          () => controller.abort(new Error("memory provider request deadline exceeded")),
          timeoutMs,
        );
        controllers.add(controller);
        inflight += 1;
        const assertActive = () => assertCurrent(controller);
        try {
          assertActive();
          const client = new MemoryClient(
            makeTransport({
              endpoint,
              apiKey,
              serviceId,
              signal: controller.signal,
              assertActive,
              dispatcher,
            }),
            {
              team_id: scope.teamId,
              agent_id: scope.agentId,
              user_id: scope.userId,
              ...(scope.sessionId ? { session_id: scope.sessionId } : {}),
            },
          );
          const result = await run(client, assertActive);
          assertActive();
          return result;
        } finally {
          clearTimeout(timer);
          params.context.signal?.removeEventListener("abort", abortFromCaller);
          controllers.delete(controller);
          inflight -= 1;
          if (closed && inflight === 0) drained?.();
        }
      };

      const assertReadable = () => {
        if (!resolved.canSearch) {
          throw new Error("host status authority may check health but cannot search or read memory");
        }
      };

      const sourceList: readonly ("memory" | "sessions")[] = resolved.canSearchSessions
        ? ["memory", "sessions"]
        : ["memory"];

      let provider!: ProviderHandle;
      const close = async () => {
        if (closed) return;
        closed = true;
        references.clear();
        for (const controller of controllers) {
          controller.abort(new Error("memory provider handle is closed"));
        }
        if (inflight > 0) {
          await new Promise<void>((resolve) => {
            drained = resolve;
          });
        }
        await dispatcher?.close();
        handlesForAgent.delete(close);
        if (handlesForAgent.size === 0) openHandles.delete(params.agentId);
      };

      const remember = (id: string, entry: CachedReference) => {
        references.set(id, entry);
        while (references.size > MAX_CACHED_REFERENCES) {
          const oldest = references.keys().next().value as string | undefined;
          if (!oldest) break;
          references.delete(oldest);
        }
      };

      const searchSource = async (
        client: MemoryClient,
        source: "memory" | "sessions",
        query: string,
        limit: number,
      ): Promise<SearchHit[]> => {
        if (source === "memory") {
          const result = await client.searchAtomic({ query, limit });
          return (result.items ?? []).flatMap((item): SearchHit[] => {
            const rawId = nonEmpty(item.id);
            if (!rawId) return [];
            const id = `memory:${digest(rawId)}`;
            const label = `L1 memory (${item.type || "entry"})`;
            remember(id, { source, query, limit, rawId, label });
            return [{
              reference: { providerId: pluginId, id },
              excerpt: String(item.content ?? "").slice(0, MAX_EXCERPT_CHARS),
              score: item.score,
              source,
              citations: [{ label, reference: { providerId: pluginId, id } }],
            }];
          });
        }

        const result = await client.searchConversation({ query, limit });
        return (result.messages ?? []).map((message): SearchHit => {
          const rawId = nonEmpty(message.id) ?? fallbackConversationId(message);
          const id = `session:${digest(rawId)}`;
          const label = message.timestamp
            ? `Conversation message (${message.timestamp})`
            : "Conversation message";
          remember(id, {
            source,
            query,
            limit,
            rawId,
            ...(!nonEmpty(message.id) ? { fallbackId: fallbackConversationId(message) } : {}),
            label,
          });
          return {
            reference: { providerId: pluginId, id },
            excerpt: String(message.content ?? "").slice(0, MAX_EXCERPT_CHARS),
            score: message.score,
            source,
            citations: [{ label, reference: { providerId: pluginId, id } }],
          };
        });
      };

      provider = {
        capabilities: {
          sources: sourceList,
          pagination: false,
          candidates: [],
          projectFilter: false,
        },
        async search(request) {
          assertReadable();
          if (request.cursor !== undefined) {
            throw new Error("TencentDB memory search does not support pagination cursors");
          }
          if (request.activeProjectKeys?.length) {
            throw new Error("TencentDB memory search does not support project filtering");
          }
          const requestedSources = [...new Set(request.sources ?? [...sourceList])];
          const unsupported = requestedSources.find((source) => !sourceList.includes(source));
          if (unsupported) {
            throw new Error(`TencentDB memory search does not support the ${unsupported} source for this caller`);
          }
          const query = request.query.trim();
          if (!query || requestedSources.length === 0) {
            return { hits: [], coverage: "complete" };
          }

          const limit = boundedLimit(request.maxResults);
          return withOperation(async (client, assertActive) => {
            const settled = await Promise.allSettled(
              requestedSources.map((source) => searchSource(client, source, query, limit)),
            );
            assertActive();
            const fulfilled = settled.filter(
              (result): result is PromiseFulfilledResult<SearchHit[]> => result.status === "fulfilled",
            );
            if (fulfilled.length === 0) {
              const failure = settled.find(
                (result): result is PromiseRejectedResult => result.status === "rejected",
              );
              throw failure?.reason ?? new Error("Memory Gateway search failed");
            }
            const minScore = typeof request.minScore === "number" ? request.minScore : undefined;
            const hits = fulfilled
              .flatMap((result) => result.value)
              .filter((hit) => minScore === undefined || (hit.score ?? -Infinity) >= minScore)
              .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
              .slice(0, limit);
            return {
              hits,
              coverage: fulfilled.length === settled.length ? "complete" : "partial",
              ...(fulfilled.length !== settled.length
                ? { warning: "One or more configured memory sources could not be searched." }
                : {}),
            };
          });
        },
        async get(request) {
          assertReadable();
          if (closed) throw new Error("memory provider handle is closed");
          if (request.reference.providerId !== pluginId) {
            throw new Error("memory reference belongs to a different provider");
          }
          const cached = references.get(request.reference.id);
          if (!cached) return { status: "not_found" };

          return withOperation(async (client, assertActive) => {
            if (cached.source === "memory") {
              const result = await client.searchAtomic({ query: cached.query, limit: cached.limit });
              assertActive();
              const item = (result.items ?? []).find((candidate) => candidate.id === cached.rawId);
              if (!item) return { status: "not_found" };
              const page = textPage(String(item.content ?? ""), request.from, request.lines);
              return {
                status: "ok",
                reference: request.reference,
                ...page,
                citations: [{ label: cached.label, reference: request.reference }],
              };
            }

            const result = await client.searchConversation({ query: cached.query, limit: cached.limit });
            assertActive();
            const message = (result.messages ?? []).find((candidate) => {
              const id = nonEmpty(candidate.id);
              return id
                ? id === cached.rawId
                : fallbackConversationId(candidate) === cached.fallbackId;
            });
            if (!message) return { status: "not_found" };
            const page = textPage(String(message.content ?? ""), request.from, request.lines);
            return {
              status: "ok",
              reference: request.reference,
              ...page,
              citations: [{ label: cached.label, reference: request.reference }],
            };
          });
        },
        async health() {
          if (closed) throw new Error("memory provider handle is closed");
          try {
            await withOperation(async (client) => {
              await client.countAtomic();
            }, 5_000);
            return { status: "ready" };
          } catch {
            return { status: "degraded", message: "Memory Gateway health check failed." };
          }
        },
        close,
      };
      handlesForAgent.add(close);
      return { provider };
    },
    async closeMemorySearchManager(params: { cfg: Record<string, unknown>; agentId: string }) {
      const handles = openHandles.get(params.agentId);
      if (handles) await Promise.all([...handles].map((close) => close()));
    },
    async closeAllMemorySearchManagers() {
      const handles = [...openHandles.values()].flatMap((set) => [...set]);
      await Promise.all(handles.map((close) => close()));
    },
  };
}
