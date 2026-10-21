/**
 * OpenClaw 标准 memory capability（统一记忆插槽接口）客户端接入层。
 *
 * 背景：OpenClaw 以 "exclusive slot" 方式接入记忆插件 —— 插件必须在 manifest
 * 声明 `kind: "memory"`，并在 register() 中调用 `api.registerMemoryCapability(...)`
 * 注册统一能力，设置界面"记忆"区块（引擎/搜索/梦境）与 `memory.search` /
 * `doctor.memory.status` 等 RPC 才会将本插件视为"活动记忆插件"。
 *
 * 本文件只实现插件侧需要的 subset，类型契约自包含（避免引入 openclaw 运行时包）：
 * - MemoryPluginRuntime.getMemorySearchManager → 统一搜索 manager
 * - MemoryPluginRuntime.resolveMemoryBackendConfig
 * 契约原文见 openclaw/openclaw：
 *   src/plugins/registry-contribution-types.ts
 *   packages/memory-host-sdk/src/host/types.ts
 */

import type { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

// ── OpenClaw 契约类型（自包含 subset）──────────────────────────────

export interface MemorySearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
  vectorScore?: number;
  textScore?: number;
  importance?: number;
  triggers?: string;
  projectKey?: string;
  /** @deprecated 使用 provenance.originClass */
  originClass?: string;
  citation?: string;
  provenance?: {
    originClass: string;
    sessionKind: string;
    observedAt: number;
    supersedesKey?: string;
  };
}

export type MemoryReadResult =
  | { status: "ok"; text: string; path: string; truncated?: boolean; from?: number; lines?: number; nextFrom?: number }
  | { status: "not_found"; text: ""; path: string };

export interface MemoryEmbeddingProbeResult {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
}

export interface MemoryProviderStatus {
  backend: "builtin";
  provider: string;
  model?: string;
  workspaceDir?: string;
  dbPath?: string;
  sources?: Array<"memory" | "sessions">;
  vector?: { enabled: boolean };
  custom?: Record<string, unknown>;
}

export interface MemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      lexicalOnly?: boolean;
      activeProjectKeys?: string[];
      sources?: Array<"memory" | "sessions">;
      signal?: AbortSignal;
    },
  ): Promise<MemorySearchHit[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability?(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface RemoteMemoryRuntime {
  getMemorySearchManager(params: {
    cfg: unknown;
    agentId: string;
    purpose?: "default" | "status" | "cli" | string;
    inspectSources?: boolean;
  }): Promise<{ manager: MemorySearchManager | null; debug?: unknown; error?: string }>;
  resolveMemoryBackendConfig(): { backend: "builtin" };
  closeMemorySearchManager?(params: { cfg: unknown; agentId: string }): Promise<void>;
  closeAllMemorySearchManagers?(): Promise<void>;
}

// ── 实现 ───────────────────────────────────────────────────────────

const SNIPPET_MAX_CHARS = 2000;
/** 合成路径协议：tdai://memories/<type>/<id>；无本地文件，readFile 恒为 not_found。 */
function synthesizeHitPath(type: string, id: string): string {
  return `tdai://memories/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

interface LoggerLike {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/** 统一搜索 manager：把远端 /v3 searchAtomic 结果映射为 OpenClaw MemorySearchResult。 */
class RemoteMemorySearchManager implements MemorySearchManager {
  constructor(
    private readonly client: MemoryClient,
    private readonly remoteAgentId: string,
    private readonly logger?: LoggerLike,
  ) {}

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      lexicalOnly?: boolean;
      activeProjectKeys?: string[];
      sources?: Array<"memory" | "sessions">;
      signal?: AbortSignal;
    },
  ): Promise<MemorySearchHit[]> {
    if (!query?.trim()) return [];
    const limit = Math.min(50, Math.max(1, opts?.maxResults ?? 10));
    const minScore = opts?.minScore ?? 0;
    this.logger?.debug?.(
      `[memory-capability] unified search: query="${query.slice(0, 80)}", limit=${limit}, minScore=${minScore}, agent=${this.remoteAgentId}`,
    );
    try {
      // 远端 Gateway 语义检索（L1 + 向量），与 tdai_memory_search 同一后端。
      const result = await this.client.searchAtomic({ query, limit });
      const items = result.items ?? [];
      const hits: MemorySearchHit[] = [];
      for (const item of items) {
        if (item.score != null && item.score < minScore) continue;
        hits.push({
          path: synthesizeHitPath(item.type ?? "memory", item.id),
          startLine: 1,
          endLine: 1,
          score: item.score ?? 0,
          snippet: (item.content ?? "").slice(0, SNIPPET_MAX_CHARS),
          source: "memory",
        });
      }
      return hits;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[memory-capability] unified search failed: ${msg}`);
      throw err;
    }
  }

  async readFile(params: { relPath: string }): Promise<MemoryReadResult> {
    // 远端记忆没有本地文件：阅读详情请使用 tdai_read_cos。
    return { status: "not_found", text: "", path: params.relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "tdai-memory-gateway",
      sources: ["memory"],
      vector: { enabled: true }, // 远端语义索引由 Memory Gateway 负责
      custom: {
        searchMode: "hybrid",
        remoteAgentId: this.remoteAgentId,
        // 远端持久化、内容从 API 返回，索引无本地"dirty"概念
        indexIdentity: { status: "stable", reason: "remote-managed" },
      },
    };
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    return null;
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    // 轻量探测：远端 1 条语义搜索；失败则如实上报不可用。
    try {
      await this.client.searchAtomic({ query: "__openclaw_probe__", limit: 1 });
      return { ok: true, checked: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[memory-capability] embedding probe failed: ${msg}`);
      return { ok: false, checked: true, error: msg };
    }
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    return true;
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // 复用共享 MemoryClient，不关闭连接。
  }
}

/**
 * 构造 OpenClaw 统一记忆 runtime。
 *
 * @param client 共享 MemoryClient（全局 isolation）
 * @param resolveScopedClient (openclawAgentId?, sessionId?) => MemoryClient
 *        —— 按 OpenClaw agent 映射远端隔离（agentIdMapping 优先，回退全局 agentId）
 * @param logger 插件日志器
 */
export function createRemoteMemoryRuntime(params: {
  client: MemoryClient;
  resolveScopedClient: (openclawAgentId: string | undefined, sessionId?: string) => MemoryClient;
  resolveRemoteAgentId: (openclawAgentId: string | undefined) => string;
  logger?: LoggerLike;
}): RemoteMemoryRuntime {
  const { client, resolveScopedClient, resolveRemoteAgentId, logger } = params;

  return {
    async getMemorySearchManager({ agentId, purpose }) {
      try {
        const scopedClient = resolveScopedClient(agentId, undefined);
        const remoteAgentId = resolveRemoteAgentId(agentId);
        logger?.debug?.(
          `[memory-capability] manager requested: openclawAgent=${agentId ?? "(none)"} -> remoteAgent=${remoteAgentId} (purpose=${purpose ?? "default"})`,
        );
        return {
          manager: new RemoteMemorySearchManager(scopedClient, remoteAgentId, logger),
          debug: { backend: "builtin", purpose },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[memory-capability] manager creation failed: ${msg}`);
        return { manager: null, error: msg };
      }
    },

    resolveMemoryBackendConfig() {
      return { backend: "builtin" };
    },

    async closeMemorySearchManager() {
      // 无跨请求状态，无需清理。
    },

    async closeAllMemorySearchManagers() {
      // 无跨请求状态，无需清理。
    },
  };
}

// 供工具/测试复用：把 unified search 语义与 tdai_memory_search 解耦的辅助导出。
export { synthesizeHitPath };