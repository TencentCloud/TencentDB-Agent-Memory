import { beforeEach, describe, expect, it } from "vitest";
import {
  responsesBodyToChat,
  shouldRetryWithoutResponseFormat,
} from "../common/responses-chat-compat.js";
import { protocolStatsToPrometheus, resetProtocolStats } from "../common/protocol-stats.js";

/**
 * 第一跳（Responses → Chat）的丢参计数。
 *
 * 第二跳（Chat → Anthropic）一直有 onDropped + /metrics，而第一跳此前只统计
 * max_tokens 截断，未知 item / content part / Responses 独有顶层参数都是静默跳过。
 * 静默丢失是转换层最难排查的故障形态（请求成功、语义少了一半），所以这里把
 * "两跳都有 telemetry" 补成对称的，并用测试锁住标签口径。
 */

const drops = (): string[] =>
  protocolStatsToPrometheus()
    .split("\n")
    .filter((line) => line.startsWith('tdai_conversion_dropped_total{kind="responses_body_to_chat"'));

beforeEach(() => {
  resetProtocolStats();
});

describe("Responses → Chat：可完整映射的请求不产生丢弃", () => {
  it("文本 + 图片 + 工具调用 + 结构化输出全部有对位，丢弃计数为空", () => {
    responsesBodyToChat({
      model: "m",
      instructions: "你是助手",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "看这张图" },
            { type: "input_image", image_url: { url: "https://img.example.com/a.png" } },
          ],
        },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
      tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
      text: { format: { type: "json_object" } },
      parallel_tool_calls: false,
    });
    expect(drops()).toEqual([]);
  });
});

describe("Responses → Chat：无法映射的部分要计数，而不是静默跳过", () => {
  it("宿主侧工具 item 与条目引用：按类型计数，未知类型归 other", () => {
    responsesBodyToChat({
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
        { type: "item_reference", id: "msg_1" },
        { type: "local_shell_call", call_id: "sh1" },
        { type: "some_future_item", payload: {} },
      ],
    });
    const text = drops().join("\n");
    expect(text).toContain('param="input_item:item_reference"');
    expect(text).toContain('param="input_item:local_shell_call"');
    expect(text).toContain('param="input_item:other"');
  });

  it("文件 / 音频等 content part：按类型计数（Anthropic 侧本可承接 document，Chat 这一跳接不住）", () => {
    responsesBodyToChat({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "看看这份文件" },
            { type: "input_file", file_id: "file_1" },
            { type: "input_audio", data: "AAAA" },
          ],
        },
      ],
    });
    const text = drops().join("\n");
    expect(text).toContain('param="content_part:input_file"');
    expect(text).toContain('param="content_part:input_audio"');
    // 文本部分仍应正常映射，不受影响。
    expect(text).not.toContain('param="content_part:input_text"');
  });

  it("Responses 独有顶层参数（会话状态 / 抓取开关 / 推理配置）逐项计数", () => {
    responsesBodyToChat({
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "q" }] }],
      store: true,
      previous_response_id: "resp_1",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
    });
    const text = drops().join("\n");
    expect(text).toContain('param="param:store"');
    expect(text).toContain('param="param:previous_response_id"');
    expect(text).toContain('param="param:include"');
    expect(text).toContain('param="param:reasoning"');
  });

  it("非 function 类型工具（如内置检索）计数，不静默消失", () => {
    responsesBodyToChat({
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "q" }] }],
      tools: [{ type: "web_search" }],
    });
    expect(drops().join("\n")).toContain('param="tool:web_search"');
  });

  it("max_tokens 截断沿用既有口径（与第二跳同名）", () => {
    responsesBodyToChat(
      {
        model: "m",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "q" }] }],
        max_output_tokens: 999999,
      },
      { maxTokensCap: 4096 },
    );
    expect(drops().join("\n")).toContain('param="max_tokens_clamped"');
  });
});

/**
 * 上游拒收 `response_format` 时的重试判据。
 *
 * 实测 DeepSeek：Responses 的 text.format 转出的 json_schema 直接 400
 * （"This response_format type is unavailable now"）。这种失败会让整轮请求连同记忆注入一起
 * 失败，所以值得"去掉该字段重发一次"；但判据必须收窄，别把真正的参数错误也重试掉。
 */
describe("上游拒收 response_format 的重试判据", () => {
  it("400 + 发过 response_format + 文案点名 → 值得重试", () => {
    expect(
      shouldRetryWithoutResponseFormat(
        400,
        { response_format: { type: "json_schema" } },
        '{"error":{"message":"This response_format type is unavailable now"}}',
      ),
    ).toBe(true);
  });

  it("没发过 response_format → 不重试（与我们无关的参数错误）", () => {
    expect(
      shouldRetryWithoutResponseFormat(400, {}, "response_format invalid"),
    ).toBe(false);
  });

  it("400 但文案没点名 response_format → 不重试", () => {
    expect(
      shouldRetryWithoutResponseFormat(
        400,
        { response_format: { type: "json_object" } },
        '{"error":{"message":"messages[1].content is required"}}',
      ),
    ).toBe(false);
  });

  it("非 400（例如 200 或 500）→ 不重试", () => {
    expect(
      shouldRetryWithoutResponseFormat(200, { response_format: {} }, "response_format"),
    ).toBe(false);
    expect(
      shouldRetryWithoutResponseFormat(500, { response_format: {} }, "response_format"),
    ).toBe(false);
  });
});
