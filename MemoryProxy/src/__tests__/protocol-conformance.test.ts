/**
 * 协议转换工程级补全：thinking/reasoning、tool_choice、参数映射、流式与 round-trip。
 * 覆盖 chat-anthropic-compat 与 responses-chat-compat 的增量行为。
 */
import { describe, it, expect } from "vitest";
import { getProtocolStats, resetProtocolStats, protocolStatsToPrometheus } from "../common/protocol-stats.js";
import {
  anthropicToChat,
  chatToAnthropic,
  anthropicJsonToChatJson,
  chatJsonToAnthropicJson,
  createAnthropicSseToChatSse,
  createChatSseToAnthropicSse,
} from "../common/chat-anthropic-compat.js";
import {
  responsesJsonToChatJson,
  chatJsonToResponses,
  responsesBodyToChat,
  createResponsesSseToChatSse,
  createChatSseToResponses,
} from "../common/responses-chat-compat.js";

async function runTransform(
  ts: TransformStream<Uint8Array, Uint8Array>,
  chunks: string[],
): Promise<string> {
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const out: string[] = [];
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(new TextDecoder().decode(value));
    }
  })();
  for (const c of chunks) await writer.write(new TextEncoder().encode(c));
  await writer.close();
  await readPromise;
  return out.join("");
}

describe("thinking ↔ reasoning_content（非流式）", () => {
  it("Anthropic thinking 块 → chat assistant reasoning_content", () => {
    const chat = anthropicJsonToChatJson({
      id: "m1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [
        { type: "thinking", thinking: "先分析再动手", signature: "sig-1" },
        { type: "text", text: "结论" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const msg = (
      (chat.choices as Array<Record<string, unknown>>)[0] as { message: Record<string, unknown> }
    ).message;
    expect(msg.reasoning_content).toBe("先分析再动手");
    expect(msg.content).toBe("结论");
  });

  it("chat reasoning_content → Anthropic thinking 块（map）", () => {
    const anth = chatJsonToAnthropicJson(
      {
        choices: [{ message: { role: "assistant", content: "结论", reasoning_content: "推理" } }],
      },
      { thinking: "map" },
    );
    const content = anth.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "thinking", thinking: "推理" });
    expect(content[1]).toEqual({ type: "text", text: "结论" });
  });

  it("chat reasoning_content 默认 strip（避免无 signature 的 thinking 破坏严格上游）", () => {
    const anth = chatJsonToAnthropicJson({
      choices: [{ message: { role: "assistant", content: "结论", reasoning_content: "推理" } }],
    });
    const content = anth.content as Array<Record<string, unknown>>;
    expect(content.some((b) => b.type === "thinking")).toBe(false);
  });

  it("round-trip：Anthropic JSON → Chat JSON → Anthropic JSON（map）语义保持", () => {
    const original = {
      id: "m1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [
        { type: "thinking", thinking: "推理A\n推理B" },
        { type: "text", text: "正文" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: { city: "上海" },
        },
      ],
      stop_reason: "tool_use",
    };
    const viaChat = chatJsonToAnthropicJson(anthropicJsonToChatJson(original), {
      thinking: "map",
    });
    const content = viaChat.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "thinking", thinking: "推理A\n推理B" });
    expect(content[1]).toEqual({ type: "text", text: "正文" });
    expect(content[2]).toMatchObject({ type: "tool_use", name: "get_weather" });
    expect(viaChat.stop_reason).toBe("tool_use");
  });
});

describe("tool_choice 双向映射", () => {
  it("Anthropic any → chat required；tool:{name} → function:{name}", () => {
    expect(anthropicToChat({ model: "m", messages: [], tool_choice: "any" }).tool_choice).toBe("required");
    expect(
      anthropicToChat({ model: "m", messages: [], tool_choice: { type: "tool", name: "f" } }).tool_choice,
    ).toEqual({ type: "function", function: { name: "f" } });
    expect(anthropicToChat({ model: "m", messages: [], tool_choice: "auto" }).tool_choice).toBe("auto");
  });

  it("chat required → Anthropic any；function:{name} → tool:{name}；none → 省略", () => {
    expect(chatToAnthropic({ model: "m", messages: [], tool_choice: "required" }).tool_choice).toBe("any");
    expect(
      chatToAnthropic({ model: "m", messages: [], tool_choice: { type: "function", function: { name: "f" } } }).tool_choice,
    ).toEqual({ type: "tool", name: "f" });
    expect(chatToAnthropic({ model: "m", messages: [], tool_choice: "none" }).tool_choice).toBeUndefined();
  });
});

describe("请求参数映射", () => {
  it("chat max_completion_tokens 作为 max_tokens 兜底来源", () => {
    const out = chatToAnthropic({ model: "m", messages: [], max_completion_tokens: 2048 });
    expect(out.max_tokens).toBe(2048);
  });

  it("Anthropic 请求 cache_control 块剥离，不泄漏到 chat 请求", () => {
    const out = anthropicToChat({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });
    const userMsg = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "user");
    const content = JSON.stringify(userMsg?.content);
    expect(content).not.toContain("cache_control");
    expect(content).toContain("hi");
  });
});

describe("流式 thinking_delta ↔ reasoning_content", () => {
  it("Anthropic thinking_delta → chat delta.reasoning_content", async () => {
    const ts = createAnthropicSseToChatSse({ model: "m" });
    const out = await runTransform(ts, [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"我在想"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(out).toContain('"reasoning_content":"我在想"');
    expect(out).toContain("data: [DONE]");
  });

  it("chat delta.reasoning_content → Anthropic thinking 块流", async () => {
    const ts = createChatSseToAnthropicSse({ model: "m", thinking: "map" });
    const out = await runTransform(ts, [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"推理中"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"正文"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(out).toContain('"type":"thinking"');
    expect(out).toContain('"thinking":"推理中"');
    expect(out).toContain('"type":"text_delta","text":"正文"');
    // 收尾：message_stop 必须出现，且 thinking/text 块都已 stop
    expect(out).toContain('"type":"message_stop"');
    const stops = (out.match(/"type":"content_block_stop"/g) ?? []).length;
    expect(stops).toBe(2);
  });

  it("chat delta.reasoning_content 默认 strip（与矩阵口径一致，不产生无 signature 的 thinking）", async () => {
    const ts = createChatSseToAnthropicSse({ model: "m" });
    const out = await runTransform(ts, [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"推理中"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"正文"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(out).not.toContain('"type":"thinking"');
    expect(out).not.toContain('"thinking":"推理中"');
    expect(out).toContain('"type":"text_delta","text":"正文"');
    expect(out).toContain('"type":"message_stop"');
  });
});

describe("Responses ↔ Chat reasoning 透传", () => {
  it("Responses output reasoning item → chat reasoning_content", () => {
    const chat = responsesJsonToChatJson(
      {
        id: "r1",
        output: [
          { id: "rs1", type: "reasoning", summary: "推理摘要", status: "completed" },
          {
            id: "m1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "正文", annotations: [] }],
          },
        ],
      },
      { model: "m" },
    );
    const msg = (
      (chat.choices as Array<Record<string, unknown>>)[0] as { message: Record<string, unknown> }
    ).message;
    expect(msg.reasoning_content).toBe("推理摘要");
    expect(msg.content).toBe("正文");
  });

  it("chat reasoning_content → Responses reasoning item", () => {
    const resp = chatJsonToResponses(
      {
        choices: [{ message: { role: "assistant", content: "正文", reasoning_content: "推理摘要" } }],
      },
      { model: "m" },
    );
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({ type: "reasoning", summary: "推理摘要" });
    expect(output[1]).toMatchObject({ type: "message" });
  });
});

describe("finish_reason / stop_reason 完整映射", () => {
  it("Anthropic stop_reason → chat finish_reason（含 stop_sequence / refusal）", () => {
    const mk = (s: string) =>
      anthropicJsonToChatJson({
        id: "m", type: "message", role: "assistant", model: "m",
        content: [{ type: "text", text: "x" }], stop_reason: s,
      });
    const reason = (s: string) =>
      ((mk(s).choices as Array<Record<string, unknown>>)[0] as { finish_reason: unknown }).finish_reason;
    expect(reason("end_turn")).toBe("stop");
    expect(reason("stop_sequence")).toBe("stop");
    expect(reason("refusal")).toBe("stop");
    expect(reason("max_tokens")).toBe("length");
    expect(reason("tool_use")).toBe("tool_calls");
  });

  it("chat finish_reason → Anthropic stop_reason（含 content_filter / function_call）", () => {
    const mk = (f: string) =>
      chatJsonToAnthropicJson({
        choices: [{ message: { role: "assistant", content: "x" }, finish_reason: f }],
      });
    const reason = (f: string) => mk(f).stop_reason;
    expect(reason("stop")).toBe("end_turn");
    expect(reason("content_filter")).toBe("end_turn");
    expect(reason("length")).toBe("max_tokens");
    expect(reason("tool_calls")).toBe("tool_use");
    expect(reason("function_call")).toBe("tool_use");
  });
});

describe("stop / stop_sequences 与并行工具调用映射", () => {
  it("Anthropic stop_sequences → chat stop", () => {
    expect(anthropicToChat({ model: "m", messages: [], stop_sequences: ["a", "b"] }).stop).toEqual(["a", "b"]);
  });

  it("chat stop（数组/字符串）→ Anthropic stop_sequences", () => {
    expect(chatToAnthropic({ model: "m", messages: [], stop: ["a", "b"] }).stop_sequences).toEqual(["a", "b"]);
    expect(chatToAnthropic({ model: "m", messages: [], stop: "a" }).stop_sequences).toEqual(["a"]);
  });

  it("disable_parallel_tool_use ↔ parallel_tool_calls:false", () => {
    expect(
      anthropicToChat({ model: "m", messages: [], tool_choice: { type: "auto", disable_parallel_tool_use: true } })
        .parallel_tool_calls,
    ).toBe(false);
    expect(chatToAnthropic({ model: "m", messages: [], parallel_tool_calls: false }).tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    expect(
      chatToAnthropic({
        model: "m",
        messages: [],
        tool_choice: { type: "function", function: { name: "f" } },
        parallel_tool_calls: false,
      }).tool_choice,
    ).toEqual({ type: "tool", name: "f", disable_parallel_tool_use: true });
  });
});

describe("流式错误帧透传", () => {
  it("Anthropic error 事件 → chat 内联 error 帧，且不发送 [DONE]", async () => {
    const ts = createAnthropicSseToChatSse({ model: "m" });
    const out = await runTransform(ts, [
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream busy"}}\n\n',
    ]);
    expect(out).toContain('"error"');
    expect(out).toContain("upstream busy");
    expect(out).not.toContain("[DONE]");
  });

  it("chat 内联 error 帧 → Anthropic error 事件", async () => {
    const ts = createChatSseToAnthropicSse({ model: "m" });
    const out = await runTransform(ts, [
      'data: {"error":{"type":"invalid_request_error","message":"bad input"}}\n\n',
    ]);
    expect(out).toContain('event: error');
    expect(out).toContain("bad input");
  });
});

describe("thinking signature 保真（preserveSignature 开关，默认关）", () => {
  it("Anthropic JSON signature → chat 携带 anthropic_reasoning_signature（仅开启时）", () => {
    const input = {
      id: "m", type: "message", role: "assistant", model: "m",
      content: [
        { type: "thinking", thinking: "推理", signature: "sig-abc" },
        { type: "text", text: "正文" },
      ],
      stop_reason: "end_turn",
    };
    const msg = (json: Record<string, unknown>) =>
      (
        (json.choices as Array<Record<string, unknown>>)[0] as { message: Record<string, unknown> }
      ).message;
    const withOpt = msg(anthropicJsonToChatJson(input, { preserveSignature: true }));
    expect(withOpt.reasoning_content).toBe("推理");
    expect(withOpt.anthropic_reasoning_signature).toBe("sig-abc");
    const without = msg(anthropicJsonToChatJson(input));
    expect(without.anthropic_reasoning_signature).toBeUndefined();
  });

  it("chat signature → Anthropic thinking 块带回 signature（map + preserveSignature）", () => {
    const anth = chatJsonToAnthropicJson(
      {
        choices: [{
          message: {
            role: "assistant",
            content: "正文",
            reasoning_content: "推理",
            anthropic_reasoning_signature: "sig-abc",
          },
        }],
      },
      { thinking: "map", preserveSignature: true },
    );
    const content = anth.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "thinking", thinking: "推理", signature: "sig-abc" });
  });

  it("请求方向：anthropicToChat / chatToAnthropic 携带并还原 signature", () => {
    const chat = anthropicToChat(
      {
        model: "m",
        messages: [{
          role: "assistant",
          content: [
            { type: "thinking", thinking: "推理", signature: "sig-x" },
            { type: "text", text: "正文" },
          ],
        }],
      },
      { preserveSignature: true },
    );
    const msg = (chat.messages as Array<Record<string, unknown>>).find((x) => x.role === "assistant")!;
    expect(msg.reasoning_content).toBe("推理");
    expect(msg.anthropic_reasoning_signature).toBe("sig-x");

    const anth = chatToAnthropic(
      { model: "m", messages: [msg] },
      { thinking: "map", preserveSignature: true },
    );
    const content = (anth.messages as Array<Record<string, unknown>>)
      .find((x) => x.role === "assistant")!.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "thinking", thinking: "推理", signature: "sig-x" });
  });

  it("流式 signature_delta ↔ reasoning_signature（preserveSignature 开启）", async () => {
    const ts1 = createAnthropicSseToChatSse({ model: "m", preserveSignature: true });
    const out1 = await runTransform(ts1, [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-s"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(out1).toContain('"reasoning_signature":"sig-s"');

    const ts2 = createChatSseToAnthropicSse({ model: "m", preserveSignature: true });
    const out2 = await runTransform(ts2, [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_signature":"sig-s"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(out2).toContain('"type":"signature_delta"');
    expect(out2).toContain('"signature":"sig-s"');
  });
});

describe("流式 stop_reason 保真", () => {
  it("message_delta.stop_reason=max_tokens → finish_reason=length（不再丢失）", async () => {
    const ts = createAnthropicSseToChatSse({ model: "m" });
    const out = await runTransform(ts, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(out).toContain('"finish_reason":"length"');
  });
});

describe("user ↔ metadata.user_id", () => {
  it("Anthropic metadata.user_id → chat user", () => {
    expect(anthropicToChat({ model: "m", messages: [], metadata: { user_id: "u1" } }).user).toBe("u1");
  });
  it("chat user → Anthropic metadata.user_id", () => {
    expect(chatToAnthropic({ model: "m", messages: [], user: "u1" }).metadata).toEqual({ user_id: "u1" });
  });
});

describe("多模态 tool_result", () => {
  it("Anthropic tool_result 含图片 → chat tool 消息含 image_url", () => {
    const out = anthropicToChat({
      model: "m",
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "ok" },
            { type: "image", source: { type: "url", url: "http://x/y.png" } },
          ],
        }],
      }],
    });
    const toolMsg = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "tool");
    const content = toolMsg?.content as Array<Record<string, unknown>>;
    expect(content.some((b) => b.type === "image_url")).toBe(true);
    expect(content.some((b) => b.type === "text")).toBe(true);
  });

  it("chat tool 消息含 image_url → Anthropic tool_result 含 image 块", () => {
    const out = chatToAnthropic({
      model: "m",
      messages: [{
        role: "tool",
        tool_call_id: "t1",
        content: [
          { type: "text", text: "ok" },
          { type: "image_url", image_url: { url: "http://x/y.png" } },
        ],
      }],
    });
    const userMsg = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "user");
    const blocks = (userMsg?.content as Array<Record<string, unknown>>)[0]?.content as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === "image")).toBe(true);
  });
});

describe("legacy functions / function_call 兼容", () => {
  it("chat functions[] → Anthropic tools[]", () => {
    const out = chatToAnthropic({
      model: "m",
      messages: [],
      functions: [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(out.tools).toEqual([{ name: "f", description: "d", input_schema: { type: "object", properties: {} } }]);
  });

  it("assistant function_call → Anthropic tool_use 块", () => {
    const out = chatToAnthropic({
      model: "m",
      messages: [{
        role: "assistant",
        content: "我先查一下",
        function_call: { name: "f", arguments: '{"a":1}' },
      }],
    });
    const msg = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "我先查一下" });
    expect(blocks[1]).toMatchObject({ type: "tool_use", name: "f", input: { a: 1 } });
  });

  it("响应 message.function_call → Anthropic tool_use", () => {
    const anth = chatJsonToAnthropicJson({
      choices: [{ message: { role: "assistant", content: "", function_call: { name: "f", arguments: "{}" } } }],
    });
    const blocks = anth.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: "tool_use", name: "f" });
  });
});

describe("显式丢弃参数观测（onDropped）", () => {
  it("chat 专属参数转 Anthropic 时上报丢弃", () => {
    const dropped: string[] = [];
    chatToAnthropic(
      { model: "m", messages: [], logprobs: true, seed: 1, response_format: { type: "json_object" } },
      { onDropped: (p) => dropped.push(p) },
    );
    expect(dropped).toContain("logprobs");
    expect(dropped).toContain("seed");
    expect(dropped).toContain("response_format");
  });

  it("Anthropic 专属参数转 chat 时上报丢弃（top_k / thinking / 非 user metadata）", () => {
    const dropped: string[] = [];
    anthropicToChat(
      { model: "m", messages: [], top_k: 5, thinking: { type: "enabled", budget_tokens: 100 }, metadata: { user_id: "u1", trace: "t" } },
      { onDropped: (p) => dropped.push(p) },
    );
    expect(dropped).toContain("top_k");
    expect(dropped).toContain("thinking");
    expect(dropped).toContain("metadata.trace");
    expect(dropped).not.toContain("metadata.user_id");
  });
});

describe("developer / system 角色语义", () => {
  it("chat developer 角色 → Anthropic system（不落成 user）", () => {
    const anth = chatToAnthropic({
      model: "m",
      messages: [
        { role: "developer", content: "系统规则" },
        { role: "user", content: "hi" },
      ],
    });
    expect(anth.system).toContain("系统规则");
    const users = (anth.messages as Array<Record<string, unknown>>).filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["hi"]);
  });

  it("Responses developer → chat system 消息", () => {
    const chat = responsesBodyToChat(
      {
        model: "m",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "规则" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      },
      {},
    );
    const msgs = chat.messages as Array<Record<string, unknown>>;
    expect(msgs.some((m) => m.role === "system" && m.content === "规则")).toBe(true);
    expect(msgs.filter((m) => m.role === "user").length).toBe(1);
  });

  it("system/assistant 的 content 数组提取文本，不做 JSON.stringify", () => {
    const anth = chatToAnthropic({
      model: "m",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "规则A" },
            { type: "text", text: "规则B" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "我来查" }],
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
          ],
        },
      ],
    });
    expect(anth.system).toBe("规则A\n\n规则B");
    expect(anth.system).not.toContain("[{");
    const asst = (anth.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
    const blocks = asst?.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "我来查" });
    expect(blocks[1]).toMatchObject({ type: "tool_use", name: "f" });
  });

  it("chat JSON 的 assistant content 数组 → Anthropic text 块（不丢正文）", () => {
    const out = chatJsonToAnthropicJson({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        },
      ],
    });
    expect(out.content).toEqual([
      { type: "text", text: "a\n\nb" },
    ]);
  });
});

describe("round-trip 属性测试（确定性随机，语义保真）", () => {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

  it("Anthropic 响应 → Chat → Anthropic：thinking/text/tool_use/stop_reason 语义保持", () => {
    for (let n = 0; n < 20; n++) {
      const content: Array<Record<string, unknown>> = [];
      if (rnd() < 0.6) content.push({ type: "thinking", thinking: `推理${n}` });
      if (rnd() < 0.9) content.push({ type: "text", text: `正文${n}` });
      const toolCount = Math.floor(rnd() * 3);
      for (let t = 0; t < toolCount; t++) {
        content.push({ type: "tool_use", id: `toolu_${n}_${t}`, name: `fn${t}`, input: { k: t } });
      }
      const stop = pick(["end_turn", "tool_use", "max_tokens"]);
      const anth = {
        id: `m${n}`, type: "message", role: "assistant", model: "m",
        content, stop_reason: stop,
      };
      const viaChat = chatJsonToAnthropicJson(anthropicJsonToChatJson(anth), { thinking: "map" });
      const blocks = viaChat.content as Array<Record<string, unknown>>;
      const expectTexts = content.filter((b) => b.type === "text").map((b) => b.text as string).join("");
      expect(blocks.filter((b) => b.type === "text").map((b) => b.text as string).join("")).toBe(expectTexts);
      expect(blocks.filter((b) => b.type === "thinking").map((b) => b.thinking as string))
        .toEqual(content.filter((b) => b.type === "thinking").map((b) => b.thinking as string));
      const tools = blocks.filter((b) => b.type === "tool_use");
      const origTools = content.filter((b) => b.type === "tool_use");
      expect(tools.map((b) => b.id)).toEqual(origTools.map((b) => b.id));
      expect(tools.map((b) => b.name)).toEqual(origTools.map((b) => b.name));
      expect(tools.map((b) => b.input)).toEqual(origTools.map((b) => b.input));
      expect(viaChat.stop_reason).toBe(stop);
    }
  });

  it("Chat 请求 → Anthropic → Chat：角色序列与 tool_call_id 配对保持", () => {
    for (let n = 0; n < 20; n++) {
      const messages: Array<Record<string, unknown>> = [];
      const round = 1 + Math.floor(rnd() * 3);
      for (let r = 0; r < round; r++) {
        messages.push({ role: "user", content: `q${n}_${r}` });
        if (rnd() < 0.7) {
          const calls = [
            { id: `call_${n}_${r}`, type: "function", function: { name: "f", arguments: '{"x":1}' } },
          ];
          messages.push({ role: "assistant", content: null, tool_calls: calls });
          messages.push({ role: "tool", tool_call_id: `call_${n}_${r}`, content: `res${n}_${r}` });
        } else {
          messages.push({ role: "assistant", content: `a${n}_${r}` });
        }
      }
      const back = anthropicToChat(chatToAnthropic({ model: "m", messages }));
      const backMsgs = back.messages as Array<Record<string, unknown>>;
      expect(backMsgs.map((m) => m.role)).toEqual(messages.map((m) => m.role));
      for (const m of backMsgs) {
        if (m.role !== "tool") continue;
        const cid = m.tool_call_id as string;
        const idx = backMsgs.indexOf(m);
        const prev = backMsgs.slice(0, idx).reverse().find((x) => x.role === "assistant");
        expect(
          prev &&
            Array.isArray(prev.tool_calls) &&
            (prev.tool_calls as Array<Record<string, unknown>>).some((t) => t.id === cid),
        ).toBe(true);
      }
    }
  });
});

describe("Responses 方向流式错误透传", () => {
  it("上游 response.failed → chat 内联 error 帧，不再静默收尾", async () => {
    const ts = createResponsesSseToChatSse({ model: "m" });
    const out = await runTransform(ts, [
      'event: response.failed\ndata: {"type":"response.failed","error":{"type":"upstream_error","message":"boom"}}\n\n',
    ]);
    expect(out).toContain('"error"');
    expect(out).toContain("boom");
    expect(out).not.toContain("[DONE]");
  });

  it("上游 chat 内联 error 帧 → Responses response.failed 事件", async () => {
    const ts = createChatSseToResponses({ model: "m" });
    const out = await runTransform(ts, [
      'data: {"error":{"type":"invalid_request_error","message":"bad"}}\n\n',
    ]);
    expect(out).toContain("event: response.failed");
    expect(out).toContain("bad");
  });
});

describe("转换器确定性（同输入 → 字节一致输出，上游缓存前提）", () => {
  it("chatToAnthropic / anthropicJsonToChatJson 两次转换一致", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "f" } },
      stop: ["a"],
      user: "u1",
    };
    expect(JSON.stringify(chatToAnthropic(body))).toBe(JSON.stringify(chatToAnthropic(body)));

    const anthJson = {
      id: "m1", type: "message", role: "assistant", model: "m",
      content: [
        { type: "text", text: "x" },
        { type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } },
      ],
      stop_reason: "tool_use",
    };
    expect(JSON.stringify(anthropicJsonToChatJson(anthJson)))
      .toBe(JSON.stringify(anthropicJsonToChatJson(anthJson)));
  });
});
describe("流式 Anthropic tool_use → Chat tool_calls 序号重映射", () => {
  // Anthropic 的 content block index 与 chat 的 tool_calls 序号不同（thinking/text 也占位），
  // 这里验证上游块 index=1/2 的 tool_use 在 chat 端按出现顺序输出为 0/1。
  function chatToolIndexes(out: string): number[] {
    const idxs: number[] = [];
    for (const frame of out.split(/\r?\n\r?\n/)) {
      const m = frame.match(/^data: (.*)$/ms);
      if (!m || m[1] === "[DONE]") continue;
      try {
        const evt = JSON.parse(m[1]) as {
          choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number }> } }>;
        };
        for (const c of evt.choices ?? []) {
          for (const tc of c.delta?.tool_calls ?? []) idxs.push(tc.index ?? -1);
        }
      } catch {
        /* skip malformed frame */
      }
    }
    return idxs;
  }

  it("thinking(0) 先于 tool_use(1)：chat 端只出现连续 index 0", async () => {
    const ts = createAnthropicSseToChatSse({ model: "m" });
    const out = await runTransform(ts, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"sz\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(chatToolIndexes(out)).toEqual([0, 0]);
    expect(out).toContain('"id":"toolu_1"');
    expect(out).toContain('city');
    expect(out).toContain('"finish_reason":"tool_calls"');
    // 上游块 index=1 绝不能泄漏成 chat 的 tool_calls index=1
    expect(out).not.toContain('"index":1');
  });

  it("text(0) + tool_use(1,2)：chat 端序号为 0,0,1,1", async () => {
    const ts = createAnthropicSseToChatSse({ model: "m" });
    const out = await runTransform(ts, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_a","name":"f_a","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_b","name":"f_b","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(chatToolIndexes(out)).toEqual([0, 0, 1, 1]);
    expect(out).toContain('"id":"toolu_a"');
    expect(out).toContain('"id":"toolu_b"');
    expect(out).not.toContain('"index":2');
  });
});

describe("tool_choice none 语义（Anthropic 无 none → 移除全部 tools）", () => {
  it("chat none：不携带 tools 且不设 tool_choice，避免反转成 auto", () => {
    const out = chatToAnthropic({
      model: "m",
      messages: [],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    });
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
  });

  it("chat none + parallel_tool_calls:false：不产生 disable_parallel_tool_use", () => {
    const out = chatToAnthropic({
      model: "m",
      messages: [],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
      parallel_tool_calls: false,
    });
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
  });
});

describe("usage 缓存统计（chat/anthropic 各自字段语义）", () => {
  it("chat usage（cached_tokens / prompt_tokens_details）计入缓存命中", () => {
    resetProtocolStats();
    chatJsonToAnthropicJson({
      id: "x",
      choices: [{ message: { role: "assistant", content: "a" } }],
      usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 30 } },
    });
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cacheHitRequests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(30);
    expect(snap.cache.inputTokens).toBe(100);
  });

  it("anthropic usage（cache_read_input_tokens）计入缓存命中", () => {
    resetProtocolStats();
    anthropicJsonToChatJson({
      id: "m",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "a" }],
      usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 60 },
    });
    const snap = getProtocolStats();
    expect(snap.cache.requests).toBe(1);
    expect(snap.cache.cacheHitRequests).toBe(1);
    expect(snap.cache.cachedTokens).toBe(60);
    expect(snap.cache.inputTokens).toBe(200);
  });
});
describe("空内容 Chat 流 → Anthropic SSE 也必须先发 message_start", () => {
  it("上游只发 finish_reason + [DONE]（无内容块）→ 输出含 message_start 且先于 message_delta", async () => {
    const ts = createChatSseToAnthropicSse({ model: "m" });
    const out = await runTransform(ts, [
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(out.indexOf('"type":"message_start"')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('"type":"message_start"')).toBeLessThan(out.indexOf('"type":"message_delta"'));
    expect(out).toContain('"type":"message_stop"');
  });
});
describe("丢参始终计入 /metrics（无需调用方接线 onDropped）", () => {
  it("chatToAnthropic 未传 onDropped：logprobs/seed 丢参进 prometheus 计数", () => {
    resetProtocolStats();
    chatToAnthropic({ model: "m", messages: [], logprobs: true, seed: 1 });
    chatToAnthropic({ model: "m", messages: [], logprobs: true });
    const out = protocolStatsToPrometheus();
    expect(out).toContain('tdai_conversion_dropped_total{kind="chat_to_anthropic",param="logprobs"} 2');
    expect(out).toContain('tdai_conversion_dropped_total{kind="chat_to_anthropic",param="seed"} 1');
  });

  it("anthropicToChat 未传 onDropped：top_k / metadata 丢参进计数（metadata 聚合）", () => {
    resetProtocolStats();
    anthropicToChat({ model: "m", messages: [], top_k: 5, metadata: { user_id: "u", custom: "x" } });
    const out = protocolStatsToPrometheus();
    expect(out).toContain('tdai_conversion_dropped_total{kind="anthropic_to_chat",param="top_k"} 1');
    expect(out).toContain('tdai_conversion_dropped_total{kind="anthropic_to_chat",param="metadata"} 1');
    expect(out).not.toContain('param="metadata.custom"');
  });
});
