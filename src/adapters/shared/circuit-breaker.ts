/**
 * 三态熔断器 — 零外部依赖，约 100 行。
 *
 * 防止级联故障：当后端持续失败时，快速失败（fail-fast）而
 * 不浪费资源等待注定失败的请求。
 *
 * 状态机：
 *   CLOSED    → (连续失败 >= threshold) → OPEN
 *   OPEN      → (超时后) → HALF_OPEN
 *   HALF_OPEN → (探测成功) → CLOSED
 *   HALF_OPEN → (探测失败) → OPEN
 */

/**
 * 熔断器状态枚举。
 */
export enum CircuitState {
  /** 关闭 — 正常放行所有请求，记录成功/失败。 */
  CLOSED = "CLOSED",
  /** 打开 — 立即拒绝所有请求，不执行实际操作。 */
  OPEN = "OPEN",
  /** 半开 — 允许有限数量的探测请求通过，测试后端是否恢复。 */
  HALF_OPEN = "HALF_OPEN",
}

/**
 * 熔断器配置选项。
 */
export interface CircuitBreakerOptions {
  /** 触发 OPEN 的连续失败次数，默认 5。 */
  failureThreshold?: number;
  /** HALF_OPEN 状态下允许的最大并发探测请求数，默认 1。 */
  halfOpenMaxRequests?: number;
  /** OPEN 状态持续时间（毫秒），超时后自动切换到 HALF_OPEN，默认 30_000。 */
  timeoutMs?: number;
  /** 状态转换回调。 */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * 熔断器打开时抛出的错误。
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message = "熔断器已打开，请求被拒绝") {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * 三态熔断器。
 *
 * 使用简单的同步锁机制确保状态转换原子性。
 * 不支持嵌套调用（从 execute 的 fn 中再次调用 execute 会死锁）。
 *
 * @example
 * ```ts
 * const breaker = new CircuitBreaker({
 *   failureThreshold: 5,
 *   timeoutMs: 30_000,
 * });
 * const result = await breaker.execute(() => gatewayClient.recall("query", "s-1"));
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private openTimestamp = 0;
  private halfOpenInFlight = 0;

  private readonly failureThreshold: number;
  private readonly halfOpenMaxRequests: number;
  private readonly timeoutMs: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  /** 简单互斥锁 — 确保同一时间只有一个请求在执行状态转换。 */
  private locked = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.halfOpenMaxRequests = opts.halfOpenMaxRequests ?? 1;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.onStateChange = opts.onStateChange;
  }

  /**
   * 通过熔断器执行操作。
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // 简单的自旋锁 — 等待锁释放
    while (this.locked) {
      await new Promise((r) => setTimeout(r, 1));
    }
    this.locked = true;

    try {
      // 检查 OPEN → HALF_OPEN 超时转换（在 switch 之前）
      if (this.state === CircuitState.OPEN) {
        const elapsed = Date.now() - this.openTimestamp;
        if (elapsed >= this.timeoutMs) {
          this.transitionTo(CircuitState.HALF_OPEN);
          this.failureCount = 0;
        }
      }

      switch (this.state) {
        case CircuitState.CLOSED:
          return await this.executeClosed(fn);
        case CircuitState.OPEN:
          throw new CircuitBreakerOpenError(
            `熔断器已打开 ${Date.now() - this.openTimestamp}ms，${this.timeoutMs - (Date.now() - this.openTimestamp)}ms 后恢复`,
          );
        case CircuitState.HALF_OPEN:
          return await this.executeHalfOpen(fn);
        default:
          throw new Error(`未知熔断器状态: ${this.state}`);
      }
    } finally {
      this.locked = false;
    }
  }

  /** CLOSED 状态：正常执行。 */
  private async executeClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.failureCount = 0;
      return result;
    } catch (error) {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
        this.openTimestamp = Date.now();
      }
      throw error;
    }
  }

  /** HALF_OPEN 状态：限制并发探测请求。 */
  private async executeHalfOpen<T>(fn: () => Promise<T>): Promise<T> {
    if (this.halfOpenInFlight >= this.halfOpenMaxRequests) {
      throw new CircuitBreakerOpenError("熔断器半开中，探测请求数已达上限");
    }

    this.halfOpenInFlight++;
    try {
      const result = await fn();
      this.transitionTo(CircuitState.CLOSED);
      this.failureCount = 0;
      this.halfOpenInFlight = 0;
      return result;
    } catch (error) {
      this.transitionTo(CircuitState.OPEN);
      this.openTimestamp = Date.now();
      this.halfOpenInFlight = 0;
      throw error;
    }
  }

  /** 状态转换，触发回调。 */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.onStateChange?.(oldState, newState);
  }

  /** 获取当前状态。 */
  get currentState(): CircuitState {
    return this.state;
  }

  /** 获取当前连续失败计数。 */
  get failures(): number {
    return this.failureCount;
  }

  /** 获取半开状态下正在进行的探测请求数。 */
  get inFlight(): number {
    return this.halfOpenInFlight;
  }

  /**
   * 手动重置熔断器为 CLOSED 状态。
   */
  reset(): void {
    this.failureCount = 0;
    this.halfOpenInFlight = 0;
    this.openTimestamp = 0;
    if (this.state !== CircuitState.CLOSED) {
      this.transitionTo(CircuitState.CLOSED);
    }
  }
}
