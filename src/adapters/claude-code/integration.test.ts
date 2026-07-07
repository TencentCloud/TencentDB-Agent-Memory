/**
 * integration.test.ts — Claude Code 适配器集成测试。
 *
 * 起真实 Gateway（SQLite + BM25，禁用 extraction/embedding，无 LLM 调用）于随机端口，
 * 用真实 TdaiHttpClient 走 HTTP 闭环：health → recall → capture → search → session/end。
 *
 * 设计决策：
 *   - 禁用 extraction（L1/L2/L3）以避免异步 LLM 调用（测试环境无 API key）。
 *     capture 仍同步记录 L0（JSONL + SQLite 行）。
 *   - recall / search-memories 在无 L1 记忆时可能返回空，但响应结构可验证。
 *   - search-conversations 搜索 L0 原始对话，capture 后一定能找到 → 验证闭环。
 *   - 端口用 net.createServer 预占方案获取空闲端口（TdaiGateway 不暴露实际绑定端口）。
 *   - 数据目录用 os.tmpdir() 隔离，afterAll 清理。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { TdaiGateway } from "../../gateway/server";
import { loadGatewayConfig } from "../../gateway/config";
import { TdaiHttpClient } from "../../sdk/client";

// ============================
// helpers
// ============================

/** 预占一个空闲 TCP 端口（TdaiGateway 不暴露 server.address()，需自行获取端口）。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Failed to obtain a free port"));
      }
    });
  });
}

/** 创建临时目录（afterAll 清理）。 */
function mkdtempSync(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdai-int-"));
}

/** 递归删除目录（容错）。 */
function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 容错：Windows 下偶尔因文件锁删除失败，不阻塞测试结果
  }
}

// ============================
// 测试套件
// ============================

describe("Claude Code adapter — integration (real Gateway + TdaiHttpClient)", () => {
  let gateway: TdaiGateway;
  let client: TdaiHttpClient;
  let tmpDir: string;
  let baseUrl: string;

  const sessionKey = "integration-test-session";
  const userId = "integration-test-user";
  const userContent = "我喜欢用 TypeScript 写代码，特别是类型安全和接口设计。";
  const assistantContent = "TypeScript 的类型系统确实强大，接口设计能让代码更健壮。";

  beforeAll(async () => {
    const port = await findFreePort();
    tmpDir = mkdtempSync();
    baseUrl = `http://127.0.0.1:${port}`;

    // 预加载默认配置，禁用 extraction 以避免异步 LLM 调用
    const baseConfig = loadGatewayConfig({
      server: { port, host: "127.0.0.1", corsOrigins: [] },
      data: { baseDir: tmpDir },
    });
    baseConfig.memory.extraction.enabled = false;

    gateway = new TdaiGateway(baseConfig);
    await gateway.start();

    client = new TdaiHttpClient({ baseUrl });
  }, 60_000);

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
    if (tmpDir) {
      rmrf(tmpDir);
    }
  }, 60_000);

  // ── 路径 1：health ───────────────────────────────────────────────────────

  it("health → status 为 ok 或 degraded", async () => {
    const health = await client.health();
    expect(health).toBeDefined();
    expect(["ok", "degraded"]).toContain(health.status);
    expect(typeof health.version).toBe("string");
    expect(typeof health.uptime).toBe("number");
  });

  // ── 路径 2：recall（capture 前）──────────────────────────────────────────

  it("recall（capture 前）→ context 为空串或极短，结构合法", async () => {
    const resp = await client.recall("TypeScript", sessionKey, userId);
    expect(resp).toBeDefined();
    expect(typeof resp.context).toBe("string");
    // 无记忆时 context 应为空或极短
    expect(resp.context.length).toBeLessThan(200);
  });

  // ── 路径 3：capture → 记录 L0 ────────────────────────────────────────────

  it("capture → L0 记录成功（l0_recorded > 0）", async () => {
    const resp = await client.capture(userContent, assistantContent, sessionKey, {
      userId,
    });
    expect(resp).toBeDefined();
    expect(resp.l0_recorded).toBeGreaterThan(0);
    expect(typeof resp.scheduler_notified).toBe("boolean");
  });

  // ── 路径 4：recall（capture 后）→ 结构合法 ───────────────────────────────

  it("recall（capture 后）→ 响应结构合法（无 L1 时 context 可能为空）", async () => {
    // 给 L0 写入留一点时间（SQLite 同步写，但保险起见）
    await new Promise((r) => setTimeout(r, 300));
    const resp = await client.recall("TypeScript 类型安全", sessionKey, userId);
    expect(resp).toBeDefined();
    expect(typeof resp.context).toBe("string");
    // 无 L1 提取时 context 可能为空，但字段必须存在
  });

  // ── 路径 5：search/memories → 结构合法 ───────────────────────────────────

  it("search/memories → 响应结构合法（results 为字符串，total 为数字）", async () => {
    const resp = await client.searchMemories({
      query: "TypeScript",
      limit: 5,
    });
    expect(resp).toBeDefined();
    expect(typeof resp.results).toBe("string");
    expect(typeof resp.total).toBe("number");
    expect(resp.total).toBeGreaterThanOrEqual(0);
  });

  // ── 路径 6：search/conversations → 验证 capture→search 闭环 ─────────────

  it("search/conversations → 找到 capture 写入的 L0 对话（闭环验证）", async () => {
    const resp = await client.searchConversations({
      query: "TypeScript",
      limit: 5,
      sessionKey,
    });
    expect(resp).toBeDefined();
    expect(typeof resp.results).toBe("string");
    expect(typeof resp.total).toBe("number");
    // L0 已在 capture 中写入，search 应能找到
    expect(resp.total).toBeGreaterThan(0);
    // results 文本中应包含 capture 的关键词
    expect(resp.results.toLowerCase()).toContain("typescript");
  });

  // ── 路径 7：session/end → 调用成功 resolve（TdaiClient.endSession 契约为 void）──

  it("session/end → 调用成功 resolve（不抛异常）", async () => {
    // TdaiClient.endSession 签名为 Promise<void>（fire-and-forget），
    // Gateway handleSessionEnd 实际返回 { flushed: true }，但客户端丢弃响应体。
    // 因此这里只验证调用成功 resolve，不检查响应字段。
    await expect(client.endSession(sessionKey, userId)).resolves.toBeUndefined();
  });

  // ── 路径 8：recall 用 ClaudeCodeEventBinding 走一遍（验证 binding 与真实 Gateway 对接）──

  it("ClaudeCodeEventBinding + 真实 Gateway → onTurnEnd capture + onUserPrompt recall 闭环", async () => {
    const { ClaudeCodeEventBinding } = await import("./claude-code-binding.js");
    const binding = new ClaudeCodeEventBinding(client, { userId, gatewayHost: "127.0.0.1", gatewayPort: 0, gatewayBaseUrl: baseUrl });

    // onTurnEnd → capture
    const ack = await binding.onTurnEnd(
      {
        userText: "Python 的装饰器怎么用？",
        assistantText: "装饰器是一种修改函数行为的语法糖。",
        sessionKey: "binding-integration-session",
      },
      { sessionKey: "binding-integration-session", sessionId: "bind-1", userId },
    );
    expect(ack).not.toBeNull();
    expect(ack!.l0Recorded).toBeGreaterThan(0);

    // onUserPrompt → recall（结构合法即可）
    const injection = await binding.onUserPrompt("Python 装饰器", {
      sessionKey: "binding-integration-session",
      sessionId: "bind-1",
      userId,
    });
    // recall 可能返回 null（无 L1）或 RecallInjection；两者都可接受
    if (injection !== null) {
      expect(injection.additionalContext).toContain("<relevant-memories>");
    }
  });
});
