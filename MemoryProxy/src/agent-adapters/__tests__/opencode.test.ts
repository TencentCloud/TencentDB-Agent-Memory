/**
 * opencode adapter — L0 turn-input extraction (backward scan).
 *
 * 回归背景（2026-10-26 实抓，issue 待提）：
 *   OpenCode 2.x 的 session-init 表单（`question` tool_call，id 前缀
 *   `call_oc_session_init_`）被回答后，OpenCode 会把
 *   [assistant(表单 tool_call), tool(表单回答)] 追加在用户消息之后重发。
 *   58e4c55 引入的「最后一条必须是 user 才写 L0」判据在这种请求上永远拿不到
 *   用户输入 → 整个回合的 L0 静默丢失（write-l0 从不打印）。
 *
 *   修法：从后往前扫，跳过 session-init 表单回执；落在 user 上则抽取，
 *   落在真实工具循环尾部（非表单 tool / assistant）则返回 ""（保持 58e4c55
 *   的防写放大语义，见 #1621）。
 */

import { describe, expect, it } from "vitest";
import { opencodeAdapter } from "../opencode.js";

/** 类型安全包装：方法缺失时直接失败，不静默通过。 */
function extractL0(messages: unknown[]): string {
  const fn = opencodeAdapter.extractL0UserQuery;
  if (!fn) throw new Error("opencodeAdapter.extractL0UserQuery not implemented");
  return fn.call(opencodeAdapter, messages);
}

// ── fixtures（形态取自 2026-10-26 生产抓包 /tmp/dumps） ─────────────────────

/** 真实用户消息（裸文本，OpenCode 主请求形态）。 */
const USER_MSG = { role: "user", content: "现在再检查一下我的这个项目吧，还有什么可以优化的地方" };

/** proxy 伪造的 session-init 表单 tool_call（id 前缀 call_oc_session_init_）。 */
const FORM_ASSISTANT = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_oc_session_init_1793008555998",
      type: "function",
      function: { name: "question", arguments: "{\"questions\":[...]}" },
    },
  ],
};

/** opencode `question` 工具回答回执（固定开头）。 */
const FORM_ANSWER = {
  role: "tool",
  tool_call_id: "call_oc_session_init_1793008555998",
  content:
    "User has answered your questions: \"本次对话是否要关联团队资产？（请选择最匹配的选项）\"=\"是，关联团队资产\". You can now continue with the user's answers in mind.",
};

/** 真实工具循环（非表单）：assistant 带 read tool_call。 */
const REAL_ASSISTANT = {
  role: "assistant",
  content: "我系统性地把项目再过一遍。",
  tool_calls: [
    { id: "call_1ac846a85d254701a04e4034", type: "function", function: { name: "read", arguments: "{}" } },
  ],
};

/** 真实工具循环（非表单）：read 的 tool 结果。 */
const REAL_TOOL_RESULT = {
  role: "tool",
  tool_call_id: "call_1ac846a85d254701a04e4034",
  content: "Read file /Users/xzmini32/project/ftshare-document/src/main.rs, lines 1-80",
};

// ── tests ───────────────────────────────────────────────────────────────────

describe("opencodeAdapter.extractL0UserQuery", () => {
  it("最后一条就是 user 消息 → 直接抽取（原 58e4c55 行为不回归）", () => {
    const q = extractL0([USER_MSG]);
    expect(q).toBe("现在再检查一下我的这个项目吧，还有什么可以优化的地方");
  });

  it("表单回执垫在 user 之后 → 仍然抽取该 user 消息（本次 bug 的回归用例）", () => {
    const q = extractL0([USER_MSG, FORM_ASSISTANT, FORM_ANSWER]);
    expect(q).toBe("现在再检查一下我的这个项目吧，还有什么可以优化的地方");
  });

  it("多轮表单问答（asset_confirm → team → task）都垫在 user 后 → 抽取 user", () => {
    const form2 = {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id: "call_oc_session_init_1793008600000", type: "function" as const, function: { name: "question", arguments: "{}" } },
      ],
    };
    const answer2 = {
      role: "tool" as const,
      tool_call_id: "call_oc_session_init_1793008600000",
      content: "User has answered your questions: \"选择 Agent\"=\"dev-agent\"",
    };
    const q = extractL0([USER_MSG, FORM_ASSISTANT, FORM_ANSWER, form2, answer2]);
    expect(q).toBe("现在再检查一下我的这个项目吧，还有什么可以优化的地方");
  });

  it("真实工具循环尾部（read 结果）→ 返回空（防 #1621 写放大）", () => {
    const q = extractL0([USER_MSG, REAL_ASSISTANT, REAL_TOOL_RESULT]);
    expect(q).toBe("");
  });

  it("真实工具循环之后再出现表单回执 → 返回空（user 之后发生过真实工作，不再补写）", () => {
    const q = extractL0([
      USER_MSG,
      REAL_ASSISTANT,
      REAL_TOOL_RESULT,
      FORM_ASSISTANT,
      FORM_ANSWER,
    ]);
    expect(q).toBe("");
  });

  it("assistant 消息混合了非表单 tool_call → 不视为表单回执，返回空", () => {
    const mixed = {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id: "call_oc_session_init_x", type: "function" as const, function: { name: "question", arguments: "{}" } },
        { id: "call_real_z", type: "function" as const, function: { name: "bash", arguments: "{}" } },
      ],
    };
    const q = extractL0([USER_MSG, mixed, FORM_ANSWER]);
    expect(q).toBe("");
  });

  it("空消息列表 / 只有 assistant → 返回空", () => {
    expect(extractL0([])).toBe("");
    expect(extractL0([{ role: "assistant", content: "hi" }])).toBe("");
  });

  it("user content 为文本块数组 → 抽取文本（OpenCode 兼容形态）", () => {
    const q = extractL0([
      { role: "user", content: [{ type: "text", text: "数组形态的用户消息" }] },
    ]);
    expect(q).toBe("数组形态的用户消息");
  });

  it("尾部连续多条 tool 结果（多工具并发）→ 返回空", () => {
    const q = extractL0([
      USER_MSG,
      REAL_ASSISTANT,
      REAL_TOOL_RESULT,
      { role: "tool", tool_call_id: "call_b", content: "another result" },
      { role: "tool", tool_call_id: "call_c", content: "third result" },
    ]);
    expect(q).toBe("");
  });
});
