/**
 * GatewayLifecycleManager — 宿主中立的 Gateway 生命周期管理器。
 *
 * 从 src/adapters/claude-code/gateway-supervisor.ts 析出（阶段 3 · Step 3.1），
 * 使所有 Track 2 宿主（Claude Code、Codex、Dify…）共享同一套健康探测 + 熔断逻辑。
 *
 * v1（本文件）：仅健康探测（client.health()），不拉起进程——要求用户预启动 Gateway。
 * v2（未实现）：在 ensureAlive() 里增加可选 spawn 拉起（移植 Hermes 的
 *   MEMORY_TENCENTDB_GATEWAY_CMD 发现 + Popen 逻辑）。届时此处会 import child_process
 *   并在 options 增加 spawnGateway 钩子；当前仅留 TODO 注释，行为不变。
 *
 * 熔断器（仅长命进程用，如 MCP server；短命 hooks 不用——它们不共享状态）：
 *   - 连续失败 N 次（默认 5）→ 开启冷却（默认 60s）
 *   - 冷却期间 isRunning/ensureAlive 直接返回 false，不发 health 请求
 *   - 冷却结束 → 半开：允许一次探测；成功则关闭熔断，失败则重新熔断
 *
 * 依赖 TdaiClient 接口（非具体实现），便于测试注入 mock。
 * 本文件零运行时依赖（仅依赖同 SDK 层的 TdaiClient 类型），保持可移植。
 */

import type { TdaiClient } from "./client.js";

// ============================
// 配置
// ============================

export interface GatewayLifecycleManagerOptions {
  /** Gateway HTTP 客户端（仅用 health() 方法）。 */
  client: TdaiClient;
  /** 连续失败几次后熔断，默认 5。 */
  failureThreshold?: number;
  /** 熔断冷却时长（ms），默认 60_000。 */
  cooldownMs?: number;
  /** 单次 isRunning 内 health 重试次数，默认 3。 */
  healthRetries?: number;
  /** 重试间隔（ms），默认 500。 */
  retryDelayMs?: number;
  /** 注入时钟，便于测试；默认 Date.now。 */
  now?: () => number;
  /** 注入睡眠，便于测试；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

// ============================
// GatewayLifecycleManager
// ============================

export class GatewayLifecycleManager {
  private readonly client: TdaiClient;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly healthRetries: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** 连续失败计数（成功时归零）。 */
  private consecutiveFailures = 0;
  /** 熔断到期时间戳（ms）；0 表示未熔断。now() < 此值时视为熔断开启。 */
  private circuitOpenUntil = 0;

  constructor(opts: GatewayLifecycleManagerOptions) {
    this.client = opts.client;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.healthRetries = opts.healthRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** 熔断器当前是否处于开启（冷却）状态。 */
  isCircuitOpen(): boolean {
    return this.now() < this.circuitOpenUntil;
  }

  /**
   * 探测 Gateway 是否可达。调 client.health()，最多重试 healthRetries 次。
   *
   * - health() resolve（无论 status=ok/degraded）→ 视为可达，返回 true
   * - health() reject（网络错误/超时）→ 视为不可达，返回 false
   * - 熔断开启时直接返回 false，不发请求
   * - 熔断冷却结束（半开）允许一次探测
   */
  async isRunning(): Promise<boolean> {
    if (this.isCircuitOpen()) return false;

    const ok = await this.probeHealth();
    if (ok) {
      this.onSuccess();
      return true;
    }
    this.onFailure();
    return false;
  }

  /**
   * 启动时 / 工具调用前确保 Gateway 存活。
   *
   * v1：仅探测（等同 isRunning），不拉起进程——用户须预启动 Gateway。
   * v2（TODO）：此处增加可选 spawn 拉起，移植 Hermes 的
   *   `MEMORY_TENCENTDB_GATEWAY_CMD` 发现 + Popen 逻辑。
   *   届时签名变为 `ensureAlive(opts?: { spawn?: boolean })`，
   *   isRunning 返回 false 时尝试 spawnGateway() 后再探测一次。
   */
  async ensureAlive(): Promise<boolean> {
    // v2 将在此处：if (!await this.isRunning()) { await this.spawnGateway(); }
    return this.isRunning();
  }

  // ============================
  // 内部
  // ============================

  /** 带重试的 health 探测。任一次 resolve 即成功；全部 reject 才失败。 */
  private async probeHealth(): Promise<boolean> {
    for (let attempt = 0; attempt < this.healthRetries; attempt++) {
      try {
        await this.client.health();
        return true;
      } catch {
        if (attempt < this.healthRetries - 1) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }
    return false;
  }

  /** 探测成功：重置失败计数，关闭熔断。 */
  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  /** 探测失败：累加失败计数，达阈值则开启熔断（或半开失败后重新熔断）。 */
  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.circuitOpenUntil = this.now() + this.cooldownMs;
    }
  }
}
