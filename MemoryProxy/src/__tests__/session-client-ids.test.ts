import { describe, it, expect } from "vitest";
import {
  extractResponsesSessionId,
  extractCodexSessionId,
  extractWorkbuddySessionId,
} from "../session/client-ids.js";

/**
 * Responses 类客户端（codex / workbuddy）的显式会话 ID 提取。
 *
 * 该文件的职责是锁住"显式会话 header 优先"这条验收标准（session-policy.md ACC-4）
 * 在 Responses 路径上的实现口径：header 集合与 resolveConversationId 一致，
 * 顺序为 session-id > x-conversation-id > x-session-id > x-chat-id > x-thread-id，
 * 最后才退回 body.client_metadata.session_id。
 */
describe("Responses 路径的显式会话 ID 提取（client-ids）", () => {
  it("session-id header 优先于其他一切来源", () => {
    const sid = extractResponsesSessionId(
      { "session-id": "sid-1", "x-conversation-id": "conv-1" },
      { client_metadata: { session_id: "meta-1" } },
    );
    expect(sid).toBe("sid-1");
  });

  it("x-conversation-id 生效（与 chat / anthropic 路径同集合）", () => {
    const sid = extractResponsesSessionId({ "x-conversation-id": "conv-2" }, {});
    expect(sid).toBe("conv-2");
  });

  it("x-session-id / x-chat-id / x-thread-id 依次生效", () => {
    expect(extractResponsesSessionId({ "x-session-id": "s-3" }, {})).toBe("s-3");
    expect(extractResponsesSessionId({ "x-chat-id": "c-4" }, {})).toBe("c-4");
    expect(extractResponsesSessionId({ "x-thread-id": "t-5" }, {})).toBe("t-5");
  });

  it("header 名大小写不敏感", () => {
    const sid = extractResponsesSessionId({ "X-Conversation-Id": "conv-6" }, {});
    expect(sid).toBe("conv-6");
  });

  it("无会话 header 时退回 client_metadata.session_id", () => {
    const sid = extractResponsesSessionId({}, { client_metadata: { session_id: "meta-7" } });
    expect(sid).toBe("meta-7");
  });

  it("空字符串与非法类型视为未提供", () => {
    expect(extractResponsesSessionId({ "x-conversation-id": "" }, {})).toBeNull();
    expect(
      extractResponsesSessionId({}, { client_metadata: { session_id: 42 } }),
    ).toBeNull();
  });

  it("两种来源都缺失 → null（交由 auto 会话或兜底键）", () => {
    expect(extractResponsesSessionId({}, {})).toBeNull();
  });

  it("codex / workbuddy 别名与主函数同实现", () => {
    const headers = { "x-conversation-id": "conv-8" };
    expect(extractCodexSessionId(headers, {})).toBe("conv-8");
    expect(extractWorkbuddySessionId(headers, {})).toBe("conv-8");
    expect(extractCodexSessionId).toBe(extractResponsesSessionId);
    expect(extractWorkbuddySessionId).toBe(extractResponsesSessionId);
  });
});
