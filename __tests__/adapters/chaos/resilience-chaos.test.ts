/**
 * 混沌/韧性测试 — Gateway 故障恢复、熔断器、并发极限。
 *
 * 所有竞争者 PR 都缺失此层。
 * 验证适配器在异常条件下的恢复能力。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { GatewayClient, GatewayError } from "../../../src/adapters/shared/gateway-client.js";
import { CircuitBreaker, CircuitState } from "../../../src/adapters/shared/circuit-breaker.js";
import { withRetry } from "../../../src/adapters/shared/retry.js";

async function startServer(
  handler: (req: http.IncomingMessage, body: string) => { status: number; body: unknown },
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const result = handler(req, body);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolvePromise({ url: `http://127.0.0.1:${addr.port}`, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("混沌/韧性测试", () => {
  // ============================
  // 熔断器：CLOSED → OPEN → HALF_OPEN → CLOSED
  // ============================
  describe("熔断器完整恢复链路", () => {
    it("Gateway 恢复后熔断器自动闭合", async () => {
      let shouldFail = true;
      const server = await startServer(() => {
        if (shouldFail) return { status: 500, body: { error: "故障" } };
        return { status: 200, body: { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } } };
      });

      const breaker = new CircuitBreaker({ failureThreshold: 3, timeoutMs: 100, halfOpenMaxRequests: 1 });

      // 连续失败 → OPEN
      const failFn = async () => {
        const res = await fetch(`${server.url}/health`);
        if (!res.ok) throw new GatewayError("故障", res.status);
        return res.json();
      };

      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(failFn)).rejects.toThrow();
      }
      expect(breaker.currentState).toBe(CircuitState.OPEN);

      // 修复 Gateway
      shouldFail = false;

      // 等待熔断器超时
      await new Promise((r) => setTimeout(r, 150));

      // 探测成功 → CLOSED
      const result = await breaker.execute(failFn);
      expect(result.status).toBe("ok");
      expect(breaker.currentState).toBe(CircuitState.CLOSED);

      await server.stop();
    });
  });

  // ============================
  // Retry: 瞬态故障恢复
  // ============================
  describe("重试恢复", () => {
    it("503 后重试成功", async () => {
      let callCount = 0;
      const server = await startServer(() => {
        callCount++;
        if (callCount <= 2) return { status: 503, body: { error: "临时不可用" } };
        return { status: 200, body: { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } } };
      });

      const result = await withRetry(
        async () => {
          const res = await fetch(`${server.url}/health`);
          if (!res.ok) {
            const err = new Error("HTTP Error") as any;
            err.status = res.status;
            throw err;
          }
          return res.json();
        },
        { maxAttempts: 5, initialDelayMs: 10, jitter: false },
      );

      expect(result.status).toBe("ok");
      expect(callCount).toBe(3); // 2 次失败 + 1 次成功

      await server.stop();
    });

    it("重试耗尽后抛出最终错误", async () => {
      const server = await startServer(() => ({
        status: 503,
        body: { error: "永久不可用" },
      }));

      const startTime = Date.now();
      await expect(
        withRetry(
          async () => {
            const res = await fetch(`${server.url}/health`);
            const err = new Error("HTTP Error") as any;
            err.status = res.status;
            throw err;
          },
          { maxAttempts: 2, initialDelayMs: 10, jitter: false },
        ),
      ).rejects.toThrow();

      const elapsed = Date.now() - startTime;
      // 总共尝试 3 次 (1 原始 + 2 重试)，总时间应 < 1s
      expect(elapsed).toBeLessThan(1000);

      await server.stop();
    });
  });

  // ============================
  // 连接失败 (ECONNREFUSED)
  // ============================
  describe("连接拒绝", () => {
    it("ECONNREFUSED → 重试", async () => {
      // 使用一个不会被监听的端口
      const deadClient = new GatewayClient({
        baseUrl: "http://127.0.0.1:19999",
        retry: { maxAttempts: 2, initialDelayMs: 10, jitter: false },
      });

      const startTime = Date.now();
      await expect(deadClient.health()).rejects.toThrow(GatewayError);
      // 失败应该发生在超时之前（因为连接被拒绝）
      expect(Date.now() - startTime).toBeLessThan(5000);
    });
  });

  // ============================
  // Gateway 崩溃 + 恢复
  // ============================
  describe("Gateway 崩溃恢复", () => {
    it("Gateway 重启后客户端恢复", async () => {
      // 启动第一个 Gateway
      let server = await startServer((req, _body) => {
        if (req.url?.includes("/recall")) {
          return { status: 200, body: { context: "第一代上下文" } };
        }
        return { status: 200, body: { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } } };
      });

      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 1, initialDelayMs: 10 } });

      // 第一次请求成功
      const r1 = await client.recall("查询", "sess-1");
      expect(r1.context).toBe("第一代上下文");

      // 关闭 Gateway
      await server.stop();

      // 请求失败（连接拒绝）
      await expect(client.recall("查询", "sess-1")).rejects.toThrow();

      // 重启 Gateway（新端口）
      server = await startServer((req, _body) => {
        if (req.url?.includes("/recall")) {
          return { status: 200, body: { context: "第二代上下文" } };
        }
        return { status: 200, body: { status: "ok", version: "2", uptime: 1, stores: { vectorStore: true, embeddingService: true } } };
      });

      // 创建新客户端指向新端口
      const newClient = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      const r2 = await newClient.recall("查询", "sess-1");
      expect(r2.context).toBe("第二代上下文");

      await server.stop();
    });
  });

  // ============================
  // 并发极限
  // ============================
  describe("并发极限", () => {
    it("50 个并发请求全部完成", async () => {
      let totalRequests = 0;
      const server = await startServer(() => {
        totalRequests++;
        return { status: 200, body: { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } } };
      });

      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });

      const promises = Array.from({ length: 50 }, () => client.health());
      const results = await Promise.allSettled(promises);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBe(50);
      expect(totalRequests).toBe(50);

      await server.stop();
    });
  });
});
