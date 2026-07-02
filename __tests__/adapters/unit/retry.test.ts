/**
 * Retry 算法单元测试。
 *
 * 验证指数退避数学、jitter 分布、状态码判断、
 * AbortSignal 取消、重试耗尽等行为。
 */

import { describe, it, expect, vi } from "vitest";
import { withRetry, computeBackoff, type RetryOptions } from "../../../src/adapters/shared/retry.js";

// ============================
// computeBackoff 测试
// ============================

describe("computeBackoff", () => {
  it("返回正确的指数退避值", () => {
    // 无 jitter 模式: delay = initialDelay * 2^(attempt-1)
    const opts: RetryOptions = { initialDelayMs: 200, jitter: false };

    expect(computeBackoff(1, opts)).toBe(200);
    expect(computeBackoff(2, opts)).toBe(400);
    expect(computeBackoff(3, opts)).toBe(800);
    expect(computeBackoff(4, opts)).toBe(1600);
  });

  it("退避值不超过 maxDelay 上限", () => {
    const opts: RetryOptions = { initialDelayMs: 1000, maxDelayMs: 5000, jitter: false };

    // attempt 1: 1000
    // attempt 2: 2000
    // attempt 3: 4000
    // attempt 4: 8000 → capped at 5000
    expect(computeBackoff(4, opts)).toBe(5000);
    expect(computeBackoff(5, opts)).toBe(5000);
  });

  it("jitter 值在 [delay/2, delay] 范围内（1000 样本验证）", () => {
    const opts: RetryOptions = { initialDelayMs: 1000, jitter: true };

    for (let i = 0; i < 1000; i++) {
      const delay = computeBackoff(1, opts);
      expect(delay).toBeGreaterThanOrEqual(500); // delay/2
      expect(delay).toBeLessThanOrEqual(1000);   // delay
    }
  });

  it("jitter=false 时返回精确值", () => {
    const opts: RetryOptions = { initialDelayMs: 500, jitter: false };
    const delays = new Set<number>();

    for (let i = 0; i < 100; i++) {
      delays.add(computeBackoff(1, opts));
    }

    // 无抖动 → 所有值相同
    expect(delays.size).toBe(1);
    expect(delays.has(500)).toBe(true);
  });

  it("使用默认值", () => {
    const delay = computeBackoff(1, { jitter: false });
    expect(delay).toBe(200); // 默认 initialDelayMs = 200
  });
});

// ============================
// withRetry 行为测试
// ============================

describe("withRetry", () => {
  it("成功时返回结果（不重试）", async () => {
    const fn = vi.fn().mockResolvedValue("success");

    const result = await withRetry(fn, { maxAttempts: 0 });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("首次失败后重试成功", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("网络错误"))
      .mockResolvedValueOnce("retry-success");

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });

    expect(result).toBe("retry-success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("重试耗尽所有尝试后抛出最后一个错误", async () => {
    const error = new Error("持续失败");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false }),
    ).rejects.toThrow("持续失败");

    expect(fn).toHaveBeenCalledTimes(4); // 1次原始 + 3次重试
  });

  it("不可重试的 HTTP 状态码不重试（400）", async () => {
    const error = { status: 400, message: "Bad Request" };
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 }),
    ).rejects.toMatchObject({ status: 400 });

    // 400 不可重试 → 只尝试一次
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("不可重试的 HTTP 状态码不重试（401）", async () => {
    const error = { status: 401, message: "Unauthorized" };
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 }),
    ).rejects.toMatchObject({ status: 401 });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("可重试的 HTTP 状态码触发重试（500）", async () => {
    const error500 = { status: 500, message: "Internal Server Error" };
    const success = "recovered";
    const fn = vi.fn()
      .mockRejectedValueOnce(error500)
      .mockResolvedValueOnce(success);

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });

    expect(result).toBe(success);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("可重试的 HTTP 状态码触发重试（503）", async () => {
    const error503 = { status: 503, message: "Service Unavailable" };
    const success = "recovered";
    const fn = vi.fn()
      .mockRejectedValueOnce(error503)
      .mockResolvedValueOnce(success);

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });

    expect(result).toBe(success);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("网络错误（无状态码）触发重试", async () => {
    const networkError = new Error("ECONNREFUSED");
    const fn = vi.fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("AbortError 不重试", async () => {
    const abortErr = new DOMException("已取消", "AbortError");
    const fn = vi.fn().mockRejectedValue(abortErr);

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 }),
    ).rejects.toThrow("已取消");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("AbortSignal 取消等待中的重试", async () => {
    const controller = new AbortController();
    const error = new Error("临时错误");
    const fn = vi.fn().mockRejectedValue(error);

    // 第一次失败后立即取消
    setTimeout(() => controller.abort(), 5);

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    // 应该只尝试了 1 次（第一次失败后 signal 已 abort）
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("onRetry 回调在每次重试前触发", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("失败1"))
      .mockRejectedValueOnce(new Error("失败2"))
      .mockResolvedValueOnce("成功");

    await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 1, 10);
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 2, 20);
  });

  it("maxAttempts=0 表示不重试", async () => {
    const error = new Error("失败");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxAttempts: 0, initialDelayMs: 10 })).rejects.toThrow("失败");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("自定义 shouldRetry 函数覆盖默认行为", async () => {
    // 让 400 也可重试
    const shouldRetry = vi.fn().mockReturnValue(true);
    const error400 = { status: 400, message: "Bad Request" };
    const success = "ok";
    const fn = vi.fn()
      .mockRejectedValueOnce(error400)
      .mockResolvedValueOnce(success);

    const result = await withRetry(fn, {
      maxAttempts: 1,
      initialDelayMs: 10,
      jitter: false,
      shouldRetry,
    });

    expect(result).toBe(success);
    expect(shouldRetry).toHaveBeenCalledWith(error400, 1);
  });

  it("shouldRetry 返回 false 时不重试", async () => {
    const shouldRetry = vi.fn().mockReturnValue(false);
    const error = new Error("不重试");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, shouldRetry }),
    ).rejects.toThrow("不重试");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("409 Conflict 不重试", async () => {
    const error = { status: 409, message: "Conflict" };
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 10 }),
    ).rejects.toMatchObject({ status: 409 });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("429 Too Many Requests 触发重试", async () => {
    const error = { status: 429, message: "Rate limited" };
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, jitter: false });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
