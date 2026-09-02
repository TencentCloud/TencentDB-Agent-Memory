import { describe, expect, it } from "vitest";
import {
  responsesToAnthropic,
  anthropicToResponses,
  anthropicJsonToResponsesJson,
  responsesJsonToAnthropicJson,
  createAnthropicSseToResponsesSse,
  createResponsesSseToAnthropicSse,
} from "../common/responses-anthropic-compat.js";
import { getProtocolStats, resetProtocolStats } from "../common/protocol-stats.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function runTransform(
  transform: TransformStream<Uint8Array, Uint8Array>,
  input: string,
): Promise<string> {
  const writer = transform.writable.getWriter();
  const writePromise = writer.write(encoder.encode(input)).catch(() => {});
  const closePromise = writer.close().catch(() => {});
  const reader = transform.readable.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  await Promise.all([writePromise, closePromise]);
  return out;
}

function frames(sse: string): Array<{ event: string; data: Record<string, unknown> }> {
  return sse
    .split("\n\n")
    .filter((f) => f.trim().length > 0)
    .map((frame) => {
      const evtLine = frame.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .join("\n")
        .replace(/^data: /, "");
      return {
        event: evtLine ? evtLine.slice(7).trim() : "message",
        data: JSON.parse(dataLine) as Record<string, unknown>,
      };
    });
}

// ── 请求体：Responses → Anthropic ──────────────────────────────────────────

describe("responsesToAnthropic（Responses 请求 → Anthropic 请求）", () => {
  it("文本 + system + tools", () => {
    const out = responsesToAnthropic(
      {
        model: "<上游模型名>",
        instructions: "你是测试助手",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "你好" }],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "查天气",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        tool_choice: { type: "function", name: "get_weather" },
        max_output_tokens: 2048,
      },
      { model: "<上游模型名>" },
    );
    expect(out.model).toBe("<上游模型名>");
    expect(out.system).toBe("你是测试助手");
    expect(out.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(out.max_tokens).toBe(2048);
    expect(out.tools).toEqual([
      {
        name: "get_weather",
        description: "查天气",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("function_call + function_call_output 保留配对", () => {
    const out = responsesToAnthropic(
      {
        model: "<上游模型名>",
        input: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "我来查" }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"北京"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "晴",
          },
        ],
      },
      { model: "<上游模型名>" },
    );
    const msgs = out.messages as Array<Record<string, unknown>>;
    // Anthropic 的 assistant 带 tool_use 时 content 是 blocks 数组
    expect(msgs[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "我来查" },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "北京" } },
      ],
    });
    expect(msgs[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "晴" }],
    });
  });
});

// ── 请求体：Anthropic → Responses ──────────────────────────────────────────

describe("anthropicToResponses（Anthropic 请求 → Responses 请求）", () => {
  it("system → instructions，messages → input，tools 换格式", () => {
    const out = anthropicToResponses(
      {
        model: "<上游模型名>",
        system: "你是测试助手",
        max_tokens: 2048,
        messages: [
          { role: "user", content: "你好" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "我来查" },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "北京" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "晴" }],
          },
        ],
        tools: [
          {
            name: "get_weather",
            description: "查天气",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
      { model: "<上游模型名>" },
    );
    expect(out.instructions).toBe("你是测试助手");
    expect(out.max_output_tokens).toBe(2048);
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "你好" }],
    });
    expect(input[1]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "我来查" }],
    });
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "toolu_1",
      name: "get_weather",
      arguments: '{"city":"北京"}',
    });
    expect(input[3]).toEqual({
      type: "function_call_output",
      call_id: "toolu_1",
      output: "晴",
    });
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "查天气",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });
});

// ── 非流式 JSON ────────────────────────────────────────────────────────────

describe("非流式 JSON 双向转换", () => {
  it("anthropicJsonToResponsesJson", () => {
    const out = anthropicJsonToResponsesJson(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "<上游模型名>",
        content: [{ type: "text", text: "你好" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4603 },
      },
      { model: "<上游模型名>" },
    );
    expect(out.object).toBe("response");
    expect(out.output).toHaveLength(1);
    expect((out.output as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "你好", annotations: [] }],
    });
    expect(out.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cached_tokens: 4603,
    });
  });

  it("responsesJsonToAnthropicJson（含 function_call）", () => {
    const out = responsesJsonToAnthropicJson(
      {
        id: "resp_1",
        object: "response",
        created_at: 123,
        status: "completed",
        model: "<上游模型名>",
        output: [
          {
            id: "msg_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "我来查", annotations: [] }],
          },
          {
            id: "call_1",
            type: "function_call",
            status: "completed",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"北京"}',
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cached_tokens: 4603,
        },
      },
      { model: "<上游模型名>" },
    );
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content).toEqual([
      { type: "text", text: "我来查" },
      {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "北京" },
      },
    ]);
    expect(out.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 4603,
    });
  });
});

// ── 流式 SSE ───────────────────────────────────────────────────────────────

describe("createAnthropicSseToResponsesSse（上游 Anthropic SSE → 客户端 Responses SSE）", () => {
  it("文本流 + usage 落进 response.completed", async () => {
    const input =
      "event: message_start\n" +
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"<上游模型名>","content":[],"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":4603}}}\n\n' +
      "event: content_block_start\n" +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      "event: content_block_delta\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
      "event: content_block_stop\n" +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      "event: message_delta\n" +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n' +
      "event: message_stop\n" +
      'data: {"type":"message_stop"}\n\n';
    const out = await runTransform(createAnthropicSseToResponsesSse({ model: "<上游模型名>" }), input);
    const evts = frames(out);
    const types = evts.map((e) => e.event);
    expect(types).toContain("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.completed");

    const delta = evts.find((e) => e.event === "response.output_text.delta");
    expect(delta?.data.delta).toBe("你好");
    const completed = evts.find((e) => e.event === "response.completed");
    const resp = completed?.data.response as Record<string, unknown>;
    expect(resp.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cached_tokens: 4603,
    });
    expect(resp.status).toBe("completed");
  });

  it("tool_use 转成 function_call 输出项", async () => {
    const input =
      "event: message_start\n" +
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"<上游模型名>","content":[],"usage":{}}}\n\n' +
      "event: content_block_start\n" +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n' +
      "event: content_block_delta\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"北京\\"}"}}\n\n' +
      "event: content_block_stop\n" +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      "event: message_delta\n" +
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n' +
      "event: message_stop\n" +
      'data: {"type":"message_stop"}\n\n';
    const out = await runTransform(createAnthropicSseToResponsesSse({ model: "<上游模型名>" }), input);
    const evts = frames(out);
    const done = evts.find((e) => e.event === "response.output_item.done");
    const item = done?.data.item as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(item.call_id).toBe("toolu_1");
    expect(item.name).toBe("get_weather");
    expect(item.arguments).toBe('{"city":"北京"}');
  });
});

describe("createResponsesSseToAnthropicSse（上游 Responses SSE → 客户端 Anthropic SSE）", () => {
  it("文本流 + usage 落进 message_delta", async () => {
    const input =
      "event: response.created\n" +
      'data: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":123,"status":"in_progress","model":"<上游模型名>","output":[]}}\n\n' +
      "event: response.output_item.added\n" +
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n' +
      "event: response.content_part.added\n" +
      'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n' +
      "event: response.output_text.delta\n" +
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"你好"}\n\n' +
      "event: response.output_text.done\n" +
      'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":"你好"}\n\n' +
      "event: response.content_part.done\n" +
      'data: {"type":"response.content_part.done","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"你好","annotations":[]}}\n\n' +
      "event: response.output_item.done\n" +
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"你好","annotations":[]}]}}\n\n' +
      "event: response.completed\n" +
      'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":123,"status":"completed","model":"<上游模型名>","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cached_tokens":4603}}}\n\n';
    const out = await runTransform(createResponsesSseToAnthropicSse({ model: "<上游模型名>" }), input);
    const evts = frames(out);
    const types = evts.map((e) => e.event);
    expect(types).toContain("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");

    const delta = evts.find((e) => e.event === "content_block_delta");
    expect((delta?.data.delta as Record<string, unknown>).text).toBe("你好");
    const messageDelta = evts.find((e) => e.event === "message_delta");
    expect(messageDelta?.data.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 4603,
    });
    expect((messageDelta?.data.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
  });

  it("function_call 转成 tool_use 流", async () => {
    const input =
      "event: response.created\n" +
      'data: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":123,"status":"in_progress","model":"<上游模型名>","output":[]}}\n\n' +
      "event: response.output_item.added\n" +
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"get_weather","arguments":""}}\n\n' +
      "event: response.function_call_arguments.delta\n" +
      'data: {"type":"response.function_call_arguments.delta","item_id":"call_1","output_index":0,"delta":"{\\"city\\":\\"北京\\"}"}\n\n' +
      "event: response.function_call_arguments.done\n" +
      'data: {"type":"response.function_call_arguments.done","item_id":"call_1","output_index":0,"arguments":"{\\"city\\":\\"北京\\"}"}\n\n' +
      "event: response.output_item.done\n" +
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"call_1","type":"function_call","status":"completed","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"北京\\"}"}}\n\n' +
      "event: response.completed\n" +
      'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":123,"status":"completed","model":"<上游模型名>","output":[],"usage":{}}}\n\n';
    const out = await runTransform(createResponsesSseToAnthropicSse({ model: "<上游模型名>" }), input);
    const evts = frames(out);
    const start = evts.find((e) => e.event === "content_block_start");
    expect((start?.data.content_block as Record<string, unknown>).type).toBe("tool_use");
    expect((start?.data.content_block as Record<string, unknown>).name).toBe("get_weather");
    const delta = evts.find((e) => e.event === "content_block_delta");
    expect((delta?.data.delta as Record<string, unknown>).type).toBe("input_json_delta");
    const messageDelta = evts.find((e) => e.event === "message_delta");
    expect((messageDelta?.data.delta as Record<string, unknown>).stop_reason).toBe("tool_use");
  });

  it("兼容 DashScope 紧凑帧格式（event:/data: 后无空格）", async () => {
    const input =
      "event:response.created\n" +
      'data:{"type":"response.created","response":{"id":"resp_1","object":"response","created_at":123,"status":"in_progress","model":"qwen-flash","output":[]}}\n\n' +
      "event:response.output_item.added\n" +
      'data:{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n' +
      "event:response.output_text.delta\n" +
      'data:{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}\n\n' +
      "event:response.completed\n" +
      'data:{"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":123,"status":"completed","model":"qwen-flash","output":[],"usage":{"input_tokens":45,"output_tokens":11,"total_tokens":56,"input_tokens_details":{"cached_tokens":0}}}}\n\n';
    const out = await runTransform(createResponsesSseToAnthropicSse({ model: "qwen-flash" }), input);
    const evts = frames(out);
    const delta = evts.find((e) => e.event === "content_block_delta");
    expect((delta?.data.delta as Record<string, unknown>).text).toBe("hi");
    const messageDelta = evts.find((e) => e.event === "message_delta");
    expect(messageDelta?.data.usage).toMatchObject({
      input_tokens: 45,
      output_tokens: 11,
    });
    expect((messageDelta?.data.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
  });
});
describe("组合层 JSON 响应 usage 只计一次", () => {
  it("anthropic → responses 两跳：cache.requests=1 且字段正确", () => {
    resetProtocolStats();
    anthropicJsonToResponsesJson({
      id: "m",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "a" }],
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 30 },
    });
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cacheHitRequests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(30);
    expect(snap.cache.inputTokens).toBe(100);
  });

  it("responses → anthropic 两跳：cache.requests=1 且字段正确", () => {
    resetProtocolStats();
    responsesJsonToAnthropicJson({
      id: "r",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "m",
      output: [
        {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "a", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        total_tokens: 280,
        input_tokens_details: { cached_tokens: 60 },
      },
    });
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cacheHitRequests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(60);
    expect(snap.cache.inputTokens).toBe(200);
  });
});
