/**
 * TdaiClient — Track 2 宿主侧与 Tdai Gateway 通信的统一契约。
 *
 * TdaiHttpClient 是 TS 实现（fetch + Bearer + 超时 + 重试），供 Claude Code / Codex
 * 等 TS 宿主使用。Python 宿主（Hermes / Dify）复用 hermes-plugin/.../client.py（同契约）。
 *
 * 设计：
 *   - 方法参数用 camelCase（TS 惯例），内部转 snake_case 发给 Gateway
 *   - 返回类型复用 src/gateway/types.ts（同包，零运行时成本）
 *   - 失败抛 TdaiClientError，调用方（binding / hooks）负责 try/catch 转为软失败
 *   - 配置（baseUrl / apiKey / timeouts）可注入，便于测试
 *
 * 鉴权：apiKey 非空时发 `Authorization: Bearer <key>`；为空时不发（匹配 Gateway
 * 开放模式旧行为）。Gateway 端自管密钥，两端须一致。
 */

import type {
  RecallResponse,
  CaptureResponse,
  MemorySearchResponse,
  ConversationSearchResponse,
  HealthResponse,
} from "../gateway/types.js";

// ============================
// 参数类型（SDK 侧 camelCase）
// ============================

/** capture 的可选参数。 */
export interface CaptureOpts {
  sessionId?: string;
  userId?: string;
  /** 完整消息列表（可选，供 L1 提取更多上下文）。 */
  messages?: unknown[];
}

/** 记忆搜索参数（对齐 MemorySearchRequest）。 */
export interface MemorySearchParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

/** 会话搜索参数（对齐 ConversationSearchRequest）。 */
export interface ConversationSearchParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}

// ============================
// 错误类型
// ============================

/**
 * TdaiClient 调用失败的统一错误。
 * 调用方应 try/catch 并按软失败处理（记忆永不阻塞对话）。
 */
export class TdaiClientError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；0 表示非 HTTP 错误（超时 / 网络错误）。 */
    readonly status: number,
    /** 机器可读错误码（如 TIMEOUT / NETWORK_ERROR / Gateway 返回的 code）。 */
    readonly code?: string,
    /** 出错的端点路径（如 /recall）。 */
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = "TdaiClientError";
  }
}

// ============================
// TdaiClient 接口
// ============================

/**
 * Track 2 宿主侧与 Gateway 通信的契约。
 *
 * 新平台接入：TS 宿主用 TdaiHttpClient，Python 宿主用 client.py（同方法签名）。
 * HostEventBinding 的实现持有此接口而非具体类，便于测试时注入 mock。
 */
export interface TdaiClient {
  /** 召回记忆（对应 POST /recall）。 */
  recall(query: string, sessionKey: string, userId?: string): Promise<RecallResponse>;

  /** 捕获对话轮（对应 POST /capture），触发 L0 入库 + 流水线调度。 */
  capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    opts?: CaptureOpts,
  ): Promise<CaptureResponse>;

  /** 搜索 L1 记忆（对应 POST /search/memories）。 */
  searchMemories(params: MemorySearchParams): Promise<MemorySearchResponse>;

  /** 搜索 L0 会话（对应 POST /search/conversations）。 */
  searchConversations(params: ConversationSearchParams): Promise<ConversationSearchResponse>;

  /** 结束会话并 flush（对应 POST /session/end）。失败时调用方应静默吞掉。 */
  endSession(sessionKey: string, userId?: string): Promise<void>;

  /** 健康探测（对应 GET /health），supervisor 用于探活。 */
  health(): Promise<HealthResponse>;
}

// ============================
// 超时配置
// ============================

/** 各端点超时（毫秒），对齐 Gateway 与 Hermes 的约定。 */
export interface TdaiTimeouts {
  recall: number;
  capture: number;
  search: number;
  endSession: number;
  health: number;
}

/** 默认超时：recall 5s / capture 10s / search 5s / endSession 5s / health 2s。 */
const DEFAULT_TIMEOUTS: TdaiTimeouts = {
  recall: 5_000,
  capture: 10_000,
  search: 5_000,
  endSession: 5_000,
  health: 2_000,
};

// ============================
// TdaiHttpClient 实现
// ============================

export interface TdaiHttpClientOptions {
  /** Gateway 基地址，如 http://127.0.0.1:8420（不带尾斜杠）。 */
  baseUrl: string;
  /** Bearer 令牌；未设置时不发 Authorization 头（匹配 Gateway 开放模式）。 */
  apiKey?: string;
  /** 覆盖默认超时（毫秒），便于测试注入短超时。 */
  timeouts?: Partial<TdaiTimeouts>;
}

/**
 * TdaiClient 的 fetch 实现。
 *
 * 重试策略（对齐设计文档 §6）：
 *   - 5xx → 重试 1 次
 *   - 网络错误（fetch 抛非 AbortError）→ 重试 1 次
 *   - 超时（AbortError）→ 不重试（Gateway 可能卡住，重试更慢）
 *   - 4xx → 不重试，直接抛
 */
export class TdaiHttpClient implements TdaiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeouts: TdaiTimeouts;

  constructor(opts: TdaiHttpClientOptions) {
    // 去掉尾斜杠，避免拼路径时双斜杠
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  // ============================
  // TdaiClient 实现
  // ============================

  recall(query: string, sessionKey: string, userId?: string): Promise<RecallResponse> {
    return this.post(
      "/recall",
      { query, session_key: sessionKey, user_id: userId },
      this.timeouts.recall,
    );
  }

  capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    opts?: CaptureOpts,
  ): Promise<CaptureResponse> {
    return this.post(
      "/capture",
      {
        user_content: userContent,
        assistant_content: assistantContent,
        session_key: sessionKey,
        session_id: opts?.sessionId,
        user_id: opts?.userId,
        messages: opts?.messages,
      },
      this.timeouts.capture,
    );
  }

  searchMemories(params: MemorySearchParams): Promise<MemorySearchResponse> {
    return this.post(
      "/search/memories",
      { query: params.query, limit: params.limit, type: params.type, scene: params.scene },
      this.timeouts.search,
    );
  }

  searchConversations(params: ConversationSearchParams): Promise<ConversationSearchResponse> {
    return this.post(
      "/search/conversations",
      { query: params.query, limit: params.limit, session_key: params.sessionKey },
      this.timeouts.search,
    );
  }

  async endSession(sessionKey: string, userId?: string): Promise<void> {
    await this.post(
      "/session/end",
      { session_key: sessionKey, user_id: userId },
      this.timeouts.endSession,
    );
  }

  health(): Promise<HealthResponse> {
    return this.get("/health", this.timeouts.health);
  }

  // ============================
  // 内部 HTTP 工具
  // ============================

  private post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    return this.request<T>("POST", path, body, timeoutMs);
  }

  private get<T>(path: string, timeoutMs: number): Promise<T> {
    return this.request<T>("GET", path, undefined, timeoutMs);
  }

  /**
   * 统一请求入口。重试策略见类注释。
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = { error: text };
        }

        if (!res.ok) {
          const errBody = parsed as { error?: string; code?: string } | null;
          const err = new TdaiClientError(
            errBody?.error ?? `HTTP ${res.status}`,
            res.status,
            errBody?.code,
            path,
          );
          // 仅 5xx 重试 1 次
          if (res.status >= 500 && attempt === 0) continue;
          throw err;
        }
        return parsed as T;
      } catch (err) {
        clearTimeout(timer);
        // 已是 TdaiClientError（4xx 等）直接抛，不重试
        if (err instanceof TdaiClientError) throw err;

        const isAbort = err instanceof Error && err.name === "AbortError";
        const mapped = new TdaiClientError(
          isAbort
            ? `Timeout after ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err),
          0,
          isAbort ? "TIMEOUT" : "NETWORK_ERROR",
          path,
        );
        // 超时不重试；网络错误首次重试
        if (!isAbort && attempt === 0) continue;
        throw mapped;
      }
    }
    // 不可达：循环必在 attempt=1 内 return 或 throw
    throw new TdaiClientError("Retry loop exhausted", 0, "UNREACHABLE", path);
  }
}
