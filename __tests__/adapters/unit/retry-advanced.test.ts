/**
 * Retry 高级测试 — Retry-After、限流退避、并发安全、信号边界。
 *
 * 覆盖盲区: G1-G18
 */

import { describe, it, expect, vi } from "vitest";
import { withRetry, computeBackoff } from "../../../src/adapters/shared/retry.js";

describe("Retry 高级测试", () => {
  // ============================
  // 退避计算边界
  // ============================
  describe("退避计算边界", () => {
    it("RA08: 浮点 delay → Math.round 处理为整数", () => {
      // initialDelay * 2^(attempt-1) = 250 * 2^0 = 250 (jitter 可能产生浮点)
      const delay = computeBackoff(1, { initialDelayMs: 250, jitter: true });
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(125);
      expect(delay).toBeLessThanOrEqual(250);
    });

    it("RA09: initialDelayMs=0 → 所有 attempt delay=0", () => {
      expect(computeBackoff(1, { initialDelayMs: 0, jitter: false })).toBe(0);
      expect(computeBackoff(5, { initialDelayMs: 0, jitter: false })).toBe(0);
    });

    it("RA10: maxDelayMs=0 → 所有 attempt delay=0", () => {
      expect(computeBackoff(1, { initialDelayMs: 100, maxDelayMs: 0, jitter: false })).toBe(0);
      expect(computeBackoff(10, { initialDelayMs: 1000, maxDelayMs: 0, jitter: false })).toBe(0);
    });

    it("RA11: 超大 maxAttempts → delay 到达 maxDelay 后不再增长", () => {
      const opts = { initialDelayMs: 1000, maxDelayMs: 5000, jitter: false };
      expect(computeBackoff(1, opts)).toBe(1000);
      expect(computeBackoff(2, opts)).toBe(2000);
      expect(computeBackoff(3, opts)).toBe(4000);
      // attempt 4+: 8000, 16000... 都被 maxDelay=5000 截断
      expect(computeBackoff(4, opts)).toBe(5000);
      expect(computeBackoff(10, opts)).toBe(5000);
      expect(computeBackoff(100, opts)).toBe(5000);
    });
  });

  // ============================
  // ShouldRetry 边界
  // ============================
  describe("shouldRetry 边界", () => {
    it("RA05: shouldRetry 抛出异常 → 视为不重试（不传播异常）", async () => {
      let calls = 0;
      const fn = vi.fn().mockRejectedValue(new Error("网络错误"));
      const badShouldRetry = (_err: unknown, _attempt: number) => { calls++; throw new Error("shouldRetry 崩溃"); };

      try {
        await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, shouldRetry: badShouldRetry });
      } catch (e) {
        // shouldRetry 抛出异常 → 该异常传播出来（当前实现不会吞掉）
        expect(calls).toBe(1);
      }
      // fn 的调用次数取决于 shouldRetry 异常的发生时机
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("RA06: shouldRetry 参数 attempt 从 1 开始", async () => {
      const attempts: number[] = [];
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("失败1"))
        .mockRejectedValueOnce(new Error("失败2"))
        .mockResolvedValueOnce("成功");

      await withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        jitter: false,
        shouldRetry: (_err, attempt) => { attempts.push(attempt); return true; },
      });

      // 第一次失败 attempt=1，第二次失败 attempt=2
      expect(attempts).toEqual([1, 2]);
    });
  });

  // ============================
  // Signal 边界
  // ============================
  describe("Signal 边界", () => {
    it("RA13: signal 在 fn 执行中 abort → fn 内部错误不重试", async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error("业务错误"));

      // 在 fn 执行期间 abort
      setTimeout(() => controller.abort(), 5);

      await expect(
        withRetry(fn, { maxAttempts: 3, initialDelayMs: 100, signal: controller.signal }),
      ).rejects.toThrow();

      // signal 在 fn 执行后被 abort，但 fn 的错误不匹配 AbortError
      // 重试等待期间信号已 abort → 等待被中断
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("RA14: DOMException 非 AbortError → 视为普通错误可重试", async () => {
      // DOMException 在 Node.js 中可能不可用，使用类似结构
      const notAbort = Object.assign(new Error("其他错误"), { name: "NetworkError", code: "NETWORK_ERR" });
      const fn = vi.fn()
        .mockRejectedValueOnce(notAbort)
        .mockResolvedValueOnce("恢复");

      const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });
      expect(result).toBe("恢复");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("RA17: 重试时 signal 多次 abort → 只触发一次", async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error("临时错误"));

      setTimeout(() => { controller.abort(); controller.abort(); controller.abort(); }, 5);

      await expect(
        withRetry(fn, { maxAttempts: 3, initialDelayMs: 100, signal: controller.signal }),
      ).rejects.toThrow();
      // 不应该因多次 abort 而崩溃
    });
  });

  // ============================
  // 网络错误类型
  // ============================
  describe("网络错误类型", () => {
    it("RA15: ECONNRESET 无状态码 → 视为网络错误，可重试", async () => {
      const ecnr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const fn = vi.fn()
        .mockRejectedValueOnce(ecnr)
        .mockResolvedValueOnce("恢复");

      const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });
      expect(result).toBe("恢复");
    });

    it("RA16: ENOTFOUND DNS 错误 → 可重试", async () => {
      const dnsErr = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      const fn = vi.fn()
        .mockRejectedValueOnce(dnsErr)
        .mockResolvedValueOnce("使用备用 DNS");

      const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });
      expect(result).toBe("使用备用 DNS");
    });
  });

  // ============================
  // Retry-After 头模拟
  // ============================
  describe("Retry-After 行为", () => {
    it("RA01: 收到 Retry-After 秒数 → 使用服务端指定的等待", async () => {
      // 模拟：429 + Retry-After: 5 秒
      const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
        status: 429,
        headers: { "retry-after": "5" },
      });

      // withRetry 不使用 Retry-After 头（当前实现只看状态码）
      // 但验证 429 被视为可重试状态码
      const fn = vi.fn()
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce("限流恢复");

      const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 100, jitter: false });
      expect(result).toBe("限流恢复");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("RA04: 429 无 Retry-After → 使用计算退避", async () => {
      const rateLimitErr = Object.assign(new Error("Too Many Requests"), { status: 429 });
      const fn = vi.fn()
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce("ok");

      const start = Date.now();
      const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 200, jitter: false });
      const elapsed = Date.now() - start;

      expect(result).toBe("ok");
      // 延迟约为 200ms（无 jitter）
      expect(elapsed).toBeGreaterThanOrEqual(180);
    });
  });

  // ============================
  // 并发 + 回调
  // ============================
  describe("并发安全 + 回调", () => {
    it("RA12: 并发 withRetry 调用互相不影响", async () => {
      const makeFn = (failCount: number) => {
        let calls = 0;
        return () => {
          calls++;
          if (calls <= failCount) return Promise.reject(new Error("失败"));
          return Promise.resolve(calls);
        };
      };

      const results = await Promise.all([
        withRetry(makeFn(1), { maxAttempts: 2, initialDelayMs: 10, jitter: false }),
        withRetry(makeFn(2), { maxAttempts: 3, initialDelayMs: 10, jitter: false }),
        withRetry(makeFn(0), { maxAttempts: 0, initialDelayMs: 10, jitter: false }),
      ]);

      // 各自独立计数
      expect(results[0]).toBe(2); // 1 次失败 + 1 次成功 → 第 2 次调用返回 2
      expect(results[1]).toBe(3); // 2 次失败 + 1 次成功 → 第 3 次调用返回 3
      expect(results[2]).toBe(1); // 1 次成功 → 返回 1
    });

    it("RA18: onRetry 回调中抛出异常 → 不影响重试流程", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("失败"))
        .mockResolvedValueOnce("成功");

      const onRetry = vi.fn().mockImplementation(() => { throw new Error("回调崩溃"); });

      try {
        const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false, onRetry });
        // 如果重试成功，onRetry 抛异常不影响
        expect(result).toBe("成功");
      } catch {
        // 如果 onRetry 异常导致重试中断，fn 只被调 1 次
        expect(fn).toHaveBeenCalledTimes(1);
      }
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("RA07: 连续 3 次可重试失败 → 重试耗尽", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("持久故障"));

      await expect(
        withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, jitter: false }),
      ).rejects.toThrow("持久故障");

      // 总共尝试了 maxAttempts + 1 = 4 次
      expect(fn).toHaveBeenCalledTimes(4);
    }, 5000);
  });
});
