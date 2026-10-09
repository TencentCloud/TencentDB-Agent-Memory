// 本地接口定义 - 依赖反转，避免直接依赖 PR #316 的 GatewayMemoryClient
export interface GatewayClient {
  recall(body: { query: string; session_key: string }): Promise<{ context: string }>;
  capture(body: { user_text: string; assistant_text: string; session_key: string }): Promise<unknown>;
  searchMemories(body: { query: string; limit: number }): Promise<unknown>;
  searchConversations(body: { query: string; limit: number }): Promise<unknown>;
  endSession(body: { session_key: string }): Promise<unknown>;
}

export interface BridgeRetryOpts {
  attempts: number;
  baseMs: number;
}

export interface BridgeOpts {
  retry?: Partial<BridgeRetryOpts>;
  recallCacheMax?: number; // ponytail: Map cap,默认 256
}

const DEFAULT_RETRY: BridgeRetryOpts = { attempts: 3, baseMs: 200 };

// ponytail: 仅瞬态错误重试; Auth/Validation 立即降级
// 使用 duck typing 判断瞬态错误：检查是否有 status 字段且为瞬态 HTTP 状态码
function isTransient(err: unknown): boolean {
  const status = (err as any)?.status;
  const isNumericStatus = typeof status === "number";

  // 检查瞬态 HTTP 状态码：408(请求超时), 425(太早), 429(限流), >=500(服务器错误)
  if (isNumericStatus && (status === 408 || status === 425 || status === 429 || status >= 500)) {
    return true;
  }

  // 检查网络错误：TypeError (如网络断开、DNS 解析失败等)
  // 或者 Error 对象的 message 包含网络相关关键词
  if (err instanceof TypeError) {
    return true;
  }

  if (err instanceof Error && typeof err.message === "string" && /fetch|network|timeout/i.test(err.message)) {
    return true;
  }

  return false;
}

async function withRetry<T>(fn: () => Promise<T>, opts: BridgeRetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) {
        // 非瞬态错误：立即抛出，由模板方法降级处理
        throw err;
      }
      // 指数退避 + 抖动
      const delay = opts.baseMs * 2 ** attempt + Math.random() * opts.baseMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

function sanitize(s: string, max: number): string {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max) : s;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export class TdaiBridge {
  private readonly retry: BridgeRetryOpts;
  private readonly cache = new Map<string, unknown>(); // ponytail: 简单容量治理; LRU 若命中率不够再换
  private readonly cacheMax: number;

  constructor(private readonly client: GatewayClient, opts: BridgeOpts = {}) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.cacheMax = opts.recallCacheMax ?? 256;
  }

  async recall(query: string, sessionKey: string): Promise<{ context: string }> {
    const q = sanitize(query, 100_000);
    const key = sessionKey + ":" + q;

    if (this.cache.has(key)) {
      return this.cache.get(key) as { context: string };
    }

    try {
      const res = await withRetry(
        () => this.client.recall({ query: q, session_key: sessionKey }),
        this.retry
      );
      this.cache.set(key, res);

      // ponytail: 简单容量治理；缓存超限清空
      if (this.cache.size > this.cacheMax) {
        this.cache.clear();
      }

      return res as { context: string };
    } catch (err) {
      console.warn("[tdai-bridge] recall degraded:", (err as Error).message);
      return { context: "" }; // 优雅降级：永不抛出
    }
  }

  async capture(turn: { userText: string; assistantText: string }, sessionKey: string): Promise<{ ok: boolean }> {
    try {
      await withRetry(
        () =>
          this.client.capture({
            user_text: sanitize(turn.userText, 1_000_000),
            assistant_text: sanitize(turn.assistantText, 1_000_000),
            session_key: sessionKey,
          }),
        this.retry
      );
      return { ok: true };
    } catch (err) {
      console.warn("[tdai-bridge] capture degraded:", (err as Error).message);
      return { ok: false };
    }
  }

  async searchMemory(query: string, opts: { limit?: number } = {}): Promise<unknown> {
    try {
      return await withRetry(
        () =>
          this.client.searchMemories({
            query: sanitize(query, 100_000),
            limit: clamp(opts.limit ?? 10, 1, 50),
          }),
        this.retry
      );
    } catch (err) {
      console.warn("[tdai-bridge] search degraded:", (err as Error).message);
      return [];
    }
  }

  async searchConversation(query: string, opts: { limit?: number } = {}): Promise<unknown> {
    try {
      return await withRetry(
        () =>
          this.client.searchConversations({
            query: sanitize(query, 100_000),
            limit: clamp(opts.limit ?? 10, 1, 50),
          }),
        this.retry
      );
    } catch (err) {
      console.warn("[tdai-bridge] search degraded:", (err as Error).message);
      return [];
    }
  }

  async endSession(sessionKey: string): Promise<void> {
    try {
      await this.client.endSession({ session_key: sessionKey });
    } catch (err) {
      console.warn("[tdai-bridge] endSession degraded:", (err as Error).message);
      // endSession 失败时不抛出异常，静默降级
    }
  }
}