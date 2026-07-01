/**
 * 熔断器状态机单元测试。
 */

import { describe, it, expect, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerOpenError,
} from "../../../src/adapters/shared/circuit-breaker.js";

function fastBreaker(failureThreshold = 3, timeoutMs = 50) {
  return new CircuitBreaker({ failureThreshold, timeoutMs, halfOpenMaxRequests: 1 });
}

describe("CircuitBreaker", () => {
  // ============================
  // 初始状态
  // ============================
  it("初始状态为 CLOSED，计数为 0", () => {
    const cb = fastBreaker();
    expect(cb.currentState).toBe(CircuitState.CLOSED);
    expect(cb.failures).toBe(0);
    expect(cb.inFlight).toBe(0);
  });

  // ============================
  // CLOSED → OPEN
  // ============================
  it("连续失败达到阈值后转换为 OPEN", async () => {
    const cb = fastBreaker(3);
    const fail = () => Promise.reject(new Error("故障"));

    await expect(cb.execute(fail)).rejects.toThrow("故障");
    await expect(cb.execute(fail)).rejects.toThrow("故障");
    await expect(cb.execute(fail)).rejects.toThrow("故障");

    expect(cb.currentState).toBe(CircuitState.OPEN);
  });

  it("成功的请求重置故障计数", async () => {
    const cb = fastBreaker(3);
    let call = 0;
    const fn = () => {
      call++;
      if (call <= 2) return Promise.reject(new Error("失败"));
      return Promise.resolve("成功");
    };

    await expect(cb.execute(fn)).rejects.toThrow("失败");
    await expect(cb.execute(fn)).rejects.toThrow("失败");
    expect(cb.failures).toBe(2);

    // 第 3 次成功 → 重置
    await cb.execute(fn);
    expect(cb.failures).toBe(0);
    expect(cb.currentState).toBe(CircuitState.CLOSED);
  });

  // ============================
  // OPEN 状态行为
  // ============================
  it("OPEN 状态立即拒绝请求（不调用 fn）", async () => {
    const cb = fastBreaker(1, 99999); // 1 次失败就 OPEN，超时很长
    const fail = () => Promise.reject(new Error("故障"));

    await expect(cb.execute(fail)).rejects.toThrow("故障");
    expect(cb.currentState).toBe(CircuitState.OPEN);

    const fn = vi.fn().mockResolvedValue("不应被调用");
    await expect(cb.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("OPEN 超时后进入 HALF_OPEN", async () => {
    const cb = fastBreaker(1, 10); // 10ms 超时
    const fail = () => Promise.reject(new Error("故障"));

    await expect(cb.execute(fail)).rejects.toThrow("故障");
    expect(cb.currentState).toBe(CircuitState.OPEN);

    // 等待超时
    await new Promise((r) => setTimeout(r, 20));

    // 此时仍在 OPEN，但 execute 会检测超时并切换到 HALF_OPEN
    // 进入 HALF_OPEN 后会尝试执行 fn，所以需要用成功的 fn
    const success = () => Promise.resolve("恢复");
    const result = await cb.execute(success);

    expect(result).toBe("恢复");
    expect(cb.currentState).toBe(CircuitState.CLOSED);
  });

  // ============================
  // HALF_OPEN 状态
  // ============================
  it("探测成功 → CLOSED", async () => {
    const cb = fastBreaker(1, 10);
    await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    const result = await cb.execute(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(cb.currentState).toBe(CircuitState.CLOSED);
    expect(cb.failures).toBe(0);
  });

  it("探测失败 → 回到 OPEN", async () => {
    const cb = fastBreaker(1, 10);
    await expect(cb.execute(() => Promise.reject(new Error("故障1")))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    await expect(cb.execute(() => Promise.reject(new Error("故障2")))).rejects.toThrow("故障2");
    expect(cb.currentState).toBe(CircuitState.OPEN);
  });

  // ============================
  // 状态转换回调
  // ============================
  it("状态变化时触发 onStateChange", async () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ failureThreshold: 1, timeoutMs: 10, onStateChange });

    await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
    expect(onStateChange).toHaveBeenCalledWith(CircuitState.CLOSED, CircuitState.OPEN);

    await new Promise((r) => setTimeout(r, 20));
    await cb.execute(() => Promise.resolve("ok"));

    expect(onStateChange).toHaveBeenCalledWith(CircuitState.OPEN, CircuitState.HALF_OPEN);
    expect(onStateChange).toHaveBeenCalledWith(CircuitState.HALF_OPEN, CircuitState.CLOSED);
  });

  // ============================
  // 手动重置
  // ============================
  it("reset 回到 CLOSED", async () => {
    const cb = fastBreaker(1, 99999);
    await expect(cb.execute(() => Promise.reject(new Error("故障")))).rejects.toThrow();
    expect(cb.currentState).toBe(CircuitState.OPEN);

    cb.reset();

    expect(cb.currentState).toBe(CircuitState.CLOSED);
    expect(cb.failures).toBe(0);

    const result = await cb.execute(() => Promise.resolve("正常"));
    expect(result).toBe("正常");
  });

  // ============================
  // 并发安全
  // ============================
  it("并发请求正确处理", async () => {
    const cb = fastBreaker(5);

    const results = await Promise.allSettled([
      cb.execute(() => Promise.resolve("a")),
      cb.execute(() => Promise.resolve("b")),
      cb.execute(() => Promise.resolve("c")),
      cb.execute(() => Promise.resolve("d")),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBe(4);
    expect(cb.currentState).toBe(CircuitState.CLOSED);
  });

  // ============================
  // 全生命周期
  // ============================
  it("CLOSED → OPEN → HALF_OPEN → CLOSED 完整流程", async () => {
    const cb = fastBreaker(2, 20);

    // CLOSED → OPEN
    await expect(cb.execute(() => Promise.reject(new Error("故障1")))).rejects.toThrow();
    await expect(cb.execute(() => Promise.reject(new Error("故障2")))).rejects.toThrow();
    expect(cb.currentState).toBe(CircuitState.OPEN);

    // OPEN → HALF_OPEN（超时后）
    await new Promise((r) => setTimeout(r, 30));

    // HALF_OPEN → CLOSED（探测成功）
    const result = await cb.execute(() => Promise.resolve("恢复"));
    expect(result).toBe("恢复");
    expect(cb.currentState).toBe(CircuitState.CLOSED);

    // CLOSED 后正常工作
    const result2 = await cb.execute(() => Promise.resolve("继续"));
    expect(result2).toBe("继续");
  });

  // ============================
  // CircuitBreakerOpenError
  // ============================
  it("CircuitBreakerOpenError 有正确的 name", () => {
    const err = new CircuitBreakerOpenError();
    expect(err.name).toBe("CircuitBreakerOpenError");
  });

  it("CircuitBreakerOpenError 支持自定义消息", () => {
    const err = new CircuitBreakerOpenError("自定义");
    expect(err.message).toBe("自定义");
  });
});
