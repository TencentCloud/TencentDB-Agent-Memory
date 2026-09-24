import { describe, it, expect } from "vitest";
import {
  extractResponsesSessionId,
  extractCodexSessionId,
  extractWorkbuddySessionId,
} from "../session/client-ids.js";
import { resolveConversationId } from "../session/session-key.js";

/**
 * Responses 类客户端（codex / workbuddy）的显式会话 ID 提取，
 * 以及与 chat / anthropic 路径（`resolveConversationId`）的口径对照。
 *
 * 该文件的职责是锁住"显式会话 header 优先"这条验收标准（session-policy.md ACC-4）
 * 在两条路径上的实现口径。两条路径**共享**同一段公共前缀与优先级
 * （x-conversation-id > x-session-id > x-chat-id > x-thread-id），但**不是完全同集合**：
 *
 *   - Responses 路径：session-id > x-conversation-id > x-session-id > x-chat-id >
 *     x-thread-id，全缺时退回 body.client_metadata.session_id；
 *   - Chat / Anthropic 路径：x-conversation-id > x-session-id >
 *     x-claude-code-session-id > x-deepseek-harness-session-id > x-chat-id > x-thread-id。
 *
 * 也就是说 Responses 侧多一个 `session-id`（Codex 历史口径），Chat / Anthropic 侧多
 * 两个客户端专有头。这是刻意的按客户端分族，不是遗漏；下面两个用例把两侧集合分别锁住，
 * 避免文档与实现再次漂移（对照表见 docs/design/session-isolation-design.md §3.1）。
 */

/** 只实现 resolveConversationId 用到的 c.req.header()，避免为一个纯函数测试拉起 Hono。 */
const ctxWithHeaders = (headers: Record<string, string>) =>
  ({
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  }) as never;

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

  it("与 chat / anthropic 路径的公共段：同集合、同优先级（ACC-4 依赖的部分）", () => {
    for (const [name, value] of [
      ["x-conversation-id", "conv"],
      ["x-session-id", "sess"],
      ["x-chat-id", "chat"],
      ["x-thread-id", "thread"],
    ] as const) {
      expect(extractResponsesSessionId({ [name]: value }, {})).toBe(value);
      expect(resolveConversationId(ctxWithHeaders({ [name]: value }))).toBe(value);
    }

    // 公共段内部的优先级也一致：x-conversation-id 压过其余三个。
    const allCommon = {
      "x-conversation-id": "conv",
      "x-session-id": "sess",
      "x-chat-id": "chat",
      "x-thread-id": "thread",
    };
    expect(extractResponsesSessionId(allCommon, {})).toBe("conv");
    expect(resolveConversationId(ctxWithHeaders(allCommon))).toBe("conv");
  });

  it("两条路径的客户端专有头互不识别（集合并非完全相等，改这里要同步设计文档）", () => {
    // Responses 侧专有：session-id（Codex 历史口径）。
    expect(extractResponsesSessionId({ "session-id": "codex-sid" }, {})).toBe("codex-sid");
    expect(resolveConversationId(ctxWithHeaders({ "session-id": "codex-sid" }))).toBeNull();

    // Chat / Anthropic 侧专有：Claude Code 与 DSH 各自的 session 头。
    const cc = { "x-claude-code-session-id": "cc-sid" };
    const dsh = { "x-deepseek-harness-session-id": "dsh-sid" };
    expect(resolveConversationId(ctxWithHeaders(cc))).toBe("cc-sid");
    expect(resolveConversationId(ctxWithHeaders(dsh))).toBe("dsh-sid");
    expect(extractResponsesSessionId(cc, {})).toBeNull();
    expect(extractResponsesSessionId(dsh, {})).toBeNull();
  });
});
