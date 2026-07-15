import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeEventBinding } from "./claude-code-binding";
import type { TdaiClient } from "../../sdk/client";
import type { ClaudeCodeAdapterConfig } from "./config";
import type { HostEventContext, HostCompletedTurn } from "../../sdk/event-binding";
import { TDAI_TOOL_SCHEMAS } from "../../sdk/tool-schemas";

// ============================
// mock client
// ============================

/** 用 vi.fn() 构造的 mock TdaiClient，便于断言调用参数与控制返回值。 */
interface MockClient extends TdaiClient {
  recall: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  searchMemories: ReturnType<typeof vi.fn>;
  searchConversations: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    recall: vi.fn(),
    capture: vi.fn(),
    searchMemories: vi.fn(),
    searchConversations: vi.fn(),
    endSession: vi.fn(),
    health: vi.fn(),
  };
}

// ============================
// fixtures
// ============================

const baseConfig: ClaudeCodeAdapterConfig = {
  gatewayHost: "127.0.0.1",
  gatewayPort: 8420,
  gatewayBaseUrl: "http://127.0.0.1:8420",
  apiKey: "test-key",
  userId: "default_user",
};

function setup(config: ClaudeCodeAdapterConfig = baseConfig) {
  const client = makeMockClient();
  const binding = new ClaudeCodeEventBinding(client, config);
  return { client, binding };
}

const baseCtx: HostEventContext = {
  sessionKey: "sess-abc",
  sessionId: "sid-abc",
  userId: "user-1",
  workspaceDir: "/tmp/proj",
};

const baseTurn: HostCompletedTurn = {
  userText: "你好",
  assistantText: "你好，有什么可以帮你的？",
  sessionKey: "sess-abc",
  sessionId: "sid-abc",
  messages: [{ role: "user", content: "你好" }],
};

// ============================
// tests
// ============================

describe("ClaudeCodeEventBinding", () => {
  // ─── hostType ──────────────────────────────────────────────────────────────

  it("hostType === 'claude-code'", () => {
    const { binding } = setup();
    expect(binding.hostType).toBe("claude-code");
  });

  // ─── onUserPrompt ──────────────────────────────────────────────────────────

  it("recall 成功 → context 包裹进 <relevant-memories> 注入", async () => {
    const { client, binding } = setup();
    client.recall.mockResolvedValue({ context: "用户喜欢深色模式" });
    const injection = await binding.onUserPrompt("用什么主题", baseCtx);
    expect(injection).toEqual({
      additionalContext: "<relevant-memories>\n用户喜欢深色模式\n</relevant-memories>",
    });
  });

  it("recall 调用参数：prompt / sessionKey / userId", async () => {
    const { client, binding } = setup();
    client.recall.mockResolvedValue({ context: "x" });
    await binding.onUserPrompt("用什么主题", baseCtx);
    expect(client.recall).toHaveBeenCalledWith("用什么主题", "sess-abc", "user-1");
  });

  it("recall context 带首尾空白 → trim 后注入", async () => {
    const { client, binding } = setup();
    client.recall.mockResolvedValue({ context: "  记忆内容  \n" });
    const injection = await binding.onUserPrompt("q", baseCtx);
    expect(injection?.additionalContext).toBe(
      "<relevant-memories>\n记忆内容\n</relevant-memories>",
    );
  });

  it("recall context 为空串 → 返回 null（不注入）", async () => {
    const { client, binding } = setup();
    client.recall.mockResolvedValue({ context: "" });
    const injection = await binding.onUserPrompt("q", baseCtx);
    expect(injection).toBeNull();
  });

  it("recall context 为纯空白 → 返回 null", async () => {
    const { client, binding } = setup();
    client.recall.mockResolvedValue({ context: "   \n\t " });
    const injection = await binding.onUserPrompt("q", baseCtx);
    expect(injection).toBeNull();
  });

  it("recall context 缺失（undefined）→ 返回 null", async () => {
    const { client, binding } = setup();
    client.recall.mockResolvedValue({} as never);
    const injection = await binding.onUserPrompt("q", baseCtx);
    expect(injection).toBeNull();
  });

  it("recall 抛错 → 返回 null（记忆不阻塞对话）", async () => {
    const { client, binding } = setup();
    client.recall.mockRejectedValue(new Error("gateway down"));
    const injection = await binding.onUserPrompt("q", baseCtx);
    expect(injection).toBeNull();
  });

  it("ctx.userId 为空白 → 回退 config.userId", async () => {
    const { client, binding } = setup();
    client.recall.mockResolvedValue({ context: "x" });
    const ctx: HostEventContext = { ...baseCtx, userId: "   " };
    await binding.onUserPrompt("q", ctx);
    expect(client.recall).toHaveBeenCalledWith("q", "sess-abc", "default_user");
  });

  it("注入的 additionalContext 能被 OpenClaw 清洗正则匹配", async () => {
    // 对齐 index.ts:628 的 /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g
    const { client, binding } = setup();
    client.recall.mockResolvedValue({ context: "记忆A\n记忆B" });
    const injection = await binding.onUserPrompt("q", baseCtx);
    const text = `前置文本 ${injection!.additionalContext} 后置文本`;
    const cleaned = text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "").trim();
    expect(cleaned).toBe("前置文本 后置文本");
  });

  // ─── onTurnEnd ─────────────────────────────────────────────────────────────

  it("capture 成功 → CaptureResponse(snake) 映射为 CaptureAck(camel)", async () => {
    const { client, binding } = setup();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    const ack = await binding.onTurnEnd(baseTurn, baseCtx);
    expect(ack).toEqual({ l0Recorded: 1, schedulerNotified: true });
  });

  it("capture 调用参数：userText / assistantText / sessionKey / opts", async () => {
    const { client, binding } = setup();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    await binding.onTurnEnd(baseTurn, baseCtx);
    expect(client.capture).toHaveBeenCalledWith(
      "你好",
      "你好，有什么可以帮你的？",
      "sess-abc",
      {
        sessionId: "sid-abc",
        userId: "user-1",
        messages: [{ role: "user", content: "你好" }],
      },
    );
  });

  it("sessionId 优先 turn.sessionId", async () => {
    const { client, binding } = setup();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    const turn: HostCompletedTurn = { ...baseTurn, sessionId: "turn-sid" };
    await binding.onTurnEnd(turn, baseCtx);
    expect(client.capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ sessionId: "turn-sid" }),
    );
  });

  it("turn 无 sessionId → 回退 ctx.sessionId", async () => {
    const { client, binding } = setup();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    const turn: HostCompletedTurn = {
      userText: "a",
      assistantText: "b",
      sessionKey: "sess-abc",
    };
    await binding.onTurnEnd(turn, baseCtx);
    expect(client.capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ sessionId: "sid-abc" }),
    );
  });

  it("turn 与 ctx 均无 sessionId → opts.sessionId 为 undefined", async () => {
    const { client, binding } = setup();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    const turn: HostCompletedTurn = {
      userText: "a",
      assistantText: "b",
      sessionKey: "sess-abc",
    };
    const ctx: HostEventContext = { sessionKey: "sess-abc", userId: "u-1" };
    await binding.onTurnEnd(turn, ctx);
    expect(client.capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ sessionId: undefined }),
    );
  });

  it("turn 无 messages → opts.messages 为 undefined", async () => {
    const { client, binding } = setup();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    const turn: HostCompletedTurn = {
      userText: "a",
      assistantText: "b",
      sessionKey: "sess-abc",
    };
    await binding.onTurnEnd(turn, baseCtx);
    expect(client.capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ messages: undefined }),
    );
  });

  it("ctx.userId 为空白 → capture opts.userId 回退 config.userId", async () => {
    const { client, binding } = setup();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    const ctx: HostEventContext = { ...baseCtx, userId: "  " };
    await binding.onTurnEnd(baseTurn, ctx);
    expect(client.capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: "default_user" }),
    );
  });

  it("capture 抛错 → 返回 null（记忆不阻塞对话）", async () => {
    const { client, binding } = setup();
    client.capture.mockRejectedValue(new Error("gateway 500"));
    const ack = await binding.onTurnEnd(baseTurn, baseCtx);
    expect(ack).toBeNull();
  });

  // ─── onSessionEnd ──────────────────────────────────────────────────────────

  it("endSession 调用参数：sessionKey / userId", async () => {
    const { client, binding } = setup();
    client.endSession.mockResolvedValue(undefined);
    await binding.onSessionEnd(baseCtx);
    expect(client.endSession).toHaveBeenCalledWith("sess-abc", "user-1");
  });

  it("ctx.userId 为空白 → endSession 回退 config.userId", async () => {
    const { client, binding } = setup();
    client.endSession.mockResolvedValue(undefined);
    const ctx: HostEventContext = { ...baseCtx, userId: "  " };
    await binding.onSessionEnd(ctx);
    expect(client.endSession).toHaveBeenCalledWith("sess-abc", "default_user");
  });

  it("endSession 抛错 → 静默返回（不抛出）", async () => {
    const { client, binding } = setup();
    client.endSession.mockRejectedValue(new Error("flush failed"));
    await expect(binding.onSessionEnd(baseCtx)).resolves.toBeUndefined();
  });

  // ─── getToolSchemas ────────────────────────────────────────────────────────

  it("返回 3 个工具 schema，名称正确", () => {
    const { binding } = setup();
    const schemas = binding.getToolSchemas();
    expect(schemas).toHaveLength(3);
    expect(schemas.map((s) => s.name)).toEqual([
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_capture",
    ]);
  });

  it("返回数组副本：两次调用返回不同引用，修改返回值不影响常量", () => {
    const { binding } = setup();
    const a = binding.getToolSchemas();
    const b = binding.getToolSchemas();
    expect(a).not.toBe(b); // 不同数组引用
    expect(a).toEqual(b); // 内容相同
    // 修改返回的数组（push）不影响后续调用
    a.push({ name: "mutated", description: "", parameters: {} });
    const c = binding.getToolSchemas();
    expect(c).toHaveLength(3);
    expect(TDAI_TOOL_SCHEMAS).toHaveLength(3); // 常量未被污染
  });

  it("schema 内容与 TDAI_TOOL_SCHEMAS 一致", () => {
    const { binding } = setup();
    const schemas = binding.getToolSchemas();
    expect(schemas[0]).toEqual(TDAI_TOOL_SCHEMAS[0]);
    expect(schemas[1]).toEqual(TDAI_TOOL_SCHEMAS[1]);
    expect(schemas[2]).toEqual(TDAI_TOOL_SCHEMAS[2]);
  });
});
