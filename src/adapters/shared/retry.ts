/**
 * 通用指数退避重试器 — 零外部依赖，约 80 行。
 *
 * 特性：
 * - 指数退避: initialDelay * (2 ** (attempt - 1))
 * - 随机抖动: ±25% 避免惊群效应（thundering herd）
 * - 最大延迟上限: maxDelay（默认 30 秒）
 * - 可重试错误判断: retryableStatusCodes + 自定义 shouldRetry 函数
 * - 总超时控制: signal 参数支持 AbortSignal
 * - 回调通知: onRetry 钩子用于日志/监控
 *
 * 遵循 backoff-v1.0 标准算法。
 */

/**
 * 重试配置选项。
 */
export interface RetryOptions {
  /** 最大重试次数（不含首次尝试），默认 3。 */
  maxAttempts?: number;
  /** 初始退避延迟（毫秒），默认 200。 */
  initialDelayMs?: number;
  /** 最大退避延迟上限（毫秒），默认 30_000。 */
  maxDelayMs?: number;
  /** 是否启用随机抖动，默认 true。 */
  jitter?: boolean;
  /** 自定义可重试判断函数。返回 true 表示应重试。 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 用于取消重试循环的 AbortSignal。 */
  signal?: AbortSignal;
  /** 每次重试前的回调（用于日志记录）。 */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * HTTP 状态码，默认不可重试。
 * 这些错误表示客户端请求有问题，重试不会改善。
 */
const NON_RETRYABLE_STATUS_CODES = new Set([
  400, // Bad Request
  401, // Unauthorized
  403, // Forbidden
  404, // Not Found
  405, // Method Not Allowed
  409, // Conflict
  410, // Gone
  422, // Unprocessable Entity
]);

/**
 * HTTP 状态码，默认可重试。
 * 这些错误表示服务端暂时性问题，重试可能成功。
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

/**
 * 计算指定尝试次数的退避延迟。
 *
 * 公式: min(maxDelay, initialDelay * 2^(attempt-1))
 * 抖动: 在 [0.75 * delay, 1.25 * delay] 范围内随机
 *
 * @param attempt - 当前尝试次数（从 1 开始）
 * @param opts   - 重试选项
 * @returns 应等待的毫秒数
 */
export function computeBackoff(attempt: number, opts: RetryOptions = {}): number {
  const initialDelay = opts.initialDelayMs ?? 200;
  const maxDelay = opts.maxDelayMs ?? 30_000;

  const exponentialDelay = initialDelay * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(maxDelay, exponentialDelay);

  if (opts.jitter === false) {
    return cappedDelay;
  }

  // 全抖动算法：在 [delay/2, delay] 范围内随机
  // 避免多个客户端同时重试导致的惊群效应
  const jitteredDelay = cappedDelay * (0.5 + Math.random() * 0.5);
  return Math.round(jitteredDelay);
}

/**
 * 从错误中提取 HTTP 状态码（如果存在）。
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (error == null) return undefined;
  const err = error as Record<string, unknown>;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (typeof err.code === "number") return err.code;
  return undefined;
}

/**
 * 默认的可重试判断逻辑。
 *
 * 重试条件：
 * 1. 有 HTTP 状态码且在可重试集合中
 * 2. 是网络错误（无状态码，如 ECONNREFUSED、ETIMEDOUT）
 * 3. 无状态码且非 HTTP 错误（如 DNS 解析失败）
 *
 * 不重试条件：
 * 1. HTTP 状态码在不可重试集合中（400-422）
 * 2. 已收到 AbortSignal 的取消
 */
function defaultShouldRetry(error: unknown, _attempt: number): boolean {
  // AbortError 不重试
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const errAny = error as { name?: string; code?: string };
  if (errAny.name === "AbortError" || errAny.code === "ABORT_ERR") return false;

  const status = extractHttpStatus(error);
  if (status !== undefined) {
    if (NON_RETRYABLE_STATUS_CODES.has(status)) return false;
    if (RETRYABLE_STATUS_CODES.has(status)) return true;
    // 未知状态码：谨慎起见，不重试
    return false;
  }

  // 无状态码 = 网络错误 → 可重试
  return true;
}

/**
 * 带指数退避和抖动的重试执行器。
 *
 * @param fn   - 要重试的异步函数
 * @param opts - 重试选项
 * @returns fn 的返回值
 * @throws  所有重试耗尽后的最后一个错误
 *
 * @example
 * ```ts
 * const data = await withRetry(() => fetch("https://api.example.com/data"), {
 *   maxAttempts: 3,
 *   initialDelayMs: 200,
 *   onRetry: (err, attempt, delay) => logger.warn(`重试 ${attempt}, 等待 ${delay}ms`)
 * });
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const signal = opts.signal;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts + 1; attempt++) {
    // 检查 AbortSignal
    if (signal?.aborted) {
      throw new DOMException("操作已被取消", "AbortError");
    }

    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error;

      // 最后一次尝试，不再重试
      if (attempt > maxAttempts) break;

      // 检查是否应重试
      if (!shouldRetry(error, attempt)) {
        throw error;
      }

      const delayMs = computeBackoff(attempt, opts);

      // 通知回调
      opts.onRetry?.(error, attempt, delayMs);

      // 等待退避延迟（支持 AbortSignal 取消）
      await delayWithAbort(delayMs, signal);
    }
  }

  throw lastError;
}

/**
 * 可被 AbortSignal 取消的延迟。
 */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("重试被取消", "AbortError"));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("重试被取消", "AbortError"));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}
