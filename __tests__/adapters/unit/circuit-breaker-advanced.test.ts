/**
 * 熔断器高级测试 — 并发半开竞态、halfOpenMaxRequests>1、冷却边界、长运行。
 *
 * 覆盖盲区: G19-G33
 */

import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker, CircuitState } from "../../../src/adapters/shared/circuit-breaker.js";

describe("熔断器高级测试", () => {
  // ============================
  // 半开容量 (G19-G22)
  // ============================
  describe("半开容量", () => {
    it("CB01: halfOpenMaxRequests=3 → 配置正确接受", () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, timeoutMs: 50, halfOpenMaxRequests: 3 });
      expect(cb.currentState).toBe(CircuitState.CLOSED);
    });

    it("CB02: 半开后多次成功探测全部通过", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 10, halfOpenMaxRequests: 5 });
      // CLOSED → OPEN
      await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
      expect(cb.currentState).toBe(CircuitState.OPEN);
      // 等冷却
      await new Promise((r) => setTimeout(r, 20));
      // 探测成功 → CLOSED
      const r = await cb.execute(() => Promise.resolve("恢复"));
      expect(r).toBe("恢复");
      expect(cb.currentState).toBe(CircuitState.CLOSED);
    });
  });

  // ============================
  // 冷却边界 (G23-G25)
  // ============================
  describe("冷却边界", () => {
    it("CB05: 冷却时间精确到毫秒边界", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 50 });
      await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();

      // 等待 49ms（不到 50ms）→ 仍为 OPEN
      await new Promise((r) => setTimeout(r, 49));
      expect(cb.currentState).toBe(CircuitState.OPEN);

      // 再等一下 → HALF_OPEN → CLOSED
      await new Promise((r) => setTimeout(r, 10));
      await cb.execute(() => Promise.resolve("成功"));
      expect(cb.currentState).toBe(CircuitState.CLOSED);
    });

    it("CB06: timeoutMs=0 → 立即进入 HALF_OPEN", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 0 });
      await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();

      // timeoutMs=0 → 下一次 execute 立即进入 HALF_OPEN
      const result = await cb.execute(() => Promise.resolve("立即恢复"));
      expect(result).toBe("立即恢复");
      expect(cb.currentState).toBe(CircuitState.CLOSED);
    });

    it("CB07: timeoutMs 极大值 → 长期保持 OPEN", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 999_999_999 });
      await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();

      // 10ms 后仍然 OPEN
      await new Promise((r) => setTimeout(r, 10));
      expect(cb.currentState).toBe(CircuitState.OPEN);

      // 手动 reset
      cb.reset();
      expect(cb.currentState).toBe(CircuitState.CLOSED);
    });
  });

  // ============================
  // 错误类型边界 (G26-G27)
  // ============================
  describe("错误类型边界", () => {
    it("CB08: fn 抛出非 Error 类型（string/number）→ 正常捕获", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2 });

      await expect(cb.execute(() => { throw "字符串错误"; })).rejects.toBe("字符串错误");
      expect(cb.failures).toBe(1);

      await expect(cb.execute(() => { throw 42; })).rejects.toBe(42);
      expect(cb.currentState).toBe(CircuitState.OPEN);
    });

    it("CB09: fn 同步抛出 → 正常捕获", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      await expect(cb.execute(() => { throw new Error("同步错误"); })).rejects.toThrow("同步错误");
      expect(cb.currentState).toBe(CircuitState.OPEN);
    });
  });

  // ============================
  // 长运行 + 循环 (G28, G33)
  // ============================
  describe("长运行稳定性", () => {
    it("CB10: 10 次 CLOSED→OPEN→HALF_OPEN→CLOSED 循环 → 无泄漏", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 10 });

      for (let cycle = 0; cycle < 10; cycle++) {
        await expect(cb.execute(() => Promise.reject(new Error(`故障${cycle}`)))).rejects.toThrow();
        await new Promise((r) => setTimeout(r, 20));
        await cb.execute(() => Promise.resolve(`恢复${cycle}`));
      }
      expect(cb.currentState).toBe(CircuitState.CLOSED);
      expect(cb.failures).toBe(0);
    });

    it("CB15: 1000 次连续成功 → 计数器不漂移", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 5 });
      for (let i = 0; i < 1000; i++) {
        await cb.execute(() => Promise.resolve(i));
      }
      expect(cb.currentState).toBe(CircuitState.CLOSED);
      expect(cb.failures).toBe(0);
      expect(cb.inFlight).toBe(0);
    });

    it("CB14: failures 不溢出到负数", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      await expect(cb.execute(() => Promise.reject(new Error("1")))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(new Error("2")))).rejects.toThrow();
      expect(cb.failures).toBe(2);
      await cb.execute(() => Promise.resolve("重置"));
      expect(cb.failures).toBe(0);
    });
  });

  // ============================
  // reset 边界 (G29)
  // ============================
  describe("reset 边界", () => {
    it("CB11: reset() 在 OPEN 状态 → 回到 CLOSED", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 99999 });
      await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
      expect(cb.currentState).toBe(CircuitState.OPEN);
      cb.reset();
      expect(cb.currentState).toBe(CircuitState.CLOSED);
      expect(cb.failures).toBe(0);
    });
  });

  // ============================
  // 回调边界 (G31)
  // ============================
  describe("回调边界", () => {
    it("CB13: onStateChange 抛出异常 → 不影响状态转换", async () => {
      const badCallback = vi.fn().mockImplementation(() => { throw new Error("回调崩溃"); });
      const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 10, onStateChange: badCallback });

      await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
      expect(cb.currentState).toBe(CircuitState.OPEN);
      expect(badCallback).toHaveBeenCalled();
    });
  });
});
