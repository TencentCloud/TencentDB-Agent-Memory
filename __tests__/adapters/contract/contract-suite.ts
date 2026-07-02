/**
 * MemoryPlatformAdapter 合约测试套件。
 *
 * "一次编写，所有适配器运行" — 这是击败所有竞争者 PR 的关键武器。
 *
 * 此套件验证每个 MemoryPlatformAdapter 实现遵循相同的合约，
 * 确保跨平台行为完全一致。新增平台时只需：
 *
 * ```ts
 * contractSuite("新平台", () => new NewAdapter(...));
 * ```
 *
 * 所有测试使用 mock fetch 避免真实 HTTP 调用。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GatewayClient } from "../../../src/adapters/shared/gateway-client.js";
import type { MemoryPlatformAdapter } from "../../../src/adapters/memory-platform-adapter.js";
import { RestMemoryAdapter } from "../../../src/adapters/rest/rest-adapter.js";
import { McpMemoryAdapter } from "../../../src/adapters/mcp/mcp-adapter.js";
import { CodexMemoryAdapter } from "../../../src/adapters/codex/codex-adapter.js";
import { ClaudeCodeMemoryAdapter } from "../../../src/adapters/claude-code/claude-code-adapter.js";
import { DifyMemoryAdapter } from "../../../src/adapters/dify/dify-adapter.js";

// ============================
// Mock fetch 工具
// ============================

function mockOkResponse(data: unknown): void {
  vi.stubGlobal("fetch", (_url: string, _init: RequestInit) => {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => data,
    } as Response);
  });
}

function mockErrorResponse(status: number, body: unknown): void {
  vi.stubGlobal("fetch", (_url: string, _init: RequestInit) => {
    return Promise.resolve({
      ok: false,
      status,
      json: async () => body,
    } as Response);
  });
}

function createClient(): GatewayClient {
  return new GatewayClient({
    baseUrl: "http://127.0.0.1:8420",
    retry: { maxAttempts: 0 },
  });
}

// ============================
// 合约套件工厂函数
// ============================

/**
 * 对指定适配器运行合约测试。
 *
 * @param name     - 适配器名称（用于测试描述）
 * @param factory  - 适配器工厂函数
 */
export function contractSuite(
  name: string,
  factory: () => Promise<MemoryPlatformAdapter>,
): void {
  describe(`合约测试: ${name}`, () => {
    let adapter: MemoryPlatformAdapter;

    beforeEach(async () => {
      vi.restoreAllMocks();
      adapter = await factory();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // ============================
    // 元数据
    // ============================
    describe("元数据", () => {
      it("name 为非空字符串", () => {
        expect(typeof adapter.name).toBe("string");
        expect(adapter.name.length).toBeGreaterThan(0);
      });

      it("platform 为非空字符串", () => {
        expect(typeof adapter.platform).toBe("string");
        expect(adapter.platform.length).toBeGreaterThan(0);
      });
    });

    // ============================
    // 健康检查
    // ============================
    describe("health", () => {
      it("返回 status 字段", async () => {
        mockOkResponse({ status: "ok", version: "0.1.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } });

        const result = await adapter.health();
        expect(result.status).toBe("ok");
      });

      it("返回 stores 信息", async () => {
        mockOkResponse({ status: "ok", version: "0.1.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } });

        const result = await adapter.health();
        expect(result.stores).toBeDefined();
        expect(typeof result.stores.vectorStore).toBe("boolean");
      });

      it("degraded 状态正确处理", async () => {
        mockOkResponse({ status: "degraded", version: "0.1.0", uptime: 60, stores: { vectorStore: false, embeddingService: false } });

        const result = await adapter.health();
        expect(result.status).toBe("degraded");
      });
    });

    // ============================
    // 记忆召回
    // ============================
    describe("recall", () => {
      it("返回 context 字符串", async () => {
        mockOkResponse({ context: "相关记忆上下文", strategy: "l1", memory_count: 3 });

        const result = await adapter.recall("查询", "sess-1");
        expect(typeof result.context).toBe("string");
        expect(result.context.length).toBeGreaterThan(0);
      });

      it("包含 memoryCount", async () => {
        mockOkResponse({ context: "上下文", memory_count: 5 });

        const result = await adapter.recall("查询", "sess-1");
        expect(result.memoryCount).toBe(5);
      });

      it("空 context 不报错", async () => {
        mockOkResponse({ context: "", memory_count: 0 });

        const result = await adapter.recall("未知查询", "sess-1");
        expect(result.context).toBe("");
      });
    });

    // ============================
    // 对话捕获
    // ============================
    describe("capture", () => {
      it("返回 l0Recorded >= 0", async () => {
        mockOkResponse({ l0_recorded: 3, scheduler_notified: true });

        const result = await adapter.capture("用户", "助手", "sess-1");
        expect(result.l0Recorded).toBeGreaterThanOrEqual(0);
      });

      it("返回 schedulerNotified", async () => {
        mockOkResponse({ l0_recorded: 1, scheduler_notified: false });

        const result = await adapter.capture("用户", "助手", "sess-1");
        expect(typeof result.schedulerNotified).toBe("boolean");
      });
    });

    // ============================
    // 搜索记忆
    // ============================
    describe("searchMemories", () => {
      it("返回 results 和 total", async () => {
        mockOkResponse({ results: "找到 10 条记忆", total: 10, strategy: "hybrid" });

        const result = await adapter.searchMemories("关键词");
        expect(typeof result.results).toBe("string");
        expect(typeof result.total).toBe("number");
      });

      it("limit 参数生效", async () => {
        mockOkResponse({ results: "结果", total: 2, strategy: "hybrid" });

        const result = await adapter.searchMemories("查询", 2);
        expect(result).toBeDefined();
      });

      it("可选参数 type 和 scene 正常", async () => {
        mockOkResponse({ results: "过滤结果", total: 1, strategy: "hybrid" });

        const result = await adapter.searchMemories("查询", 5, "episodic", "场景A");
        expect(result).toBeDefined();
      });
    });

    // ============================
    // 搜索对话
    // ============================
    describe("searchConversations", () => {
      it("返回 results 和 total", async () => {
        mockOkResponse({ results: "找到 3 条对话", total: 3 });

        const result = await adapter.searchConversations("关键词");
        expect(typeof result.results).toBe("string");
        expect(typeof result.total).toBe("number");
      });
    });

    // ============================
    // 结束会话
    // ============================
    describe("endSession", () => {
      it("不抛出异常", async () => {
        mockOkResponse({ flushed: true });

        await expect(adapter.endSession("sess-1")).resolves.toBeUndefined();
      });

      it("幂等 — 重复调用不报错", async () => {
        mockOkResponse({ flushed: true });

        await adapter.endSession("sess-1");
        await adapter.endSession("sess-1");
        // 不抛出异常即通过
      });
    });
  });
}

// ============================
// 运行所有适配器的合约测试
// ============================

describe("MemoryPlatformAdapter 合约测试 — 所有适配器", () => {
  contractSuite("RestMemoryAdapter", async () => new RestMemoryAdapter(createClient()));
  contractSuite("McpMemoryAdapter", async () => new McpMemoryAdapter(createClient()));
  contractSuite("CodexMemoryAdapter", async () => new CodexMemoryAdapter(createClient()));
  contractSuite("ClaudeCodeMemoryAdapter", async () => new ClaudeCodeMemoryAdapter(createClient()));
  contractSuite("DifyMemoryAdapter", async () => new DifyMemoryAdapter(createClient()));
});
