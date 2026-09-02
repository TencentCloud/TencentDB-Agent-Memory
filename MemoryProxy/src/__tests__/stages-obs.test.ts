/**
 * 观测阶段用例：buildObsInput（4 形状）/ flatten×2 / usage 提取。
 * 行为与 4 个 handler 原实现对齐。
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildObsInput,
  flattenMessagesForOpik,
  flattenAnthropicMessagesForOpik,
  stringifyAnthropicSystem,
  extractUsageFromSseText,
  extractResponsesUsage,
} from "../stages/obs.js";

describe("buildObsInput responses 形状", () => {
  it("codex：input 恒包对象，instructions 可选", () => {
    expect(
      buildObsInput({ protocol: "responses", agentSource: "codex", body: { input: ["x"] } }),
    ).toEqual({ input: ["x"] });
    expect(
      buildObsInput({
        protocol: "responses",
        agentSource: "codex",
        body: { input: ["x"], instructions: "sys" },
      }),
    ).toEqual({ input: ["x"], instructions: "sys" });
  });

  it("workbuddy：组合策略（都有 → 对象；仅 input → 直接返回；仅 instructions → 对象）", () => {
    expect(
      buildObsInput({
        protocol: "responses",
        agentSource: "workbuddy",
        body: { input: ["x"], instructions: "sys" },
      }),
    ).toEqual({ input: ["x"], instructions: "sys" });
    expect(
      buildObsInput({ protocol: "responses", agentSource: "workbuddy", body: { input: ["x"] } }),
    ).toEqual(["x"]);
    expect(
      buildObsInput({
        protocol: "responses",
        agentSource: "workbuddy",
        body: { instructions: "sys" },
      }),
    ).toEqual({ instructions: "sys" });
    expect(buildObsInput({ protocol: "responses", agentSource: "workbuddy", body: {} })).toBeUndefined();
  });
});

describe("buildObsInput anthropic 形状", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

  it("debug=false → flattenAnthropicMessagesForOpik（system 前置）", () => {
    const out = buildObsInput({
      protocol: "anthropic",
      messages,
      system: "sys-text",
      debug: false,
    }) as unknown[];
    expect(out[0]).toEqual({ role: "system", content: "sys-text" });
    expect(out[1]).toEqual({ role: "user", content: "hi" });
  });

  it("debug=true → 原生结构 + 前置 system", () => {
    const out = buildObsInput({
      protocol: "anthropic",
      messages,
      system: "sys-text",
      debug: true,
    }) as unknown[];
    expect(out[0]).toEqual({ role: "system", content: "sys-text" });
    expect(out[1]).toEqual(messages[0]);
  });
});

describe("buildObsInput openai 形状", () => {
  it("debug=false → 走 flatten fallback", () => {
    const flatten = vi.fn((m: unknown[]) => ["flattened"]);
    const out = buildObsInput({
      protocol: "openai",
      messages: [{ role: "user", content: "hi" }],
      debug: false,
      flatten,
    });
    expect(flatten).toHaveBeenCalledTimes(1);
    expect(out).toEqual(["flattened"]);
  });

  it("debug=true → 原样返回 messages", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(
      buildObsInput({ protocol: "openai", messages, debug: true }),
    ).toEqual(messages);
  });

  it("缺省 flatten 用 flattenMessagesForOpik", () => {
    const out = buildObsInput({
      protocol: "openai",
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      ],
      debug: false,
    }) as unknown[];
    expect(out).toEqual([{ role: "user", content: "a\nb" }]);
  });
});

describe("flattenMessagesForOpik", () => {
  it("字符串 content 原样透传", () => {
    const msg = { role: "user", content: "hi" };
    expect(flattenMessagesForOpik([msg])).toEqual([msg]);
  });

  it("assistant blocks：text/tool_use/thinking + 顶层 tool_calls 展开", () => {
    const out = flattenMessagesForOpik([
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "think..." },
        ],
        tool_calls: [
          { id: "c1", function: { name: "fn1", arguments: '{"a":1}' } },
        ],
      },
    ]) as unknown[];
    expect(out[0]).toEqual({ role: "assistant", content: "hello\n[thinking] think..." });
    expect(String((out[1] as Record<string, unknown>).content)).toContain('"tool_name": "fn1"');
  });

  it("user tool_result → role=tool 条目", () => {
    const out = flattenMessagesForOpik([
      {
        role: "user",
        content: [
          { type: "text", text: "question" },
          { type: "tool_result", tool_use_id: "c1", content: "result" },
        ],
      },
    ]) as unknown[];
    expect(out[0]).toEqual({ role: "user", content: "question" });
    expect(out[1]).toMatchObject({ role: "tool" });
    expect(String((out[1] as Record<string, unknown>).content)).toContain('"tool_call_id": "c1"');
  });
});

describe("flattenAnthropicMessagesForOpik", () => {
  it("system 前置 + assistant tool_use 展开", () => {
    const out = flattenAnthropicMessagesForOpik(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "t1", name: "fn", input: { a: 1 } },
          ],
        },
      ],
      [{ type: "text", text: "sys" }],
    ) as unknown[];
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "assistant", content: "hi" });
    expect(String((out[2] as Record<string, unknown>).content)).toContain('"tool_name": "fn"');
  });
});

describe("stringifyAnthropicSystem", () => {
  it("string / blocks / undefined", () => {
    expect(stringifyAnthropicSystem("s")).toBe("s");
    expect(
      stringifyAnthropicSystem([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(stringifyAnthropicSystem(undefined)).toBe("");
    expect(stringifyAnthropicSystem(null)).toBe("");
  });
});

describe("extractUsageFromSseText", () => {
  it("合并 evt.usage 与 evt.response.usage", () => {
    const sse = [
      'data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":2}}',
      'data: {"type":"response.completed","response":{"usage":{"total_tokens":9}}}',
    ].join("\n\n");
    expect(extractUsageFromSseText(sse)).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 9,
    });
  });

  it("无 usage 帧 → null", () => {
    expect(extractUsageFromSseText('data: {"type":"ping"}')).toBeNull();
    expect(extractUsageFromSseText("plain text")).toBeNull();
    expect(extractUsageFromSseText("")).toBeNull();
  });
});

describe("extractResponsesUsage", () => {
  it("evt.response.usage 优先；evt.usage 兜底；缺失 → null", () => {
    expect(
      extractResponsesUsage({
        type: "response.completed",
        response: { usage: { total_tokens: 9 } },
      }),
    ).toEqual({ total_tokens: 9 });
    expect(extractResponsesUsage({ type: "x", usage: { total_tokens: 1 } })).toEqual({
      total_tokens: 1,
    });
    expect(extractResponsesUsage({ type: "ping" })).toBeNull();
  });
});
