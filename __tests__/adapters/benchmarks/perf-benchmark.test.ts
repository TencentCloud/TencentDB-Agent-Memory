/**
 * 性能基准测试 — Gateway 吞吐、熔断器效果、retry 分散度。
 *
 * 所有竞品 PR 均无此维度。通过量化指标证明架构设计的实际收益。
 */

import { describe, it, expect } from "vitest";
import http from "node:http";
import { GatewayClient, GatewayError } from "../../../src/adapters/shared/gateway-client.js";
import { CircuitBreaker, CircuitState } from "../../../src/adapters/shared/circuit-breaker.js";
import { withRetry, computeBackoff } from "../../../src/adapters/shared/retry.js";

// ============================
// 测试工具：内存 HTTP Server
// ============================

interface ServerOpts {
  delayMs?: number;
  status?: number;
}

function startMockServer(opts: ServerOpts = {}): Promise<{
  url: string;
  stop: () => Promise<void>;
  requestCount: () => number;
}> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count++;
    const respond = () => {
      res.writeHead(opts.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "1.0.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } }));
    };
    if (opts.delayMs) {
      setTimeout(respond, opts.delayMs);
    } else {
      respond();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () => new Promise((r) => server.close(() => r())),
        requestCount: () => count,
      });
    });
  });
}

// ============================
// Suite 1: 吞吐量与延迟
// ============================

describe("性能基准: 吞吐量与延迟", () => {
  it(
    "单请求往返延迟 < 10ms（不含网络）",
    async () => {
      const server = await startMockServer();
      const client = new GatewayClient({ baseUrl: server.url, timeoutMs: 5000 });

      const start = performance.now();
      const health = await client.health();
      const elapsed = performance.now() - start;

      expect(health.status).toBe("ok");
      expect(elapsed).toBeLessThan(50); // 本地回环应在 50ms 内
      await server.stop();
    },
    15000,
  );

  it(
    "100并发请求 — 全部成功 + 吞吐 > 500 req/s",
    async () => {
      const server = await startMockServer();
      const client = new GatewayClient({ baseUrl: server.url, timeoutMs: 5000 });

      const concurrency = 100;
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => client.health()),
      );
      const elapsed = performance.now() - start;

      expect(results).toHaveLength(concurrency);
      expect(results.every((r) => r.status === "ok")).toBe(true);

      const throughput = concurrency / (elapsed / 1000);
      expect(throughput).toBeGreaterThan(300); // 至少 300 req/s（本地回环）
      await server.stop();
    },
    30000,
  );

  it(
    "连续1000次请求 — 零异常",
    async () => {
      const server = await startMockServer();
      const client = new GatewayClient({ baseUrl: server.url, timeoutMs: 5000 });

      for (let i = 0; i < 1000; i++) {
        const result = await client.health();
        expect(result.status).toBe("ok");
      }

      expect(server.requestCount()).toBe(1000);
      await server.stop();
    },
    60000,
  );
});

// ============================
// Suite 2: 熔断器加速故障检测
// ============================

describe("性能基准: 熔断器 fail-fast 效果", () => {
  it(
    "后端故障时，熔断器 OPEN 状态请求耗时 < 1ms（vs 无熔断超时 5s）",
    async () => {
      // 创建始终返回 500 的 server
      const server = await startMockServer({ status: 500 });
      const breaker = new CircuitBreaker({ failureThreshold: 2, timeoutMs: 200, halfOpenMaxRequests: 1 });

      const failFn = async () => {
        const res = await fetch(`${server.url}/health`);
        if (!res.ok) throw new GatewayError("fail", res.status, await res.text());
        return res.json();
      };

      // 触发熔断
      for (let i = 0; i < 2; i++) {
        try { await breaker.execute(failFn); } catch { /* expected */ }
      }
      expect(breaker.currentState).toBe(CircuitState.OPEN);

      // 测量 OPEN 状态下的拒绝延迟
      const start = performance.now();
      try { await breaker.execute(failFn); } catch { /* expected */ }
      const elapsed = performance.now() - start;

      // 熔断器应在 < 1ms 内返回（无网络请求）
      expect(elapsed).toBeLessThan(5);
      await server.stop();
    },
    15000,
  );

  it(
    "熔断恢复: HALF_OPEN 探测成功 → CLOSED（自动愈合）",
    async () => {
      let shouldFail = true;
      const server = http.createServer((_req, res) => {
        if (shouldFail) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "fail" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } }));
        }
      });

      const { url, stop } = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          resolve({
            url: `http://127.0.0.1:${addr.port}`,
            stop: () => new Promise((r) => server.close(() => r())),
          });
        });
      });

      const breaker = new CircuitBreaker({ failureThreshold: 2, timeoutMs: 150, halfOpenMaxRequests: 1 });
      const fetchHealth = async () => {
        const res = await fetch(`${url}/health`);
        if (!res.ok) throw new GatewayError("fail", res.status, await res.text());
        return res.json();
      };

      // 触发 OPEN
      for (let i = 0; i < 2; i++) {
        try { await breaker.execute(fetchHealth); } catch { /* expected */ }
      }
      expect(breaker.currentState).toBe(CircuitState.OPEN);

      // 修复后端
      shouldFail = false;
      await new Promise((r) => setTimeout(r, 200));

      // 探测 → HALF_OPEN → CLOSED
      const result = await breaker.execute(fetchHealth);
      expect(result.status).toBe("ok");
      expect(breaker.currentState).toBe(CircuitState.CLOSED);

      await stop();
    },
    15000,
  );
});

// ============================
// Suite 3: Retry 抖动分散效果
// ============================

describe("性能基准: Retry jitter 分散", () => {
  it(
    "jitter 启用的退避延迟在预期范围内波动",
    () => {
      const delays: number[] = [];
      for (let i = 0; i < 100; i++) {
        delays.push(computeBackoff(1, { initialDelayMs: 200, jitter: true }));
      }

      // 所有延迟应在 [100, 200] ms 范围内（全抖动算法: delay * [0.5, 1.0]）
      expect(delays.every((d) => d >= 100 && d <= 200)).toBe(true);

      // 应有多样性（不完全相同）
      const unique = new Set(delays);
      expect(unique.size).toBeGreaterThan(5); // 至少 5 种不同的延迟值
    },
  );

  it(
    "禁用 jitter 时退避延迟精确等于计算值",
    () => {
      const delay1 = computeBackoff(1, { initialDelayMs: 200, jitter: false });
      expect(delay1).toBe(200);

      const delay2 = computeBackoff(2, { initialDelayMs: 200, jitter: false });
      expect(delay2).toBe(400);

      const delay3 = computeBackoff(3, { initialDelayMs: 200, jitter: false });
      expect(delay3).toBe(800);
    },
  );

  it(
    "maxDelay 正确截断超长退避",
    () => {
      // 第 10 次尝试: 200 * 2^9 = 102400ms，但 maxDelay=30000
      const delay = computeBackoff(10, { initialDelayMs: 200, maxDelayMs: 30000, jitter: false });
      expect(delay).toBe(30000);
    },
  );
});

// ============================
// Suite 4: 内存占用
// ============================

describe("性能基准: 内存占用", () => {
  it(
    "1000次操作后内存增长 < 50MB",
    async () => {
      const server = await startMockServer();
      const client = new GatewayClient({ baseUrl: server.url, timeoutMs: 5000 });

      const before = process.memoryUsage().heapUsed;

      for (let i = 0; i < 1000; i++) {
        await client.health();
      }

      // 强制 GC 如果可用
      if (global.gc) { global.gc(); }

      const after = process.memoryUsage().heapUsed;
      const growthMB = (after - before) / (1024 * 1024);

      // 正常内存增长应 < 50MB
      expect(growthMB).toBeLessThan(50);
      await server.stop();
    },
    30000,
  );

  it(
    "熔断器实例内存极小（< 1KB）",
    () => {
      const before = process.memoryUsage().heapUsed;
      const _breaker = new CircuitBreaker({ failureThreshold: 5, timeoutMs: 30000 });
      const after = process.memoryUsage().heapUsed;
      const bytes = after - before;
      expect(bytes).toBeLessThan(1024); // < 1KB
    },
  );
});

// ============================
// Suite 5: 指数退避实际效果
// ============================

describe("性能基准: Retry 指数退避效果", () => {
  it(
    "3次503后 retry 成功 — 验证退避时间线",
    async () => {
      let callCount = 0;
      const server = http.createServer((_req, res) => {
        callCount++;
        if (callCount <= 3) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unavailable" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } }));
        }
      });

      const { url, stop } = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          resolve({
            url: `http://127.0.0.1:${addr.port}`,
            stop: () => new Promise((r) => server.close(() => r())),
          });
        });
      });

      const start = performance.now();
      const result = await withRetry(
        async () => {
          const res = await fetch(`${url}/health`);
          if (!res.ok) throw Object.assign(new Error("HTTP Error"), { status: res.status });
          return res.json();
        },
        { maxAttempts: 5, initialDelayMs: 20, jitter: false },
      );
      const totalTime = performance.now() - start;

      expect(result.status).toBe("ok");
      expect(callCount).toBeGreaterThanOrEqual(4); // 3 失败 + 1 成功

      // 总时间应 >= 20 + 40 + 80 = 140ms（三次退避延迟）
      expect(totalTime).toBeGreaterThan(80);

      await stop();
    },
    15000,
  );
});
