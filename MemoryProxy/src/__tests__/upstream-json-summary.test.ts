import { describe, it, expect } from "vitest";
import { summarizeUpstreamJson } from "../common/upstream-json-summary.js";

/**
 * 上游 JSON 摘要：trace 收尾只关心"回复文本 / 工具调用数 / 用量"，
 * 因此三种上游形态要归到同一口径，且 usage 一律表述为 Responses 字段。
 */
describe("上游 JSON 摘要（summarizeUpstreamJson）", () => {
  it("Responses 形态：取 output 文本与工具调用，usage 原样保留", () => {
    const summary = summarizeUpstreamJson({
      output: [
        { type: "reasoning", summary: [] },
        { type: "function_call", name: "shell", call_id: "c1" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "好的" }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 64 },
    });
    expect(summary.text).toBe("好的");
    expect(summary.toolCallCount).toBe(1);
    expect(summary.usage).toEqual({ input_tokens: 100, output_tokens: 20, cached_tokens: 64 });
  });

  it("Chat 形态：取 choices[0].message，用量换算为 Responses 字段", () => {
    const summary = summarizeUpstreamJson({
      choices: [
        {
          message: {
            role: "assistant",
            content: "收到",
            tool_calls: [{ id: "t1" }, { id: "t2" }],
          },
        },
      ],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 30,
        total_tokens: 230,
        prompt_tokens_details: { cached_tokens: 128 },
      },
    });
    expect(summary.text).toBe("收到");
    expect(summary.toolCallCount).toBe(2);
    expect(summary.usage).toEqual({
      input_tokens: 200,
      output_tokens: 30,
      total_tokens: 230,
      cached_tokens: 128,
    });
  });

  it("Chat 形态：缓存字段也认 prompt_cache_hit_tokens", () => {
    const summary = summarizeUpstreamJson({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 },
    });
    expect(summary.usage.cached_tokens).toBe(8);
  });

  it("Anthropic 形态：拼接 content 文本块，tool_use 计入工具调用", () => {
    const summary = summarizeUpstreamJson({
      content: [
        { type: "text", text: "第一段" },
        { type: "tool_use", id: "tu1", name: "Bash" },
        { type: "text", text: "第二段" },
      ],
      usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 256 },
    });
    expect(summary.text).toBe("第一段\n第二段");
    expect(summary.toolCallCount).toBe(1);
    expect(summary.usage).toEqual({
      input_tokens: 300,
      output_tokens: 40,
      total_tokens: 340,
      cached_tokens: 256,
    });
  });

  it("缺少 usage 时返回空用量，不产生伪造字段", () => {
    const summary = summarizeUpstreamJson({ choices: [{ message: { content: "x" } }] });
    expect(summary.usage).toEqual({});
  });

  it("无法识别的结构返回空摘要", () => {
    expect(summarizeUpstreamJson(null)).toEqual({ text: "", toolCallCount: 0, usage: {} });
    expect(summarizeUpstreamJson({ error: "boom" })).toEqual({
      text: "",
      toolCallCount: 0,
      usage: {},
    });
  });

  it("同时出现 output 与 choices 时按 Responses 处理（判定顺序固定）", () => {
    const summary = summarizeUpstreamJson({
      output: [{ type: "message", content: [{ type: "output_text", text: "来自 output" }] }],
      choices: [{ message: { content: "来自 choices" } }],
    });
    expect(summary.text).toBe("来自 output");
  });
});
