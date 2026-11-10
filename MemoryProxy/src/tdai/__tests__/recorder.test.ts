import { describe, expect, it } from "vitest";

import { extractLatestUserMessage } from "../recorder.js";

/**
 * 表单回答进 L0 的回归测试。
 *
 * 真实事故：dsh 弹出 `ask_user_question` 待选表单，用户没选选项、在「其它」
 * 输入框里手填了回答。答案走 role=tool 回流，`extractLatestUserMessage` 只扫
 * role=user ⇒ 那一轮 L0 记的仍是**表单之前**那句提问，用户说的话整段丢失。
 */

const FORM_CALL_ID = "call_00_tmbzdJAb3veb0IYFm87u0155";
const FORM_QUESTION = "这条「上游优先靠读上下文判定、不靠命名匹配」的原则，怎么存？";
const FORM_ANSWER =
  "不用做任何操作，因为你是接入了 TDAI 的，它会提取我们的会话内容并生成相关的记忆偏好与操作，只要绑定了相关的Agent团队资产，就可以实现跨会话甚至是跨应用的记忆机制。没其它事项了，收工。";

const formCallMessage = {
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id: FORM_CALL_ID,
      type: "function",
      function: {
        name: "ask_user_question",
        arguments: JSON.stringify({ questions: [{ id: "persist", question: FORM_QUESTION, options: [] }] }),
      },
    },
  ],
};

const formToolMessage = {
  role: "tool",
  tool_call_id: FORM_CALL_ID,
  content: JSON.stringify({ answers: [{ id: "persist", selected: [], custom: FORM_ANSWER }] }),
};

describe("extractLatestUserMessage — 待选表单回答", () => {
  it("把表单里手填的回答当作本轮用户输入（OpenAI Chat）", () => {
    const messages = [
      { role: "user", content: "撤消的原因我也跟你说下：通过查上游代码是否存在同包同能力名……" },
      { role: "assistant", content: "明白了，我把你的意思办错了两层：" },
      formCallMessage,
      formToolMessage,
    ];
    expect(extractLatestUserMessage(messages)).toEqual({
      role: "user",
      content: `问：${FORM_QUESTION}\n答：${FORM_ANSWER}`,
    });
  });

  it("用户选了选项时记录选项文本", () => {
    const messages = [
      { role: "user", content: "这两个现象用哪种方式收掉？" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_00_fix",
            type: "function",
            function: {
              name: "ask_user_question",
              arguments: JSON.stringify({ questions: [{ id: "fix", question: "这两个现象用哪种方式收掉？" }] }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_00_fix",
        content: JSON.stringify({ answers: [{ id: "fix", selected: ["A：把旧路径做成 junction（推荐）"] }] }),
      },
    ];
    expect(extractLatestUserMessage(messages)?.content).toBe(
      "问：这两个现象用哪种方式收掉？\n答：A：把旧路径做成 junction（推荐）",
    );
  });

  it("表单之后还有新提问时，以新提问为准", () => {
    const messages = [
      formCallMessage,
      formToolMessage,
      { role: "assistant", content: "好的，不做任何落盘操作。" },
      { role: "user", content: "再看一下 zstd 那边" },
    ];
    expect(extractLatestUserMessage(messages)?.content).toBe("再看一下 zstd 那边");
  });

  it("session-init 表单（proxy 伪造的选 Team/Agent）不算用户输入", () => {
    const messages = [
      { role: "user", content: "撤消的原因我也跟你说下……" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_dsh_session_init_1792290147084",
            type: "function",
            function: {
              name: "ask_user_question",
              arguments: JSON.stringify({ questions: [{ id: "asset_confirm", question: "本次对话是否要关联团队资产?" }] }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_dsh_session_init_1792290147084",
        content: JSON.stringify({ answers: [{ id: "asset_confirm", selected: ["是，关联团队资产"] }] }),
      },
    ];
    expect(extractLatestUserMessage(messages)?.content).toBe("撤消的原因我也跟你说下……");
  });

  it("只有 session-init 表单时返回 null（不写 L0）", () => {
    expect(
      extractLatestUserMessage([
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_dsh_session_init_1",
              type: "function",
              function: { name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "asset_confirm", question: "?" }] }) },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_dsh_session_init_1",
          content: JSON.stringify({ answers: [{ id: "asset_confirm", selected: ["是，关联团队资产"] }] }),
        },
      ]),
    ).toBeNull();
  });

  it("其它工具的 tool 结果不会被当成表单答案", () => {
    const messages = [
      { role: "user", content: "查一下 zstd 帧" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_00_pwsh", type: "function", function: { name: "pwsh", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call_00_pwsh",
        content: JSON.stringify({ answers: [{ id: "x", selected: ["假的"] }] }),
      },
    ];
    expect(extractLatestUserMessage(messages)?.content).toBe("查一下 zstd 帧");
  });
});

describe("extractLatestUserMessage — Anthropic 合并形态", () => {
  const assistantToolUse = {
    role: "assistant",
    content: [{ type: "tool_use", id: FORM_CALL_ID, name: "AskUserQuestion", input: { questions: [{ id: "persist", question: FORM_QUESTION }] } }],
  };

  it("tool_result 独占一条 user 消息时取表单答案", () => {
    const messages = [
      { role: "user", content: "撤消的原因我也跟你说下……" },
      assistantToolUse,
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: FORM_CALL_ID, content: JSON.stringify({ answers: [{ id: "persist", selected: [], custom: FORM_ANSWER }] }) }],
      },
    ];
    expect(extractLatestUserMessage(messages)?.content).toBe(`问：${FORM_QUESTION}\n答：${FORM_ANSWER}`);
  });

  it("tool_result 与真提问合并成一条时，真提问优先", () => {
    const messages = [
      assistantToolUse,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: FORM_CALL_ID, content: JSON.stringify({ answers: [{ id: "persist", selected: ["方案 A"] }] }) },
          { type: "text", text: "顺便把文档也改了" },
        ],
      },
    ];
    expect(extractLatestUserMessage(messages)?.content).toBe("顺便把文档也改了");
  });

  it("合并形态里只剩 harness 通知时，仍然取表单答案", () => {
    const messages = [
      assistantToolUse,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: FORM_CALL_ID, content: JSON.stringify({ answers: [{ id: "persist", selected: ["方案 A"] }] }) },
          { type: "text", text: "Time sampled while preparing turn 6, step 1: 2026-10-18T16:44:01+08:00[Asia/Shanghai]" },
        ],
      },
    ];
    expect(extractLatestUserMessage(messages)?.content).toBe(`问：${FORM_QUESTION}\n答：方案 A`);
  });
});
