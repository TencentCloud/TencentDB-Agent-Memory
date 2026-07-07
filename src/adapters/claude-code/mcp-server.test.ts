import { describe, it, expect, vi } from "vitest";
import { dispatchToolCall } from "./mcp-server";
import type { TdaiClient } from "../../sdk/client";
import type { ClaudeCodeAdapterConfig } from "./config";

// ============================
// mock client
// ============================

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

const config: ClaudeCodeAdapterConfig = {
  gatewayHost: "127.0.0.1",
  gatewayPort: 8420,
  gatewayBaseUrl: "http://127.0.0.1:8420",
  apiKey: "test-key",
  userId: "default_user",
};

// ============================
// tests
// ============================

describe("dispatchToolCall", () => {
  // ─── tdai_memory_search ────────────────────────────────────────────────────

  it("memory_search 成功 → 返回 results 文本", async () => {
    const client = makeMockClient();
    client.searchMemories.mockResolvedValue({
      results: "记忆A\n记忆B",
      total: 2,
      strategy: "hybrid",
    });
    const result = await dispatchToolCall(client, config, "tdai_memory_search", {
      query: "用户偏好",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: "text", text: "记忆A\n记忆B" });
  });

  it("memory_search 调用参数：query/limit/type/scene", async () => {
    const client = makeMockClient();
    client.searchMemories.mockResolvedValue({ results: "", total: 0, strategy: "x" });
    await dispatchToolCall(client, config, "tdai_memory_search", {
      query: "q",
      limit: 5,
      type: "persona",
      scene: "work",
    });
    expect(client.searchMemories).toHaveBeenCalledWith({
      query: "q",
      limit: 5,
      type: "persona",
      scene: "work",
    });
  });

  it("memory_search 缺 query → isError", async () => {
    const client = makeMockClient();
    const result = await dispatchToolCall(client, config, "tdai_memory_search", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("query");
  });

  it("memory_search query 为空串 → isError", async () => {
    const client = makeMockClient();
    const result = await dispatchToolCall(client, config, "tdai_memory_search", { query: "  " });
    expect(result.isError).toBe(true);
  });

  it("memory_search limit clamp：100→20", async () => {
    const client = makeMockClient();
    client.searchMemories.mockResolvedValue({ results: "", total: 0, strategy: "x" });
    await dispatchToolCall(client, config, "tdai_memory_search", { query: "q", limit: 100 });
    expect(client.searchMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("memory_search limit clamp：0→1", async () => {
    const client = makeMockClient();
    client.searchMemories.mockResolvedValue({ results: "", total: 0, strategy: "x" });
    await dispatchToolCall(client, config, "tdai_memory_search", { query: "q", limit: 0 });
    expect(client.searchMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it("memory_search limit 字符串 \"5\" → 5", async () => {
    const client = makeMockClient();
    client.searchMemories.mockResolvedValue({ results: "", total: 0, strategy: "x" });
    await dispatchToolCall(client, config, "tdai_memory_search", { query: "q", limit: "5" });
    expect(client.searchMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it("memory_search limit 缺省 → undefined", async () => {
    const client = makeMockClient();
    client.searchMemories.mockResolvedValue({ results: "", total: 0, strategy: "x" });
    await dispatchToolCall(client, config, "tdai_memory_search", { query: "q" });
    expect(client.searchMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
  });

  it("memory_search client 抛错 → isError 且含错误信息", async () => {
    const client = makeMockClient();
    client.searchMemories.mockRejectedValue(new Error("gateway timeout"));
    const result = await dispatchToolCall(client, config, "tdai_memory_search", { query: "q" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("gateway timeout");
  });

  // ─── tdai_conversation_search ──────────────────────────────────────────────

  it("conversation_search 成功 → 返回 results 文本", async () => {
    const client = makeMockClient();
    client.searchConversations.mockResolvedValue({ results: "对话1", total: 1 });
    const result = await dispatchToolCall(client, config, "tdai_conversation_search", {
      query: "历史对话",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("对话1");
  });

  it("conversation_search session_key → sessionKey 转换", async () => {
    const client = makeMockClient();
    client.searchConversations.mockResolvedValue({ results: "", total: 0 });
    await dispatchToolCall(client, config, "tdai_conversation_search", {
      query: "q",
      session_key: "sess-xyz",
    });
    expect(client.searchConversations).toHaveBeenCalledWith({
      query: "q",
      limit: undefined,
      sessionKey: "sess-xyz",
    });
  });

  it("conversation_search 缺 query → isError", async () => {
    const client = makeMockClient();
    const result = await dispatchToolCall(client, config, "tdai_conversation_search", {
      session_key: "s",
    });
    expect(result.isError).toBe(true);
  });

  // ─── tdai_capture ──────────────────────────────────────────────────────────

  it("capture 成功 → 返回 JSON ack", async () => {
    const client = makeMockClient();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    const result = await dispatchToolCall(client, config, "tdai_capture", {
      user_content: "你好",
      assistant_content: "你好！",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      l0_recorded: 1,
      scheduler_notified: true,
    });
  });

  it("capture 调用参数：user/assistant/sessionKey/userId", async () => {
    const client = makeMockClient();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    await dispatchToolCall(client, config, "tdai_capture", {
      user_content: "u",
      assistant_content: "a",
      session_key: "sess-1",
    });
    expect(client.capture).toHaveBeenCalledWith("u", "a", "sess-1", { userId: "default_user" });
  });

  it("capture session_key 缺省 → resolveSessionKey（cwd::date 格式）", async () => {
    const client = makeMockClient();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: true });
    await dispatchToolCall(client, config, "tdai_capture", {
      user_content: "u",
      assistant_content: "a",
    });
    const callArgs = client.capture.mock.calls[0];
    const sessionKey = callArgs[2] as string;
    // resolveSessionKey 回退格式：归一化路径::YYYY-MM-DD
    expect(sessionKey).toMatch(/.+::\d{4}-\d{2}-\d{2}$/);
  });

  it("capture 缺 user_content → isError", async () => {
    const client = makeMockClient();
    const result = await dispatchToolCall(client, config, "tdai_capture", {
      assistant_content: "a",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("user_content");
  });

  it("capture 缺 assistant_content → isError", async () => {
    const client = makeMockClient();
    const result = await dispatchToolCall(client, config, "tdai_capture", {
      user_content: "u",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("assistant_content");
  });

  it("capture client 抛错 → isError", async () => {
    const client = makeMockClient();
    client.capture.mockRejectedValue(new Error("capture failed"));
    const result = await dispatchToolCall(client, config, "tdai_capture", {
      user_content: "u",
      assistant_content: "a",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("capture failed");
  });

  // ─── 未知工具 / 兜底 ─────────────────────────────────────────────────────────

  it("未知工具 → isError 且含工具名", async () => {
    const client = makeMockClient();
    const result = await dispatchToolCall(client, config, "tdai_unknown", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("tdai_unknown");
  });

  it("所有结果 content 都是 { type: 'text' } 结构", async () => {
    const client = makeMockClient();
    client.searchMemories.mockResolvedValue({ results: "ok", total: 1, strategy: "x" });
    const result = await dispatchToolCall(client, config, "tdai_memory_search", { query: "q" });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
  });
});
