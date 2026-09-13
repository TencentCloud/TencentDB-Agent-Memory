import { describe, it, expect } from "vitest";
import { stripCodexFormArtifacts } from "../session/codex/form.js";
import { stripSessionInitFormArtifacts } from "../session/claude-code/cleaner.js";

describe("session-init 假表单转发前剥离（每轮幂等）", () => {
  it("stripCodexFormArtifacts：摘掉 request_user_input 调用/结果与工具声明，保留真实内容", () => {
    const body = {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
        {
          type: "function_call",
          id: "fc_codex_session_init_1",
          call_id: "call_codex_session_init_1",
          name: "request_user_input",
          arguments: '{"questions":[{"prompt":"选团队"}]}',
        },
        {
          type: "function_call_output",
          call_id: "call_codex_session_init_1",
          output: "team-1",
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "继续任务" }] },
      ],
      tools: [
        { type: "function", name: "request_user_input" },
        { type: "function", name: "get_weather" },
      ],
    };

    const out = stripCodexFormArtifacts(body);
    const input = out.input as Array<Record<string, unknown>>;
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(input.some((i) => i.type === "function_call")).toBe(false);
    expect(input.some((i) => i.type === "function_call_output")).toBe(false);
    expect(input).toHaveLength(2);
    expect(tools.some((t) => t.name === "request_user_input")).toBe(false);
    expect(tools.some((t) => t.name === "get_weather")).toBe(true);
    // 二次调用幂等：无表单时返回同一引用
    expect(stripCodexFormArtifacts(out)).toBe(out);
  });

  it("stripCodexFormArtifacts：无表单 body 原样返回（不产生新对象）", () => {
    const body = {
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "get_weather" }],
    };
    expect(stripCodexFormArtifacts(body)).toBe(body);
  });

  it("stripSessionInitFormArtifacts：摘掉 AskUserQuestion 的 tool_use/tool_result，保留真实消息", () => {
    const messages = [
      { role: "assistant", content: "开始" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_cc_session_init_1",
            name: "AskUserQuestion",
            input: { questions: [{ prompt: "选团队" }] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_cc_session_init_1",
            content: "team-1",
          },
        ],
      },
      { role: "user", content: "继续" },
    ];

    const out = stripSessionInitFormArtifacts(messages);
    const json = JSON.stringify(out);
    expect(json).not.toContain("toolu_cc_session_init_1");
    expect(json).not.toContain("AskUserQuestion");
    expect(json).toContain("开始");
    expect(json).toContain("继续");
    // 幂等
    expect(stripSessionInitFormArtifacts(out)).toBe(out);
  });

  it("stripSessionInitFormArtifacts：无表单消息原样返回", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(stripSessionInitFormArtifacts(messages)).toBe(messages);
  });
});
