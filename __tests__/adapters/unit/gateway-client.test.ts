/**
 * GatewayClient 单元测试。
 *
 * 验证 HTTP 请求构建、响应解析、认证头、错误处理。
 * 使用 vi.stubGlobal 替代 spyOn 以避免 fork pool 兼容性问题。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GatewayClient, GatewayError } from "../../../src/adapters/shared/gateway-client.js";

describe("GatewayClient", () => {
  let client: GatewayClient;
  let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

  function mockResponse(status: number, body: unknown): void {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      fetchCalls.push({ url: _url, init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response);
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchCalls = [];
    vi.stubGlobal("fetch", undefined);
    client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8420",
      retry: { maxAttempts: 0 },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ============================
  // 请求构建
  // ============================
  describe("请求构建", () => {
    it("health 发送 GET 请求到 /health", async () => {
      mockResponse(200, { status: "ok", version: "0.1.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } });

      const result = await client.health();

      expect(fetchCalls[0].url).toBe("http://127.0.0.1:8420/health");
      expect(fetchCalls[0].init.method).toBe("GET");
      expect(result.status).toBe("ok");
    });

    it("recall 正确序列化请求体", async () => {
      mockResponse(200, { context: "记忆片段", memory_count: 3 });

      await client.recall("查询文本", "sess-1", "user-1");

      expect(fetchCalls[0].url).toBe("http://127.0.0.1:8420/recall");
      expect(fetchCalls[0].init.method).toBe("POST");

      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.query).toBe("查询文本");
      expect(body.session_key).toBe("sess-1");
      expect(body.user_id).toBe("user-1");
    });

    it("capture 正确序列化请求体", async () => {
      mockResponse(200, { l0_recorded: 5, scheduler_notified: true });

      await client.capture("用户消息", "助手回复", "sess-1", "sid-1");

      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.user_content).toBe("用户消息");
      expect(body.assistant_content).toBe("助手回复");
      expect(body.session_id).toBe("sid-1");
    });

    it("searchMemories 可选字段不出现", async () => {
      mockResponse(200, { results: "结果", total: 10, strategy: "hybrid" });

      await client.searchMemories("关键词");

      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.query).toBe("关键词");
      expect(body.limit).toBeUndefined();
    });

    it("searchMemories 包含全部可选字段", async () => {
      mockResponse(200, { results: "结果", total: 5, strategy: "hybrid" });

      await client.searchMemories("查询", 10, "episodic", "场景A");

      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.limit).toBe(10);
      expect(body.type).toBe("episodic");
      expect(body.scene).toBe("场景A");
    });
  });

  // ============================
  // Base URL 规范化
  // ============================
  describe("Base URL 规范化", () => {
    it("去除尾部斜杠", async () => {
      const c = new GatewayClient({ baseUrl: "http://example.com:8420/", retry: { maxAttempts: 0 } });
      mockResponse(200, { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } });

      await c.health();

      expect(fetchCalls[0].url).toBe("http://example.com:8420/health");
    });
  });

  // ============================
  // 认证
  // ============================
  describe("认证", () => {
    it("有 apiKey 时包含 Bearer Token", async () => {
      const c = new GatewayClient({ baseUrl: "http://x:1", apiKey: "s3cret", retry: { maxAttempts: 0 } });
      mockResponse(200, { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } });

      await c.health();

      expect(fetchCalls[0].init.headers).toMatchObject({ "Authorization": "Bearer s3cret" });
    });

    it("无 apiKey 时不包含 Authorization 头", async () => {
      mockResponse(200, { status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } });

      await client.health();

      const headers = fetchCalls[0].init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  // ============================
  // 错误处理
  // ============================
  describe("错误处理", () => {
    it("HTTP 500 抛出 GatewayError（含 statusCode 和 errorCode）", async () => {
      mockResponse(500, { error: "内部错误", code: "INTERNAL" });

      await expect(client.health()).rejects.toMatchObject({
        name: "GatewayError",
        statusCode: 500,
        errorCode: "INTERNAL",
      });
    });

    it("HTTP 401 抛出 GatewayError", async () => {
      mockResponse(401, { error: "未授权" });

      await expect(client.health()).rejects.toMatchObject({
        name: "GatewayError",
        statusCode: 401,
      });
    });
  });

  // ============================
  // 响应解析
  // ============================
  describe("响应解析", () => {
    it("recall 正确解析", async () => {
      mockResponse(200, { context: "上下文", strategy: "l1", memory_count: 7 });

      const result = await client.recall("q", "s");

      expect(result.context).toBe("上下文");
      expect(result.strategy).toBe("l1");
      expect(result.memory_count).toBe(7);
    });

    it("capture 正确解析", async () => {
      mockResponse(200, { l0_recorded: 12, scheduler_notified: false });

      const result = await client.capture("u", "a", "s");

      expect(result.l0_recorded).toBe(12);
      expect(result.scheduler_notified).toBe(false);
    });
  });

  // ============================
  // 熔断器集成
  // ============================
  describe("熔断器集成", () => {
    it("初始状态为 CLOSED", () => {
      expect(client.circuitState).toBe("CLOSED");
    });

    it("resetCircuitBreaker 重置成功", () => {
      client.resetCircuitBreaker();
      expect(client.circuitState).toBe("CLOSED");
    });
  });
});

// ============================
// GatewayError 独立测试
// ============================

describe("GatewayError", () => {
  it("fromResponse 从 JSON 错误体构造", async () => {
    const response = {
      ok: false,
      status: 503,
      json: async () => ({ error: "服务不可用", code: "UNAVAILABLE" }),
    } as Response;

    const err = await GatewayError.fromResponse(response);

    expect(err.message).toBe("服务不可用");
    expect(err.statusCode).toBe(503);
    expect(err.errorCode).toBe("UNAVAILABLE");
  });

  it("fromResponse JSON 解析失败时使用默认消息", async () => {
    const response = {
      ok: false,
      status: 500,
      json: async () => { throw new Error("bad json"); },
    } as unknown as Response;

    const err = await GatewayError.fromResponse(response);

    expect(err.message).toBe("Gateway 返回 HTTP 500");
    expect(err.statusCode).toBe(500);
  });

  it("name 属性为 GatewayError", () => {
    const err = new GatewayError("测试错误", 400);
    expect(err.name).toBe("GatewayError");
  });
});
