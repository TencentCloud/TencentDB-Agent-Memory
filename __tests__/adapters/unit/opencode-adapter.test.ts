/**
 * OpenCode 适配器测试 — 验证适配器生命周期方法和 fail-open 行为。
 *
 * 使用 FakeGateway 避免真实 Gateway 依赖。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { GatewayClient, OpenCodeMemoryAdapter } from "../../../src/adapters/index.js";

let gw: FakeGateway;
let adapter: OpenCodeMemoryAdapter;

beforeAll(async () => {
  gw = new FakeGateway();
  await gw.start();
});

afterAll(async () => {
  await gw.stop();
});

beforeEach(() => {
  gw.reset();
  const client = new GatewayClient({ baseUrl: gw.url, timeoutMs: 5000 });
  adapter = new OpenCodeMemoryAdapter({
    client,
    workspacePrefix: "test-project",
  });
});

// ============================
// Suite 1: 基础操作
// ============================

describe("OpenCode 适配器: 基础操作", () => {
  it("recallForPrompt 正确召回记忆", async () => {
    gw.onRecall({
      context: "项目使用 React + TypeScript",
      strategy: "l1",
      memory_count: 3,
    });

    const r = await adapter.recallForPrompt("添加新组件", "session-1");

    expect(r.context).toContain("React");
    expect(r.strategy).toBe("l1");
    expect(r.memoryCount).toBe(3);

    // 验证 session key 带 workspace 前缀
    const req = gw.lastRecallRequest();
    expect(req?.session_key).toBe("opencode:test-project:session-1");
  });

  it("captureTurn 正确捕获对话", async () => {
    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });

    const r = await adapter.captureTurn({
      userText: "创建 Button 组件",
      assistantText: "好的，已创建 Button.tsx",
      sessionKey: "session-2",
    });

    expect(r.l0Recorded).toBe(1);
    expect(r.schedulerNotified).toBe(true);

    const req = gw.lastCaptureRequest();
    expect(req?.user_content).toBe("创建 Button 组件");
    expect(req?.assistant_content).toBe("好的，已创建 Button.tsx");
    expect(req?.session_key).toBe("opencode:test-project:session-2");
  });

  it("searchMemory 正确搜索 L1", async () => {
    gw.onSearchMemories({
      results: JSON.stringify([{ content: "找到的记忆", score: 0.95 }]),
      total: 1,
      strategy: "hybrid",
    });

    const r = await adapter.searchMemory("记忆搜索");
    expect(r.total).toBe(1);
    expect(r.strategy).toBe("hybrid");
  });

  it("searchConversations 正确搜索 L0", async () => {
    gw.onSearchConversations({
      results: JSON.stringify([{ role: "user", content: "之前讨论过" }]),
      total: 1,
    });

    const r = await adapter.searchConversations("对话搜索", 3, "session-3");
    expect(r.total).toBe(1);
  });

  it("endSession 正确刷新", async () => {
    gw.onSessionEnd({ flushed: true });

    const r = await adapter.endSession("session-4");
    expect(r.flushed).toBe(true);
  });
});

// ============================
// Suite 2: Fail-Open 降级
// ============================

describe("OpenCode 适配器: Fail-Open", () => {
  it("Gateway 500 时 recallForPrompt 返回空上下文（fail-open）", async () => {
    gw.onRecall({ error: "Internal Server Error" }, 500);

    const r = await adapter.recallForPrompt("test", "fail-sess");

    // 不抛异常，返回安全默认值
    expect(r.context).toBe("");
    expect(r.memoryCount).toBe(0);
    expect(r.strategy).toBe("error");
  });

  it("Gateway 不可达时 captureTurn 返回安全值（fail-open）", async () => {
    gw.onCapture({ error: "Service Unavailable" }, 503);

    const r = await adapter.captureTurn({
      userText: "test",
      assistantText: "reply",
      sessionKey: "fail-sess",
    });

    // 不抛异常
    expect(r.l0Recorded).toBe(0);
    expect(r.schedulerNotified).toBe(false);
  });

  it("Gateway 500 时 searchMemory 返回空结果", async () => {
    gw.onSearchMemories({ error: "fail" }, 500);

    const r = await adapter.searchMemory("test query");
    expect(r.total).toBe(0);
    expect(r.results).toBe("[]");
  });

  it("Gateway 500 时 searchConversations 返回空结果", async () => {
    gw.onSearchConversations({ error: "fail" }, 500);

    const r = await adapter.searchConversations("test query");
    expect(r.total).toBe(0);
    expect(r.results).toBe("[]");
  });

  it("Gateway 500 时 endSession 仍返回 flushed（fail-open）", async () => {
    gw.onSessionEnd({ error: "Internal Error" }, 500);

    const r = await adapter.endSession("fail-sess");
    // 不抛异常
    expect(r.flushed).toBe(false);
  });
});

// ============================
// Suite 3: Session Key 隔离
// ============================

describe("OpenCode 适配器: Session Key", () => {
  it("无 workspacePrefix 时仅带 opencode 前缀", () => {
    const client = new GatewayClient({ baseUrl: gw.url });
    const plainAdapter = new OpenCodeMemoryAdapter({ client });

    const key = plainAdapter.resolveSessionKey("my-session");
    expect(key).toBe("opencode:my-session");
  });

  it("带 workspacePrefix 时正确分隔", () => {
    const key = adapter.resolveSessionKey("conv-42");
    expect(key).toBe("opencode:test-project:conv-42");
  });

  it("不同 workspace 使用不同的 session key", async () => {
    const client = new GatewayClient({ baseUrl: gw.url });
    const adapterA = new OpenCodeMemoryAdapter({ client, workspacePrefix: "proj-a" });
    const adapterB = new OpenCodeMemoryAdapter({ client, workspacePrefix: "proj-b" });

    expect(adapterA.resolveSessionKey("s1")).not.toBe(adapterB.resolveSessionKey("s1"));
    expect(adapterA.resolveSessionKey("s1")).toBe("opencode:proj-a:s1");
    expect(adapterB.resolveSessionKey("s1")).toBe("opencode:proj-b:s1");
  });
});

// ============================
// Suite 4: 接口合规
// ============================

describe("OpenCode 适配器: 接口合规", () => {
  it("实现 BaseMemoryPlatformAdapter 接口", () => {
    expect(adapter.name).toBe("opencode-memory-adapter");
    expect(adapter.platform).toBe("opencode");
  });

  it("支持默认 userId", async () => {
    gw.onRecall({ context: "test", strategy: "bm25", memory_count: 1 });

    const adapterWithUser = new OpenCodeMemoryAdapter({
      client: new GatewayClient({ baseUrl: gw.url }),
      defaultUserId: "custom-user",
    });

    await adapterWithUser.recallForPrompt("test", "s1");
    const req = gw.lastRecallRequest();
    expect(req?.user_id).toBe("custom-user");
  });

  it("per-call userId 覆盖 defaultUserId", async () => {
    gw.onRecall({ context: "test", strategy: "bm25", memory_count: 1 });

    await adapter.recallForPrompt("test", "s1", "per-call-user");
    const req = gw.lastRecallRequest();
    expect(req?.user_id).toBe("per-call-user");
  });
});
