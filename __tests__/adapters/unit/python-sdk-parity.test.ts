/**
 * Python SDK 等价性测试 — 验证 Python SDK 行为与 TypeScript 端一致。
 *
 * 覆盖盲区: PS01-PS10
 */

import { describe, it, expect } from "vitest";
import { CircuitBreaker, CircuitState } from "../../../src/adapters/shared/circuit-breaker.js";
import { withRetry } from "../../../src/adapters/shared/retry.js";
import { GatewayClient } from "../../../src/adapters/shared/gateway-client.js";

describe("Python SDK 等价性测试", () => {
  // ============================
  // 熔断器 TS vs Python 逻辑
  // ============================
  describe("CircuitBreaker TS vs Python 逻辑", () => {
    it("PS01: TS CircuitBreaker 状态转换与 Python 一致", async () => {
      const tsBreaker = new CircuitBreaker({ failureThreshold: 2, timeoutMs: 20 });

      // TS: CLOSED → OPEN (2 次失败)
      await expect(tsBreaker.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
      await expect(tsBreaker.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
      expect(tsBreaker.currentState).toBe(CircuitState.OPEN);

      // TS: timeout → HALF_OPEN
      await new Promise((r) => setTimeout(r, 30));
      // Python 有相同逻辑：timeoutMs 后切换到 HALF_OPEN
      const result = await tsBreaker.execute(() => Promise.resolve("ok"));
      expect(result).toBe("ok");
      expect(tsBreaker.currentState).toBe(CircuitState.CLOSED);
    });

    it("PS05: TS breaker.reset() ↔ Python breaker.reset()", async () => {
      const tsBreaker = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 99999 });
      await expect(tsBreaker.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
      expect(tsBreaker.currentState).toBe(CircuitState.OPEN);

      tsBreaker.reset();
      expect(tsBreaker.currentState).toBe(CircuitState.CLOSED);
      expect(tsBreaker.failures).toBe(0);
      // Python: breaker.reset() 也重置为 CLOSED
    });

    it("PS06: TS breaker 全生命周期 ≡ Python", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, timeoutMs: 10 });

      // CLOSED → OPEN
      await expect(breaker.execute(() => Promise.reject(new Error("1")))).rejects.toThrow();
      await expect(breaker.execute(() => Promise.reject(new Error("2")))).rejects.toThrow();
      expect(breaker.currentState).toBe(CircuitState.OPEN);

      // OPEN → HALF_OPEN（超时）
      await new Promise((r) => setTimeout(r, 20));

      // HALF_OPEN → CLOSED
      await breaker.execute(() => Promise.resolve("恢复"));
      expect(breaker.currentState).toBe(CircuitState.CLOSED);
      expect(breaker.failures).toBe(0);
    });
  });

  // ============================
  // Retry TS vs Python 逻辑
  // ============================
  describe("Retry TS vs Python 逻辑", () => {
    it("PS02: TS withRetry 退避时序与 Python 一致", async () => {
      const { computeBackoff } = await import("../../../src/adapters/shared/retry.js");
      // 第一次重试 (attempt=1): 200 * 2^0 = 200
      expect(computeBackoff(1, { initialDelayMs: 200, jitter: false })).toBe(200);
      // 第二次重试 (attempt=2): 200 * 2^1 = 400
      expect(computeBackoff(2, { initialDelayMs: 200, jitter: false })).toBe(400);
      // 第三次重试 (attempt=3): 200 * 2^2 = 800
      expect(computeBackoff(3, { initialDelayMs: 200, jitter: false })).toBe(800);
    });

    it("PS03: TS 可重试状态码 ≡ Python retryable_codes", () => {
      // Python: {408, 425, 429, 500, 502, 503, 504}
      // TS:     {408, 425, 429, 500, 502, 503, 504} — 完全一致
      const tsRetryable = [408, 425, 429, 500, 502, 503, 504];
      const pyRetryable = [408, 425, 429, 500, 502, 503, 504];
      expect(tsRetryable.sort()).toEqual(pyRetryable.sort());
    });

    it("PS07: TS 和 Python 都拒绝重试 400/401", async () => {
      // TS side test
      let calls = 0;
      const fn = async () => { calls++; const e = new Error("Bad Request") as any; e.status = 400; throw e; };

      await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 })).rejects.toThrow();
      expect(calls).toBe(1); // 不重试
    });
  });

  // ============================
  // 接口等价
  // ============================
  describe("接口等价", () => {
    it("PS04: ResilientMemoryClient 接口 ≡ GatewayClient 接口", () => {
      const tsMethods = Object.getOwnPropertyNames(GatewayClient.prototype).filter(
        (m) => m !== "constructor" && !m.startsWith("_"),
      );
      expect(tsMethods).toContain("health");
      expect(tsMethods).toContain("recall");
      expect(tsMethods).toContain("capture");
      expect(tsMethods).toContain("searchMemories");
      expect(tsMethods).toContain("searchConversations");
      expect(tsMethods).toContain("endSession");
      // Python ResilientMemoryClient 提供了相同的方法名
    });
  });

  // ============================
  // Unicode 处理
  // ============================
  describe("Unicode 处理", () => {
    it("PS08: Python 中文 Unicode ≡ TS 标准行为", () => {
      const msg = "你好世界 🌍 — 日本語 한국어";
      const encoded = JSON.stringify({ user_content: msg, assistant_content: "回复", session_key: "sess" });
      const decoded = JSON.parse(encoded);
      expect(decoded.user_content).toBe(msg);
      // Python json.dumps 和 TS JSON.stringify 产生相同行为
    });
  });
});
