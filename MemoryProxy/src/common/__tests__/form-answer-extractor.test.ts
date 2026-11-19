import { describe, expect, it } from "vitest";

import {
  collectToolCalls,
  formAnswerFromToolMessage,
  formAnswerFromToolResultBlocks,
  isSessionInitToolCallId,
  parseFormAnswers,
} from "../form-answer-extractor.js";

/**
 * 载荷全部取自 dsh 0.2.1-rc.2 真实会话（`session.v4.jsonl.zstd` 的
 * `tool/call` + `tool/result` 事件，逐字一致），不是手搓的样例。
 */

const FORM_CALL_ID = "call_00_tmbzdJAb3veb0IYFm87u0155";
const FORM_QUESTION = "这条「上游优先靠读上下文判定、不靠命名匹配」的原则，怎么存？";
const FORM_ARGS = JSON.stringify({
  questions: [
    {
      header: "落点",
      id: "persist",
      options: [
        { description: "跨会话生效，以后任何 dsh 会话拉上游时都按这个判据；需要改你的全局指令文件。", label: "写进 ~/.dsh/AGENTS.md（用户级全局指令）" },
        { description: "不写文件，靠每次对话提醒；跨会话不会自动生效。", label: "不用落盘，我在本次会话内记住" },
      ],
      question: FORM_QUESTION,
    },
  ],
});

const FORM_RESULT = JSON.stringify({
  answers: [
    {
      id: "persist",
      selected: [],
      custom:
        "不用做任何操作，因为你是接入了 TDAI 的，它会提取我们的会话内容并生成相关的记忆偏好与操作，只要绑定了相关的Agent团队资产，就可以实现跨会话甚至是跨应用的记忆机制。没其它事项了，收工。",
    },
  ],
});

const SESSION_INIT_CALL_ID = "call_dsh_session_init_1792290147084";
const SESSION_INIT_ARGS = JSON.stringify({
  questions: [
    {
      id: "asset_confirm",
      question: "本次对话是否要关联团队资产?",
      header: "关联资产",
      options: [
        { label: "是，关联团队资产", description: "" },
        { label: "否，本次不关联", description: "" },
      ],
      multi_select: false,
    },
  ],
});
const SESSION_INIT_RESULT = JSON.stringify({ answers: [{ id: "asset_confirm", selected: ["是，关联团队资产"] }] });

function toolCallMessage(id: string, name: string, args: string) {
  return { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: args } }] };
}

describe("parseFormAnswers", () => {
  it("parses the dsh answer envelope", () => {
    expect(parseFormAnswers(FORM_RESULT)).toEqual([
      {
        id: "persist",
        selected: [],
        custom:
          "不用做任何操作，因为你是接入了 TDAI 的，它会提取我们的会话内容并生成相关的记忆偏好与操作，只要绑定了相关的Agent团队资产，就可以实现跨会话甚至是跨应用的记忆机制。没其它事项了，收工。",
      },
    ]);
  });

  it("parses selected labels and keeps them in order", () => {
    const raw = JSON.stringify({
      answers: [
        { id: "order", selected: ["先搬家，再对齐上游，最后升级客户端（推荐）"] },
        { id: "shim", selected: ["只停 voice-input 垫片，tavily 保留（推荐）"] },
      ],
    });
    expect(parseFormAnswers(raw)).toEqual([
      { id: "order", selected: ["先搬家，再对齐上游，最后升级客户端（推荐）"] },
      { id: "shim", selected: ["只停 voice-input 垫片，tavily 保留（推荐）"] },
    ]);
  });

  it("accepts content given as text blocks", () => {
    expect(parseFormAnswers([{ type: "text", text: FORM_RESULT }])).toHaveLength(1);
  });

  it("rejects unrelated tool output", () => {
    expect(parseFormAnswers("ok")).toBeNull();
    expect(parseFormAnswers('{"total":3}')).toBeNull();
    expect(parseFormAnswers('{"answers":[]}')).toBeNull();
    expect(parseFormAnswers('{"answers":[{"selected":["x"]}]}')).toBeNull(); // 缺 id
    expect(parseFormAnswers('{"answers":[{"id":"q","selected":[],"custom":"   "}]}')).toBeNull(); // 空答案
    expect(parseFormAnswers("")).toBeNull();
  });
});

describe("isSessionInitToolCallId", () => {
  it("matches every client's session-init prefix", () => {
    expect(isSessionInitToolCallId("call_dsh_session_init_1792290147084")).toBe(true);
    expect(isSessionInitToolCallId("call_session_init_1")).toBe(true);
    expect(isSessionInitToolCallId("call_wb_session_init_1")).toBe(true);
    expect(isSessionInitToolCallId("call_oc_session_init_1")).toBe(true);
    expect(isSessionInitToolCallId("toolu_cc_session_init_1")).toBe(true);
    expect(isSessionInitToolCallId(FORM_CALL_ID)).toBe(false);
  });
});

describe("formAnswerFromToolMessage (OpenAI Chat)", () => {
  it("renders question + custom answer", () => {
    const toolCalls = collectToolCalls([toolCallMessage(FORM_CALL_ID, "ask_user_question", FORM_ARGS)]);
    const msg = { role: "tool", tool_call_id: FORM_CALL_ID, content: FORM_RESULT };
    expect(formAnswerFromToolMessage(msg, toolCalls)).toBe(
      `问：${FORM_QUESTION}\n答：不用做任何操作，因为你是接入了 TDAI 的，它会提取我们的会话内容并生成相关的记忆偏好与操作，只要绑定了相关的Agent团队资产，就可以实现跨会话甚至是跨应用的记忆机制。没其它事项了，收工。`,
    );
  });

  it("renders selected option labels", () => {
    const id = "call_00_selected";
    const args = JSON.stringify({ questions: [{ id: "fix", question: "这两个现象用哪种方式收掉？" }] });
    const toolCalls = collectToolCalls([toolCallMessage(id, "ask_user_question", args)]);
    const msg = {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({ answers: [{ id: "fix", selected: ["A：把旧路径做成 junction（推荐）"] }] }),
    };
    expect(formAnswerFromToolMessage(msg, toolCalls)).toBe("问：这两个现象用哪种方式收掉？\n答：A：把旧路径做成 junction（推荐）");
  });

  it("merges selected labels with a custom note", () => {
    const id = "call_00_both";
    const toolCalls = collectToolCalls([toolCallMessage(id, "ask_user_question", JSON.stringify({ questions: [{ id: "q", question: "怎么做？" }] }))]);
    const msg = {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({ answers: [{ id: "q", selected: ["方案 A"], custom: "顺便把文档也改了" }] }),
    };
    expect(formAnswerFromToolMessage(msg, toolCalls)).toBe("问：怎么做？\n答：方案 A；顺便把文档也改了");
  });

  it("falls back to the answer alone when the question text is gone", () => {
    // 历史被压缩掉，只剩 tool 结果
    const msg = { role: "tool", name: "ask_user_question", tool_call_id: "call_00_lost", content: FORM_RESULT };
    expect(formAnswerFromToolMessage(msg, new Map())).toBe(
      "答：不用做任何操作，因为你是接入了 TDAI 的，它会提取我们的会话内容并生成相关的记忆偏好与操作，只要绑定了相关的Agent团队资产，就可以实现跨会话甚至是跨应用的记忆机制。没其它事项了，收工。",
    );
  });

  it("ignores session-init answers", () => {
    const toolCalls = collectToolCalls([toolCallMessage(SESSION_INIT_CALL_ID, "ask_user_question", SESSION_INIT_ARGS)]);
    const msg = { role: "tool", tool_call_id: SESSION_INIT_CALL_ID, content: SESSION_INIT_RESULT };
    expect(formAnswerFromToolMessage(msg, toolCalls)).toBeNull();
  });

  it("ignores tool results of other tools", () => {
    const id = "call_00_read_1";
    const toolCalls = collectToolCalls([toolCallMessage(id, "read", "{}")]);
    const msg = { role: "tool", tool_call_id: id, content: FORM_RESULT };
    expect(formAnswerFromToolMessage(msg, toolCalls)).toBeNull();
  });
});

describe("formAnswerFromToolResultBlocks (Anthropic)", () => {
  it("reads the answer out of a user-role tool_result block", () => {
    const toolCalls = collectToolCalls([
      { role: "assistant", content: [{ type: "tool_use", id: FORM_CALL_ID, name: "AskUserQuestion", input: JSON.parse(FORM_ARGS) }] },
    ]);
    const content = [{ type: "tool_result", tool_use_id: FORM_CALL_ID, content: FORM_RESULT }];
    expect(formAnswerFromToolResultBlocks(content, toolCalls)).toBe(`问：${FORM_QUESTION}\n答：不用做任何操作，因为你是接入了 TDAI 的，它会提取我们的会话内容并生成相关的记忆偏好与操作，只要绑定了相关的Agent团队资产，就可以实现跨会话甚至是跨应用的记忆机制。没其它事项了，收工。`);
  });

  it("ignores session-init and non-form tool results", () => {
    const content = [
      { type: "tool_result", tool_use_id: SESSION_INIT_CALL_ID, content: SESSION_INIT_RESULT },
      { type: "tool_result", tool_use_id: "toolu_read_1", content: "file contents" },
    ];
    expect(formAnswerFromToolResultBlocks(content, new Map())).toBeNull();
  });

  it("falls back to shape when the tool_use is no longer in history", () => {
    const content = [{ type: "tool_result", tool_use_id: "toolu_lost", content: FORM_RESULT }];
    expect(formAnswerFromToolResultBlocks(content, new Map())).toContain("答：不用做任何操作");
  });
});
