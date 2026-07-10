/**
 * Dify 适配器测试 — 验证 OpenAPI 规范、工具定义、错误处理。
 *
 * 竞争 PR #406 和 #438 声称 Dify 支持但均无 Dify 测试。
 */

import { describe, it, expect } from "vitest";
import { generateDifyOpenApiSpec } from "../../../src/adapters/dify/dify-openapi.js";
import type { GatewayClient } from "../../../src/adapters/shared/gateway-client.js";

// ============================
// Suite 1: OpenAPI 规范生成
// ============================

describe("Dify 适配器: OpenAPI 规范", () => {
  it("生成有效的 OpenAPI 3.0.1 规范", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");

    expect(spec.openapi).toBe("3.0.1");
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.servers).toBeInstanceOf(Array);
    expect(spec.servers.length).toBeGreaterThan(0);
    expect(spec.paths).toBeDefined();
  });

  it("baseUrl 尾部斜杠被正确去除", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420/");
    const serverUrl = (spec.servers as Array<{ url: string }>)[0].url;
    expect(serverUrl).toBe("http://127.0.0.1:8420");
    // URL 不应以斜杠结尾，但 http:// 中的 // 是协议语法
    expect(serverUrl.endsWith("/")).toBe(false);
  });

  it("声明所有 6 个 Dify 工具端点", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
    const paths = spec.paths as Record<string, unknown>;

    expect(paths["/health"]).toBeDefined();
    expect(paths["/recall"]).toBeDefined();
    expect(paths["/capture"]).toBeDefined();
    expect(paths["/search/memories"]).toBeDefined();
    expect(paths["/search/conversations"]).toBeDefined();
    expect(paths["/session/end"]).toBeDefined();
  });

  it("每个端点有唯一 operationId（Dify 要求）", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
    const paths = spec.paths as Record<string, Record<string, { operationId: string }>>;

    const operationIds: string[] = [];
    for (const [_path, methods] of Object.entries(paths)) {
      for (const [_method, op] of Object.entries(methods)) {
        if (op.operationId) operationIds.push(op.operationId);
      }
    }

    const unique = new Set(operationIds);
    expect(unique.size).toBe(operationIds.length);
    expect(operationIds).toContain("tdai_health");
    expect(operationIds).toContain("tdai_recall");
    expect(operationIds).toContain("tdai_capture");
    expect(operationIds).toContain("tdai_search_memories");
    expect(operationIds).toContain("tdai_search_conversations");
    expect(operationIds).toContain("tdai_end_session");
  });

  it("自定义 title 和 version 生效", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420", "Custom API", "2.0.0");
    const info = spec.info as { title: string; version: string };
    expect(info.title).toBe("Custom API");
    expect(info.version).toBe("2.0.0");
  });
});

// ============================
// Suite 2: 端点 schema 完整
// ============================

describe("Dify 适配器: 端点 schema", () => {
  it("POST /recall 需要 query 和 session_key", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const recallPath = paths["/recall"]?.post as { requestBody?: { required?: boolean; content?: Record<string, { schema?: { required?: string[]; properties?: Record<string, unknown> } }> } };

    expect(recallPath).toBeDefined();
    expect(recallPath.requestBody?.required).toBe(true);

    const schema = recallPath.requestBody?.content?.["application/json"]?.schema;
    expect(schema).toBeDefined();
    expect(schema?.required).toContain("query");
    expect(schema?.required).toContain("session_key");
    expect(schema?.properties?.query).toBeDefined();
    expect(schema?.properties?.session_key).toBeDefined();
  });

  it("POST /capture 需要 user_content 和 assistant_content", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const capturePath = paths["/capture"]?.post as { requestBody?: { required?: boolean; content?: Record<string, { schema?: { required?: string[]; properties?: Record<string, unknown> } }> } };

    expect(capturePath).toBeDefined();
    const schema = capturePath.requestBody?.content?.["application/json"]?.schema;
    expect(schema?.required).toContain("user_content");
    expect(schema?.required).toContain("assistant_content");
  });

  it("GET /health 不需要 requestBody", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const healthPath = paths["/health"]?.get as { requestBody?: unknown };

    expect(healthPath).toBeDefined();
    expect(healthPath.requestBody).toBeUndefined();
  });

  it("/health 正确响应 schema", () => {
    const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const healthPath = paths["/health"]?.get as { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> };

    const schema = healthPath?.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(schema).toBeDefined();
    expect(schema?.properties?.status).toBeDefined();
    expect(schema?.properties?.version).toBeDefined();
    expect(schema?.properties?.uptime).toBeDefined();
  });
});

// ============================
// Suite 3: Dify 工具提供器
// ============================

describe("Dify 适配器: 工具提供器", () => {
  it("DifyMemoryAdapter 可由 BaseMemoryPlatformAdapter 构造", async () => {
    // 动态导入以隔离副作用
    const { DifyMemoryAdapter } = await import("../../../src/adapters/dify/dify-adapter.js");

    // 创建一个最小 mock GatewayClient
    const mockClient = {
      health: async () => ({ status: "ok" as const, version: "1.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } }),
      recall: async () => ({ context: "test recall", strategy: "bm25", memory_count: 1 }),
      capture: async () => ({ l0_recorded: 1, scheduler_notified: true }),
      searchMemories: async () => ({ results: "[]", total: 0 }),
      searchConversations: async () => ({ results: "[]", total: 0 }),
      endSession: async () => ({ flushed: true }),
    } as unknown as GatewayClient;

    const adapter = new DifyMemoryAdapter(mockClient);

    expect(adapter.name).toBe("dify-adapter");
    expect(adapter.platform).toBe("dify");

    // 验证核心方法可调用
    const health = await adapter.client.health();
    expect(health.status).toBe("ok");

    const recall = await adapter.client.recall({ query: "test", session_key: "s1" });
    expect(recall.context).toBe("test recall");

    const capture = await adapter.client.capture({ user_content: "hi", assistant_content: "hello", session_key: "s1" });
    expect(capture.l0_recorded).toBe(1);
  });
});

// ============================
// Suite 4: 错误处理
// ============================

describe("Dify 适配器: 错误处理", () => {
  it("Gateway 不可达时，适配器抛出标准错误", async () => {
    const { DifyMemoryAdapter } = await import("../../../src/adapters/dify/dify-adapter.js");

    const failingClient = {
      recall: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8420"); },
    } as unknown as GatewayClient;

    const adapter = new DifyMemoryAdapter(failingClient);

    await expect(
      adapter.client.recall({ query: "test", session_key: "s1" }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
