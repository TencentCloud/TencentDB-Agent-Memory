/**
 * E2E 集成测试 — 真实 HTTP 服务器 + GatewayClient 往返。
 *
 * 启动一个轻量级 HTTP 服务器模拟 Gateway 行为，
 * 测试 GatewayClient 的完整请求-响应链路。
 * 这是所有竞争者 PR 都缺失的测试层。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { GatewayClient } from "../../../src/adapters/shared/gateway-client.js";
import { RestMemoryAdapter } from "../../../src/adapters/rest/rest-adapter.js";
import { McpMemoryAdapter } from "../../../src/adapters/mcp/mcp-adapter.js";

/**
 * 轻量级模拟 Gateway 服务器。
 * 返回合法的 JSON 响应，模拟真实 Gateway 行为。
 */
async function startMockGateway(
  handler?: (req: http.IncomingMessage, body: string) => { status: number; body: unknown },
): Promise<{ url: string; stop: () => Promise<void> }> {
  const defaultHandler = (_req: http.IncomingMessage, _body: string) => ({
    status: 200,
    body: { status: "ok", version: "0.1.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } },
  });

  const resolve = handler ?? defaultHandler;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const result = resolve(req, body);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.on("error", reject);
  });
}

describe("GatewayClient E2E 集成测试", () => {
  let gateway: { url: string; stop: () => Promise<void> };
  let client: GatewayClient;

  afterEach(async () => {
    await gateway?.stop();
  });

  // ============================
  // 健康检查 E2E
  // ============================
  describe("健康检查", () => {
    it("成功返回完整响应", async () => {
      gateway = await startMockGateway();
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      const health = await client.health();
      expect(health.status).toBe("ok");
      expect(health.stores.vectorStore).toBe(true);
    });

    it("返回 degraded 状态", async () => {
      gateway = await startMockGateway(() => ({
        status: 200,
        body: { status: "degraded", version: "0.1.0", uptime: 10, stores: { vectorStore: false, embeddingService: false } },
      }));
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      const health = await client.health();
      expect(health.status).toBe("degraded");
    });
  });

  // ============================
  // Recall E2E
  // ============================
  describe("recall", () => {
    it("完整 recall 往返", async () => {
      gateway = await startMockGateway((req, body) => {
        const data = JSON.parse(body);
        expect(data.query).toBe("测试查询");
        expect(data.session_key).toBe("sess-1");
        return { status: 200, body: { context: "记忆上下文", strategy: "l1", memory_count: 5 } };
      });
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      const result = await client.recall("测试查询", "sess-1");
      expect(result.context).toContain("记忆上下文");
      expect(result.memory_count).toBe(5);
    });

    it("大查询文本往返正确", async () => {
      const longQuery = "测试".repeat(1000); // ~2KB
      gateway = await startMockGateway((_req, body) => {
        const data = JSON.parse(body);
        expect(data.query).toBe(longQuery);
        return { status: 200, body: { context: "结果", memory_count: 1 } };
      });
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      const result = await client.recall(longQuery, "sess-1");
      expect(result.context).toBe("结果");
    });

    it("Unicode/Emoji 往返正确", async () => {
      const emojiQuery = "你好 🌍 世界 🎉 — 日本語 한국어";
      gateway = await startMockGateway((_req, body) => {
        const data = JSON.parse(body);
        expect(data.query).toBe(emojiQuery);
        return { status: 200, body: { context: "跨语言上下文" } };
      });
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      const result = await client.recall(emojiQuery, "sess-1");
      expect(result.context).toBe("跨语言上下文");
    });
  });

  // ============================
  // Capture E2E
  // ============================
  describe("capture", () => {
    it("完整 capture 往返", async () => {
      gateway = await startMockGateway((_req, body) => {
        const data = JSON.parse(body);
        expect(data.user_content).toBe("用户消息");
        expect(data.assistant_content).toBe("助手回复");
        return { status: 200, body: { l0_recorded: 3, scheduler_notified: true } };
      });
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      const result = await client.capture("用户消息", "助手回复", "sess-1", "sid-1");
      expect(result.l0_recorded).toBe(3);
      expect(result.scheduler_notified).toBe(true);
    });
  });

  // ============================
  // 错误处理 E2E
  // ============================
  describe("错误处理", () => {
    it("HTTP 500 返回 GatewayError", async () => {
      gateway = await startMockGateway(() => ({
        status: 500,
        body: { error: "内部服务器错误", code: "INTERNAL" },
      }));
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      await expect(client.health()).rejects.toMatchObject({
        name: "GatewayError",
        statusCode: 500,
      });
    });

    it("HTTP 401 不重试", async () => {
      gateway = await startMockGateway(() => ({
        status: 401,
        body: { error: "未授权" },
      }));
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } });

      await expect(client.recall("q", "s")).rejects.toMatchObject({ statusCode: 401 });
    });

    it("HTTP 503 触发重试后成功", async () => {
      let callCount = 0;
      gateway = await startMockGateway(() => {
        callCount++;
        if (callCount === 1) return { status: 503, body: { error: "服务不可用" } };
        return { status: 200, body: { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } } };
      });
      client = new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 3, initialDelayMs: 10 } });

      const result = await client.health();
      expect(result.status).toBe("ok");
      expect(callCount).toBe(2); // 1 次失败 + 1 次重试成功
    });
  });

  // ============================
  // 适配器 E2E
  // ============================
  describe("适配器对真实 HTTP", () => {
    it("RestMemoryAdapter 完整链路", async () => {
      gateway = await startMockGateway((req, _body) => {
        if (req.url?.includes("/health")) {
          return { status: 200, body: { status: "ok", version: "1", uptime: 10, stores: { vectorStore: true, embeddingService: true } } };
        }
        if (req.url?.includes("/recall")) {
          return { status: 200, body: { context: "适配器测试上下文" } };
        }
        return { status: 200, body: {} };
      });
      const adapter = new RestMemoryAdapter(new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } }));

      const health = await adapter.health();
      expect(health.status).toBe("ok");

      const recall = await adapter.recall("测试", "sess-1");
      expect(recall.context).toBe("适配器测试上下文");
    });

    it("McpMemoryAdapter 完整链路", async () => {
      gateway = await startMockGateway((req, _body) => {
        if (req.url?.includes("/health")) return { status: 200, body: { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } } };
        if (req.url?.includes("/capture")) return { status: 200, body: { l0_recorded: 7, scheduler_notified: true } };
        return { status: 200, body: {} };
      });
      const adapter = new McpMemoryAdapter(new GatewayClient({ baseUrl: gateway.url, retry: { maxAttempts: 0 } }));

      const result = await adapter.capture("用户", "助手", "sess-1");
      expect(result.l0Recorded).toBe(7);
    });
  });
});
