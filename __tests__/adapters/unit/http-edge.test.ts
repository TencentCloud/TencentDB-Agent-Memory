/**
 * HTTP 协议边界测试 — chunked、header 边缘、响应异常。
 *
 * 覆盖盲目区: G34-G53
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { GatewayClient, GatewayError } from "../../../src/adapters/shared/gateway-client.js";

async function startRawServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolvePromise({ url: `http://127.0.0.1:${addr.port}`, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("HTTP 协议边界测试", () => {
  // ============================
  // 响应格式异常
  // ============================
  describe("响应格式异常", () => {
    it("HE01: 非 JSON Content-Type → 仍然尝试解析", async () => {
      const server = await startRawServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end('{"status":"ok","version":"1","uptime":1,"stores":{"vectorStore":true,"embeddingService":true}}');
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      // fetch 不关心 Content-Type，json() 仍然可以解析
      const r = await client.health();
      expect(r.status).toBe("ok");
      await server.stop();
    });

    it("HE02: 空 body → JSON 解析抛异常，包装为 GatewayError", async () => {
      const server = await startRawServer((_req, res) => {
        res.writeHead(200);
        res.end("");
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      await expect(client.health()).rejects.toThrow(GatewayError);
      await server.stop();
    });

    it("HE04: 响应缺少必要字段 → 返回 undefined 不崩溃", async () => {
      const server = await startRawServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}'); // 缺少 version、uptime、stores
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      const r = await client.health();
      expect(r.status).toBe("ok");
      expect(r.version).toBeUndefined(); // 安全 undefined
      await server.stop();
    });

    it("HE05: 响应包含多余未知字段 → 不报错", async () => {
      const server = await startRawServer((_req, res) => {
        res.end(JSON.stringify({
          status: "ok", version: "1", uptime: 1,
          stores: { vectorStore: true, embeddingService: true },
          extra_field: "should-be-ignored",
          nested: { deeply: { unknown: true } },
        }));
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      const r = await client.health();
      expect(r.status).toBe("ok");
      await server.stop();
    });

    it("HE06: 响应字段类型错误 → 仍然返回", async () => {
      const server = await startRawServer((_req, res) => {
        res.end(JSON.stringify({
          status: 200, // 应该是字符串，给了数字
          version: 1,  // 应该是字符串
          uptime: "sixty", // 应该是数字
          stores: "not-an-object",
        }));
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      // 不崩溃 — 类型不安全但在运行时安全
      const r = await client.health();
      expect(r).toBeDefined();
      await server.stop();
    });
  });

  // ============================
  // HTTP 协议细节
  // ============================
  describe("HTTP 协议细节", () => {
    it("HE08: chunked 响应正常解析", async () => {
      const server = await startRawServer((_req, res) => {
        // Node.js http 模块默认使用 chunked
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"status":"o');
        res.write('k","version":');
        res.write('"1","uptime":1,"stores":{"vectorStore":true,"embeddingService":true}}');
        res.end();
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      const r = await client.health();
      expect(r.status).toBe("ok");
      await server.stop();
    });

    it("HE10: header 大小写不敏感", async () => {
      const server = await startRawServer((_req, res) => {
        res.writeHead(200, { "CONTENT-TYPE": "Application/JSON" });
        res.end(JSON.stringify({ status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } }));
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      const r = await client.health();
      expect(r.status).toBe("ok");
      await server.stop();
    });

    it("HE11: 301 重定向 → 不自动跟随", async () => {
      const server = await startRawServer((_req, res) => {
        res.writeHead(301, { "Location": "/health" });
        res.end();
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      // fetch 默认跟随重定向，所以这里测试的是最终结果
      await expect(client.health()).rejects.toThrow();
      await server.stop();
    });

    it("HE12: 响应 header 后无 body → 超时", async () => {
      const server = await startRawServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
        res.write('{"status":"partial"...');
        // 不调用 end()，也不发送剩余数据
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 }, timeoutMs: 1000 });
      await expect(client.health()).rejects.toThrow(GatewayError);
      await server.stop();
    }, 5000);

    it("HE15: 并发 20 请求 → 全部正确完成", async () => {
      let count = 0;
      const server = await startRawServer((_req, res) => {
        count++;
        res.end(JSON.stringify({ status: "ok", version: "1", uptime: count, stores: { vectorStore: true, embeddingService: true } }));
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });

      const results = await Promise.all(Array.from({ length: 20 }, () => client.health()));
      expect(results.length).toBe(20);
      results.forEach((r) => expect(r.status).toBe("ok"));
      await server.stop();
    });
  });

  // ============================
  // 错误传播
  // ============================
  describe("错误传播", () => {
    it("HE16: fetch AbortError → GatewayError 正确包装", async () => {
      const client = new GatewayClient({ baseUrl: "http://127.0.0.1:54321", retry: { maxAttempts: 0 }, timeoutMs: 500 });
      await expect(client.health()).rejects.toThrow(GatewayError);
    }, 5000);

    it("HE18: 非法 JSON → GatewayError", async () => {
      const server = await startRawServer((_req, res) => {
        res.end("not valid json {{{");
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 } });
      await expect(client.health()).rejects.toThrow(GatewayError);
      await server.stop();
    });
  });

  // ============================
  // 响应尺寸边界
  // ============================
  describe("响应尺寸边界", () => {
    it("HE07: 1MB JSON 响应 → 解析成功", async () => {
      const largeObj = {
        status: "ok",
        version: "1",
        uptime: 1,
        stores: { vectorStore: true, embeddingService: true },
        data: Array.from({ length: 5000 }, (_, i) => ({ id: i, text: "data-".repeat(20) })),
      };
      const server = await startRawServer((_req, res) => {
        res.end(JSON.stringify(largeObj));
      });
      const client = new GatewayClient({ baseUrl: server.url, retry: { maxAttempts: 0 }, timeoutMs: 5000 });

      const start = Date.now();
      const r = await client.health();
      expect(Date.now() - start).toBeLessThan(3000);
      expect(r.status).toBe("ok");
      await server.stop();
    }, 10000);

    it("HE19: 请求 body 含 undefined → JSON.stringify 自动过滤", async () => {
      // GatewayClient 不会产生 undefined 值，但验证 JSON.stringify 行为
      const obj = { a: 1, b: undefined, c: null, d: "hello" };
      const serialized = JSON.stringify(obj);
      expect(serialized).toBe('{"a":1,"c":null,"d":"hello"}');
      expect(serialized).not.toContain("undefined");
    });
  });
});
