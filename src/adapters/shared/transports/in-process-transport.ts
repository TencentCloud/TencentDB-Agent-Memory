/**
 * InProcess Transport — 直接调用 TdaiCore，绕过 HTTP Gateway。
 *
 * 两种使用模式：
 * 1. **注入模式**：传入已构建的 core（用于测试/嵌入式部署）
 * 2. **自有模式**：延迟构建自己的 core（用于单进程部署）
 *
 * 注入模式下不管理 core 生命周期；自有模式下 close() 会销毁 core。
 *
 * 设计参考 PR #534 的 InProcessMemoryClient。
 */

import { MemoryClientError, type MemoryClient, type MemoryClientStatus } from "./types.js";
import type {
  HealthResponse,
  RecallResponse,
  CaptureResponse,
  SearchResponse,
  SessionEndResponse,
  RecallParams,
  CaptureParams,
  SearchMemoriesParams,
  SearchConversationsParams,
  EndSessionParams,
  InProcessTransportOptions,
} from "./types.js";

// ============================
// Core 接口（结构类型，无需 imports）
// ============================

/** TdaiCore 暴露的方法子集 — 结构类型适配。 */
interface CoreLike {
  initialize?: () => Promise<void>;
  destroy?: () => Promise<void>;
  handleBeforeRecall?: (userText: string, sessionKey: string) => Promise<RecallLike>;
  handleTurnCommitted?: (turn: TurnLike) => Promise<CaptureLike>;
  searchMemories?: (params: SearchLikeParams) => Promise<SearchLike>;
  searchConversations?: (params: SearchLikeParams) => Promise<SearchLike>;
  handleSessionEnd?: (sessionKey: string) => Promise<void>;
  healthCheck?: () => HealthLike;
}

interface RecallLike {
  context?: string;
  strategy?: string;
  memoryCount?: number;
}

interface CaptureLike {
  l0Recorded?: number;
  schedulerNotified?: boolean;
  recordsRecorded?: number;
}

interface SearchLike {
  text: string;
  total: number;
  strategy?: string;
}

interface SearchLikeParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
  sessionKey?: string;
}

interface TurnLike {
  userText?: string;
  user_content?: string;
  assistantText?: string;
  assistant_content?: string;
  sessionKey?: string;
  session_key?: string;
  sessionId?: string;
  session_id?: string;
  userId?: string;
  user_id?: string;
}

interface HealthLike {
  status?: string;
  version?: string;
  uptime?: number;
  stores?: {
    vectorStore?: boolean;
    embeddingService?: boolean;
  };
}

// ============================
// InProcessMemoryClient
// ============================

/**
 * InProcess Transport 实现。
 *
 * 将 MemoryClient 接口映射到 TdaiCore 的方法调用。
 * 零网络开销 — 直接在同一进程内通信。
 *
 * @example
 * ```ts
 * // 注入模式（测试）
 * const fakeCore = { handleBeforeRecall: async () => ({ context: "test" }) };
 * const client = new InProcessMemoryClient({ core: fakeCore });
 *
 * // 自有模式（生产）
 * // const client = new InProcessMemoryClient({ configPath: "./tdai-gateway.json" });
 * // await client.ensureCore();
 * ```
 */
export class InProcessMemoryClient implements MemoryClient {
  private core: CoreLike | null = null;
  private _closed = false;
  private _ownsCore = false;
  private coreBuildPromise: Promise<CoreLike> | null = null;

  constructor(private readonly opts: InProcessTransportOptions = {}) {
    if (opts.core) {
      this.core = opts.core as CoreLike;
    }
  }

  // ============================
  // MemoryClient 实现
  // ============================

  async health(): Promise<HealthResponse> {
    const core = await this.ensureCore();
    if (core.healthCheck) {
      const h = core.healthCheck();
      return {
        status: (h.status === "ok" ? "ok" : "degraded") as "ok" | "degraded",
        version: h.version ?? "in-process",
        uptime: h.uptime ?? 0,
        stores: {
          vectorStore: h.stores?.vectorStore ?? false,
          embeddingService: h.stores?.embeddingService ?? false,
        },
      };
    }
    return {
      status: "ok",
      version: "in-process",
      uptime: 0,
      stores: { vectorStore: false, embeddingService: false },
    };
  }

  async recall(params: RecallParams): Promise<RecallResponse> {
    const core = await this.ensureCore();
    if (!core.handleBeforeRecall) {
      return { context: "", strategy: "none", memory_count: 0 };
    }
    const r = await core.handleBeforeRecall(params.query, params.sessionKey);
    return {
      context: r.context ?? "",
      strategy: r.strategy,
      memory_count: r.memoryCount,
    };
  }

  async capture(params: CaptureParams): Promise<CaptureResponse> {
    const core = await this.ensureCore();
    if (!core.handleTurnCommitted) {
      return { l0_recorded: 0, scheduler_notified: false };
    }
    const turn: TurnLike = {
      userText: params.userContent,
      assistantText: params.assistantContent,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      userId: params.userId,
    };
    const r = await core.handleTurnCommitted(turn);
    return {
      l0_recorded: r.recordsRecorded ?? r.l0Recorded ?? 1,
      scheduler_notified: r.schedulerNotified ?? true,
    };
  }

  async searchMemories(params: SearchMemoriesParams): Promise<SearchResponse> {
    const core = await this.ensureCore();
    if (!core.searchMemories) {
      return { results: "[]", total: 0 };
    }
    const r = await core.searchMemories({
      query: params.query,
      limit: params.limit,
      type: params.type,
      scene: params.scene,
    });
    return { results: r.text, total: r.total, strategy: r.strategy };
  }

  async searchConversations(params: SearchConversationsParams): Promise<SearchResponse> {
    const core = await this.ensureCore();
    if (!core.searchConversations) {
      return { results: "[]", total: 0 };
    }
    const r = await core.searchConversations({
      query: params.query,
      limit: params.limit,
      sessionKey: params.sessionKey,
    });
    return { results: r.text, total: r.total };
  }

  async endSession(params: EndSessionParams): Promise<SessionEndResponse> {
    const core = await this.ensureCore();
    if (core.handleSessionEnd) {
      await core.handleSessionEnd(params.sessionKey);
    }
    return { flushed: true };
  }

  getStatus(): MemoryClientStatus {
    return {
      transport: "in-process",
      closed: this._closed,
    };
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this._ownsCore && this.core?.destroy) {
      // 等待可能正在进行的构建完成
      if (this.coreBuildPromise) {
        try {
          const core = await this.coreBuildPromise;
          await core.destroy?.();
        } catch {
          // 清理时忽略错误
        }
      } else {
        await this.core.destroy();
      }
    }
    this.core = null;
    this.coreBuildPromise = null;
  }

  // ============================
  // 内部
  // ============================

  /**
   * 确保 core 已就绪。
   *
   * 使用 Promise 门控模式：并发首次调用共享同一个构建 Promise，
   * 恰好构建一个 core 实例。
   */
  private async ensureCore(): Promise<CoreLike> {
    if (this._closed) {
      throw new MemoryClientError("Transport 已关闭", "unavailable");
    }

    if (this.core) return this.core;

    if (!this.coreBuildPromise) {
      this.coreBuildPromise = this.buildCore();
    }

    try {
      this.core = await this.coreBuildPromise;
      return this.core!;
    } catch (error) {
      // 构建失败时重置，允许重试
      this.coreBuildPromise = null;
      throw new MemoryClientError(
        `无法构建 InProcess core: ${(error as Error)?.message ?? String(error)}`,
        "unavailable",
        error,
      );
    }
  }

  /**
   * 动态构建自有 TdaiCore。
   *
   * 仅在未注入 core 时调用。
   *
   * 注意：自有 core 构建需要完整的 Gateway 配置和 LLM 配置，
   * 主要用于单进程部署场景。测试场景中推荐使用注入模式（传入 fake core）。
   *
   * 动态 import 重量级依赖（sqlite、embedding 等），
   * 确保 import 时的副作用不会影响测试路径。
   */
  private async buildCore(): Promise<CoreLike> {
    this._ownsCore = true;

    try {
      const [{ TdaiCore }, { StandaloneHostAdapter }] = await Promise.all([
        import("../../../core/tdai-core.js"),
        import("../../standalone/host-adapter.js"),
      ]);

      // 为自有 core 提供最小配置
      const dataDir = this.opts.dataDir ?? "./tdai-data";
      const log = console as unknown as import("../../../core/types.js").Logger;
      const adapter = new StandaloneHostAdapter({
        dataDir,
        llmConfig: {} as unknown as import("../../standalone/llm-runner.js").StandaloneLLMConfig,
        logger: log,
      });

      const core = new TdaiCore({
        hostAdapter: adapter as unknown as import("../../../core/types.js").HostAdapter,
        config: {
          extraction: { enabled: false },
          dataDir,
        } as unknown as import("../../../config.js").MemoryTdaiConfig,
      });
      await core.initialize();
      return core as unknown as CoreLike;
    } catch (error) {
      throw new MemoryClientError(
        `动态构建 InProcess core 失败（仅注入模式推荐用于测试）: ${(error as Error)?.message ?? String(error)}`,
        "unavailable",
        error,
      );
    }
  }
}
