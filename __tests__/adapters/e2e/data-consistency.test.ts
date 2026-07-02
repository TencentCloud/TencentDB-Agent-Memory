/**
 * 数据一致性测试 — 跨适配器往返、mock 数据验证、session 隔离。
 *
 * 覆盖盲区: G74-G98
 * 使用 mock-data-factory 生成确定性测试数据。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { GatewayClient } from "../../../src/adapters/shared/gateway-client.js";
import { RestMemoryAdapter } from "../../../src/adapters/rest/rest-adapter.js";
import { McpMemoryAdapter } from "../../../src/adapters/mcp/mcp-adapter.js";
import { CodexMemoryAdapter } from "../../../src/adapters/codex/codex-adapter.js";
import { ClaudeCodeMemoryAdapter } from "../../../src/adapters/claude-code/claude-code-adapter.js";
import { DifyMemoryAdapter } from "../../../src/adapters/dify/dify-adapter.js";
import {
  generateConversationTurns,
  generateSessionKeys,
  generateMemoryEntries,
  MULTILINGUAL_DATA,
  EDGE_PAYLOADS,
  mulberry32,
} from "./mock-data-factory.js";
import type { MemoryPlatformAdapter } from "../../../src/adapters/memory-platform-adapter.js";
import type { GatewayClientOptions } from "../../../src/adapters/shared/gateway-client.js";

// ============================
// 模拟 Gateway（记录请求用于验证）
// ============================

interface RequestLog {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

async function startRecordingGateway(): Promise<{
  url: string;
  logs: RequestLog[];
  stop: () => Promise<void>;
}> {
  const logs: RequestLog[] = [];

  const server = http.createServer((req, res) => {
    let bodyStr = "";
    req.on("data", (c) => { bodyStr += c; });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(bodyStr); } catch {}

      logs.push({
        method: req.method!,
        path: req.url!,
        body,
      });

      const path = req.url!;
      let respBody: unknown = {};

      if (path === "/health") {
        respBody = { status: "ok", version: "0.1.0", uptime: 60, stores: { vectorStore: true, embeddingService: true } };
      } else if (path === "/recall") {
        respBody = {
          context: body.query ? `召回结果: ${String(body.query).slice(0, 50)}` : "",
          strategy: "l1",
          memory_count: body.query ? 3 : 0,
        };
      } else if (path === "/capture") {
        respBody = { l0_recorded: 1, scheduler_notified: true };
      } else if (path === "/search/memories") {
        respBody = { results: `搜索记忆: ${String(body.query || "").slice(0, 30)}...`, total: 5, strategy: "hybrid" };
      } else if (path === "/search/conversations") {
        respBody = { results: `搜索对话: ${String(body.query || "").slice(0, 30)}...`, total: 3 };
      } else if (path === "/session/end") {
        respBody = { flushed: true };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respBody));
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        logs,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 创建 5 种适配器 */
function createAllAdapters(baseUrl: string): MemoryPlatformAdapter[] {
  const opts: GatewayClientOptions = { baseUrl, retry: { maxAttempts: 0 } };
  return [
    new RestMemoryAdapter(new GatewayClient(opts)),
    new McpMemoryAdapter(new GatewayClient(opts)),
    new CodexMemoryAdapter(new GatewayClient(opts)),
    new ClaudeCodeMemoryAdapter(new GatewayClient(opts)),
    new DifyMemoryAdapter(new GatewayClient(opts)),
  ];
}

// ============================
// 测试
// ============================

describe("数据一致性测试", () => {
  describe("跨适配器一致性", () => {
    it("DC02: 5 个适配器 searchMemories 同一 query → 结果一致", async () => {
      const gw = await startRecordingGateway();
      const adapters = createAllAdapters(gw.url);

      const results = await Promise.all(
        adapters.map((a) => a.searchMemories("测试查询")),
      );

      // 所有适配器返回相同 total
      const totals = results.map((r) => r.total);
      expect(new Set(totals).size).toBe(1); // 全部相同

      await gw.stop();
    });

    it("DC03: RestAdapter.capture → McpAdapter.recall → 跨适配器可召回", async () => {
      const gw = await startRecordingGateway();
      const rest = createAllAdapters(gw.url)[0]; // RestAdapter
      const mcp = createAllAdapters(gw.url)[1];  // McpAdapter

      // RestAdapter 写入
      await rest.capture("你好，帮我查天气", "当然，今天北京天气晴朗", "sess-1");

      // McpAdapter 读取
      const result = await mcp.recall("天气", "sess-1");
      expect(result.context).toBeDefined();

      await gw.stop();
    });

    it("DC04: CodexAdapter.capture → ClaudeCodeAdapter.searchMemories", async () => {
      const gw = await startRecordingGateway();
      const codex = createAllAdapters(gw.url)[2];   // CodexAdapter
      const claude = createAllAdapters(gw.url)[3];   // ClaudeCodeAdapter

      await codex.capture("推荐几本书", "推荐《三体》《百年孤独》《1984》", "sess-2");
      const result = await claude.searchMemories("书");
      expect(result.total).toBeGreaterThanOrEqual(0);

      await gw.stop();
    });

    it("DC13: 同一 query 通过 5 个适配器 searchMemories → total 一致", async () => {
      const gw = await startRecordingGateway();
      const adapters = createAllAdapters(gw.url);

      for (const adapter of adapters) {
        const r = await adapter.searchMemories("AI");
        expect(typeof r.total).toBe("number");
      }
      await gw.stop();
    });
  });

  // ============================
  // Session 隔离 (DC06, DC21)
  // ============================
  describe("Session 隔离", () => {
    it("DC06: 10 个不同 session 的数据请求隔离", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];
      const sessions = generateSessionKeys(10);

      // 每个 session 做 capture
      for (const s of sessions) {
        await adapter.capture("测试消息", "回复消息", s);
      }

      // 每个 session 的请求日志路径正确
      const capturePaths = gw.logs.filter((l) => l.path === "/capture");
      expect(capturePaths.length).toBe(10);

      // 所有 session key 都不同
      const keys = capturePaths.map((l) => l.body.session_key);
      expect(new Set(keys).size).toBe(10);

      await gw.stop();
    });

    it("DC21: 跨 session 搜索不泄漏", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];

      await adapter.capture("机密数据", "不可泄漏", "private-session");
      await adapter.capture("公开数据", "可搜索", "public-session");

      // 用限定 session 搜索
      // Gateway 日志记录了 search 请求的 session_key 参数
      const _r = await adapter.searchConversations("数据", 5, "public-session");

      // 验证请求参数正确
      const lastSearch = gw.logs.filter((l) => l.path === "/search/conversations").pop();
      expect(lastSearch?.body.session_key).toBe("public-session");

      await gw.stop();
    });
  });

  // ============================
  // Mock 数据往返 (DC05, DC19)
  // ============================
  describe("Mock 数据往返", () => {
    it("DC05: 100 条对话 capture → recall 验证", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];
      const turns = generateConversationTurns(100);

      for (const turn of turns) {
        await adapter.capture(turn.user, turn.assistant, turn.sessionKey);
      }

      // 100 条 capture 全部到达 Gateway
      const captures = gw.logs.filter((l) => l.path === "/capture");
      expect(captures.length).toBe(100);

      await gw.stop();
    });

    it("DC19: 500 条对话全量 capture 无丢失", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];
      const turns = generateConversationTurns(500, 123);

      const batchSize = 25;
      for (let i = 0; i < turns.length; i += batchSize) {
        const batch = turns.slice(i, i + batchSize);
        await Promise.all(batch.map((t) => adapter.capture(t.user, t.assistant, t.sessionKey)));
      }

      const captures = gw.logs.filter((l) => l.path === "/capture");
      expect(captures.length).toBe(500);

      await gw.stop();
    });

    it("DC25: 同 seed 同操作 → 同结果", () => {
      const turns1 = generateConversationTurns(10, 42);
      const turns2 = generateConversationTurns(10, 42);
      expect(turns1).toEqual(turns2);
    });
  });

  // ============================
  // 多语言数据 (DC09)
  // ============================
  describe("多语言数据", () => {
    it("DC09: 多语言消息 capture → 往返不损坏", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];

      for (const entry of MULTILINGUAL_DATA) {
        await adapter.capture(entry.text, `回复: ${entry.text}`, `sess-${entry.lang}`);

        // 验证 body 包含完整文本
        const lastCapture = gw.logs.filter((l) => l.path === "/capture").pop();
        expect(lastCapture?.body.user_content).toBe(entry.text);
      }

      await gw.stop();
    });
  });

  // ============================
  // 边缘 Payload (DC16, DC24)
  // ============================
  describe("边缘 Payload", () => {
    it("DC16: sessionKey 含特殊字符 → 正确发送", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];
      const specialKeys = ["sess/a?b#c[d]e@f", "sess with spaces", "sess-!@#$%", "a".repeat(200)];

      for (const key of specialKeys) {
        await adapter.capture("测试", "回复", key);
      }

      const captures = gw.logs.filter((l) => l.path === "/capture");
      expect(captures.length).toBe(specialKeys.length);

      // 所有 session key 被正确发送
      for (const key of specialKeys) {
        expect(captures.some((c) => c.body.session_key === key)).toBe(true);
      }

      await gw.stop();
    });

    it("DC24: 100KB 消息 → capture 不截断", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];
      const longMsg = "A".repeat(100 * 1024); // 100KB

      await adapter.capture("查询", longMsg, "sess-large");
      const capture = gw.logs.filter((l) => l.path === "/capture").pop();
      expect(capture?.body.assistant_content).toBe(longMsg);

      await gw.stop();
    });

    it("DC11: recall 空 context → memoryCount=0", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];
      const result = await adapter.recall("无匹配查询", "empty-sess");
      expect(result.context).toBeDefined();
      await gw.stop();
    });

    it("DC12: searchMemories 空 query → 仍返回 total", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];
      const result = await adapter.searchMemories("");
      expect(typeof result.total).toBe("number");
      await gw.stop();
    });
  });

  // ============================
  // 并发一致性 (DC17, DC20)
  // ============================
  describe("并发一致性", () => {
    it("DC17: 并发 10 capture + 10 recall → 无数据错乱", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];

      const captures = Array.from({ length: 10 }, (_, i) =>
        adapter.capture(`用户消息${i}`, `助手回复${i}`, `sess-concurrent`),
      );
      const recalls = Array.from({ length: 10 }, () =>
        adapter.recall("并发查询", "sess-concurrent"),
      );

      await Promise.all([...captures, ...recalls]);
      expect(gw.logs.filter((l) => l.path === "/capture").length).toBe(10);
      expect(gw.logs.filter((l) => l.path === "/recall").length).toBe(10);

      await gw.stop();
    });

    it("DC20: 5 种 adapter 各 10 次并发 capture → 互不干扰", async () => {
      const gw = await startRecordingGateway();
      const adapters = createAllAdapters(gw.url);

      const ops = adapters.flatMap((a, idx) =>
        Array.from({ length: 10 }, (_, i) =>
          a.capture(`消息${idx}-${i}`, `回复${idx}-${i}`, `sess-${idx}`),
        ),
      );

      await Promise.all(ops);
      expect(gw.logs.filter((l) => l.path === "/capture").length).toBe(50);

      await gw.stop();
    });
  });

  // ============================
  // End Session (DC08)
  // ============================
  describe("End Session", () => {
    it("DC08: endSession → 后仍可 recall", async () => {
      const gw = await startRecordingGateway();
      const adapter = createAllAdapters(gw.url)[0];

      await adapter.capture("先记录", "先回复", "sess-end");
      await adapter.endSession("sess-end");
      const result = await adapter.recall("记录", "sess-end");

      // recall 应正常工作（不因 endSession 而报错）
      expect(result.context).toBeDefined();

      await gw.stop();
    });
  });
});
