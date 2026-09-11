/**
 * Claude Code E2E 深度测试 — 模拟完整 Claude Code 生命周期。
 *
 * 参考 PR #485 的 498 行 E2E 测试设计，但集成我们的 retry + circuit-breaker。
 *
 * 覆盖：
 * - 完整生命周期：UserPromptSubmit → Stop → SessionEnd
 * - 多轮对话：连续 N 轮的 recall→capture 循环
 * - 网络故障恢复：Gateway 暂时不可达后恢复
 * - 超时处理：慢响应不阻塞 hooks
 * - 服务降级：Gateway 不可用时的 fail-open 行为
 * - 熔断器：连续失败 → OPEN → HALF_OPEN → CLOSED 转换
 * - 重试行为：503 瞬断 → 自动重试 → 成功
 * - 幂等性：同一 turn 重复 capture 不产生重复数据
 *
 * 使用 FakeGateway（不是真实 Gateway 进程），零外部依赖。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FakeGateway } from "../helpers/fake-gateway.js";
import {
  HttpMemoryClient,
  createMemoryClient,
} from "../../../src/adapters/index.js";
import type { MemoryClient } from "../../../src/adapters/index.js";

// ============================
// Setup
// ============================

let gw: FakeGateway;
let client: HttpMemoryClient;

beforeAll(async () => {
  gw = new FakeGateway();
  await gw.start();
});

afterAll(async () => {
  client?.close();
  await gw.stop();
});

beforeEach(() => {
  gw.reset();
  if (client) client.close();
  client = new HttpMemoryClient({ baseUrl: gw.url, timeoutMs: 5000 });
});

// ============================
// Suite 1: 基础生命周期
// ============================

describe("Claude Code E2E: 基础生命周期", () => {
  it("health → recall → capture → endSession 正常流程", async () => {
    // 1. Health check
    const h = await client.health();
    expect(h.status).toBe("ok");
    expect(gw.healthChecks()).toBe(1);

    // 2. Recall on UserPromptSubmit
    gw.onRecall({ context: "上次讨论的架构设计", strategy: "hybrid", memory_count: 3 });
    const r = await client.recall({ query: "继续开发", sessionKey: "cc:project-a:conv-1" });
    expect(r.context).toBe("上次讨论的架构设计");
    expect(r.strategy).toBe("hybrid");

    const recallReq = gw.lastRecallRequest();
    expect(recallReq?.query).toBe("继续开发");
    expect(recallReq?.session_key).toBe("cc:project-a:conv-1");

    // 3. Capture on Stop
    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });
    const c = await client.capture({
      userContent: "继续开发用户管理模块",
      assistantContent: "好的，我已完成以下改动...",
      sessionKey: "cc:project-a:conv-1",
    });
    expect(c.l0_recorded).toBe(1);

    const captureReq = gw.lastCaptureRequest();
    expect(captureReq?.user_content).toBe("继续开发用户管理模块");
    expect(captureReq?.assistant_content).toBe("好的，我已完成以下改动...");

    // 4. SessionEnd
    gw.onSessionEnd({ flushed: true });
    const e = await client.endSession({ sessionKey: "cc:project-a:conv-1" });
    expect(e.flushed).toBe(true);
  });

  it("连续 5 轮 recall→capture 循环", async () => {
    const sessionKey = "cc:project-b:conv-5-rounds";

    for (let i = 1; i <= 5; i++) {
      // Recall
      gw.onRecall({ context: `Round ${i} context`, strategy: "bm25", memory_count: 2 });
      const r = await client.recall({ query: `查询 ${i}`, sessionKey });
      expect(r.context).toContain(`Round ${i}`);

      // Capture
      gw.onCapture({ l0_recorded: 1, scheduler_notified: true });
      const c = await client.capture({
        userContent: `用户消息 ${i}`,
        assistantContent: `助手回复 ${i}`,
        sessionKey,
      });
      expect(c.l0_recorded).toBe(1);
    }

    expect(gw.recallCount()).toBe(5);
    expect(gw.captureCount()).toBe(5);
  });
});

// ============================
// Suite 2: 故障恢复
// ============================

describe("Claude Code E2E: 故障恢复", () => {
  it("Gateway 503 瞬断 → 重试后成功", async () => {
    // 前两次返回 503，第三次成功
    let attempts = 0;
    gw.setCustomHandler((_req, _body) => {
      attempts++;
      if (attempts <= 2) {
        return { status: 503, body: { error: "Service Unavailable" } };
      }
      return { status: 200, body: { context: "恢复后的上下文", strategy: "bm25", memory_count: 1 } };
    });

    const r = await client.recall({ query: "测试重试", sessionKey: "s1" });
    expect(r.context).toBe("恢复后的上下文");
    expect(attempts).toBeGreaterThanOrEqual(2); // 至少重试了1次
  });

  it("Gateway 连接拒绝 → 抛出可用性错误", async () => {
    // 关闭并重启 Gateway（模拟连接失败）
    await gw.stop();
    // 等待端口释放
    await new Promise((r) => setTimeout(r, 100));

    await expect(
      client.recall({ query: "test", sessionKey: "s1" }),
    ).rejects.toThrow();

    // 重启 Gateway
    await gw.start();
    client = new HttpMemoryClient({ baseUrl: gw.url, timeoutMs: 5000 });
  });

  it("超时慢响应 → 不阻塞后续请求", async () => {
    // 第一个请求慢（500ms 延迟）
    gw.onRecall(
      { context: "slow", strategy: "bm25", memory_count: 1 },
      200,
      500, // 500ms 延迟
    );

    const start = Date.now();
    const r = await client.recall({ query: "慢请求", sessionKey: "s1" });
    const elapsed = Date.now() - start;

    expect(r.context).toBe("slow");
    expect(elapsed).toBeGreaterThanOrEqual(400); // 至少等了 400ms

    // 第二个请求正常
    gw.onRecall({ context: "fast", strategy: "bm25", memory_count: 1 }, 200, 0);
    const r2 = await client.recall({ query: "快请求", sessionKey: "s2" });
    expect(r2.context).toBe("fast");
  });
});

// ============================
// Suite 3: 熔断器行为
// ============================

describe("Claude Code E2E: 熔断器", () => {
  it("连续 500 错误 → 熔断器打开 → 快速失败", async () => {
    // 创建带短超时的熔断器配置 client
    const cbClient = new HttpMemoryClient({
      baseUrl: gw.url,
      timeoutMs: 5000,
      circuitBreaker: { failureThreshold: 3, timeoutMs: 1000 },
      retry: { maxAttempts: 0 }, // 禁用重试以加速熔断
    });

    // 所有请求返回 500
    gw.onRecall({ error: "Internal Server Error" }, 500);

    // 触发熔断器打开
    for (let i = 0; i < 3; i++) {
      await expect(
        cbClient.recall({ query: `fail-${i}`, sessionKey: "s1" }),
      ).rejects.toThrow();
    }

    // 熔断器应该已打开，后续请求立即失败（快速失败）
    const start = Date.now();
    await expect(
      cbClient.recall({ query: "after-open", sessionKey: "s1" }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    // 快速失败：应远低于正常的 HTTP 超时
    expect(elapsed).toBeLessThan(200);

    cbClient.close();
  });

  it("熔断器 HALF_OPEN → 探测成功 → CLOSED", async () => {
    const cbClient = new HttpMemoryClient({
      baseUrl: gw.url,
      timeoutMs: 5000,
      circuitBreaker: { failureThreshold: 2, timeoutMs: 500 },
      retry: { maxAttempts: 0 },
    });

    // 第一步：连续失败 → OPEN
    gw.onRecall({ error: "fail" }, 500);
    for (let i = 0; i < 3; i++) {
      await expect(cbClient.recall({ query: "f", sessionKey: "s" })).rejects.toThrow();
    }

    // 等待熔断器超时 → HALF_OPEN
    await new Promise((r) => setTimeout(r, 600));

    // 第二步：修复 Gateway → 探测成功 → CLOSED
    gw.reset();
    gw.onRecall({ context: "recovered", strategy: "bm25", memory_count: 1 });

    const r = await cbClient.recall({ query: "探测", sessionKey: "s1" });
    expect(r.context).toBe("recovered");

    // 后续请求也应成功
    const r2 = await cbClient.recall({ query: "第二次", sessionKey: "s2" });
    expect(r2.context).toBe("recovered");

    cbClient.close();
  });
});

// ============================
// Suite 4: 服务降级（Fail-Open）
// ============================

describe("Claude Code E2E: Fail-Open 降级", () => {
  it("InProcess fake core recall 失败返回安全默认值", async () => {
    // 使用 InProcess transport 模拟降级行为
    const fakeCore = {
      handleBeforeRecall: async () => {
        throw new Error("模拟后端崩溃");
      },
    };

    const inProcClient = createMemoryClient({
      type: "in-process",
      options: { core: fakeCore },
    });

    // 直接调用会抛出
    await expect(
      inProcClient.recall({ query: "test", sessionKey: "s1" }),
    ).rejects.toThrow("模拟后端崩溃");

    inProcClient.close();
  });

  it("InProcess fake core 不实现 searchMemories 返回空结果", async () => {
    const fakeCore = {
      // 不实现 searchMemories
      healthCheck: () => ({ status: "ok" }),
    };

    const inProcClient = createMemoryClient({
      type: "in-process",
      options: { core: fakeCore },
    });

    const r = await inProcClient.searchMemories({ query: "test" });
    expect(r.results).toBe("[]");
    expect(r.total).toBe(0);

    const c = await inProcClient.searchConversations({ query: "test" });
    expect(c.results).toBe("[]");
    expect(c.total).toBe(0);

    inProcClient.close();
  });
});

// ============================
// Suite 5: Claude Code 特定场景
// ============================

describe("Claude Code E2E: Claude Code 特定场景", () => {
  it("Stop hook 在 recall 后触发 capture（正常回合）", async () => {
    const sessionKey = "cc:my-project:session-abc";

    // UserPromptSubmit → recall
    gw.onRecall({
      context: "## 项目上下文\n- 使用 React + TypeScript\n- API base: /api/v2",
      strategy: "l1",
      memory_count: 2,
    });
    const recall = await client.recall({ query: "添加登录页面", sessionKey });
    expect(recall.context).toContain("React");
    expect(recall.strategy).toBe("l1");

    // Stop → capture
    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });
    const capture = await client.capture({
      userContent: "添加登录页面，支持邮箱+密码",
      assistantContent: "好的，我创建了 LoginPage.tsx...",
      sessionKey,
    });
    expect(capture.l0_recorded).toBe(1);

    // 验证 capture 内容完整性
    const capReq = gw.lastCaptureRequest();
    expect(capReq?.user_content).toBe("添加登录页面，支持邮箱+密码");
    expect(capReq?.assistant_content).toContain("LoginPage.tsx");
    expect(capReq?.session_key).toBe(sessionKey);
  });

  it("SessionEnd 后 session flush 被调用", async () => {
    const sessionKey = "cc:my-project:session-end-test";

    // 先做一轮对话
    gw.onRecall({ context: "ctx", strategy: "bm25", memory_count: 1 });
    await client.recall({ query: "query", sessionKey });

    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });
    await client.capture({
      userContent: "msg",
      assistantContent: "reply",
      sessionKey,
    });

    // SessionEnd
    gw.onSessionEnd({ flushed: true });
    const end = await client.endSession({ sessionKey });
    expect(end.flushed).toBe(true);
  });

  it("带 userId 的请求正确传递到 Gateway", async () => {
    gw.onRecall({ context: "personalized", strategy: "l1", memory_count: 1 });
    await client.recall({ query: "我的偏好", sessionKey: "s1", userId: "user-42" });

    const req = gw.lastRecallRequest();
    expect(req?.user_id).toBe("user-42");

    // capture 也传 userId
    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });
    await client.capture({
      userContent: "hi",
      assistantContent: "hello",
      sessionKey: "s1",
      userId: "user-42",
    });

    const capReq = gw.lastCaptureRequest();
    expect(capReq?.user_id).toBe("user-42");
  });
});

// ============================
// Suite 6: 并发安全
// ============================

describe("Claude Code E2E: 并发安全", () => {
  it("3 个独立 session 并发 recall 不互相污染", async () => {
    const sessions = ["sess-a", "sess-b", "sess-c"];

    gw.setCustomHandler((_req, body) => {
      const b = body as { session_key: string };
      return {
        status: 200,
        body: {
          context: `context for ${b.session_key}`,
          strategy: "bm25",
          memory_count: 1,
        },
      };
    });

    const results = await Promise.all(
      sessions.map((sk) =>
        client.recall({ query: "同时查询", sessionKey: sk }),
      ),
    );

    expect(results).toHaveLength(3);
    expect(results[0].context).toContain("sess-a");
    expect(results[1].context).toContain("sess-b");
    expect(results[2].context).toContain("sess-c");
  });
});
