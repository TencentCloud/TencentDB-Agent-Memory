import { describe, expect, it } from "vitest";
import {
  buildOpikTraceMetadata,
  summarizeResponsesToolInteraction,
  summarizeToolInteraction,
} from "../opik-metadata.js";

describe("buildOpikTraceMetadata", () => {
  it("只写入明确字段，空值/未定义不落 metadata", () => {
    const meta = buildOpikTraceMetadata({
      agentSource: "claude-code",
      protocol: "anthropic",
      sessionKey: "s1",
      spaceId: "space-1",
      userId: "u1",
      model: "glm-4.5",
      stream: true,
      turnSeq: 3,
      requestPath: "/anthropic/v1/messages",
    });
    expect(meta).toEqual({
      agent_source: "claude-code",
      protocol: "anthropic",
      session_key: "s1",
      space_id: "space-1",
      user_id: "u1",
      model: "glm-4.5",
      stream: true,
      turn_seq: 3,
      request_path: "/anthropic/v1/messages",
    });
  });

  it("字符串长度封顶，非法数值不写入", () => {
    const meta = buildOpikTraceMetadata({
      agentSource: "x".repeat(80),
      requestPath: "y".repeat(500),
      turnSeq: Number.NaN,
      stream: undefined,
    });
    expect(meta.agent_source).toHaveLength(32);
    expect(meta.request_path).toHaveLength(256);
    expect(meta.turn_seq).toBeUndefined();
    expect(meta.stream).toBeUndefined();
  });

  it("memory_injection 只有存在信息才写入", () => {
    expect(buildOpikTraceMetadata({}).memory_injection).toBeUndefined();
    expect(
      buildOpikTraceMetadata({ memoryInjection: { enabled: true, injectorCount: 5, skipped: false } })
        .memory_injection,
    ).toEqual({ enabled: true, injector_count: 5, skipped: false });
  });
});

describe("summarizeToolInteraction", () => {
  it("OpenAI chat：assistant tool_calls + role=tool 结果", () => {
    const summary = summarizeToolInteraction([
      { role: "assistant", content: "ok", tool_calls: [{ function: { name: "search" } }, { function: { name: "search" } }] },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "tool", tool_call_id: "c2", content: "r2" },
    ]);
    expect(summary).toEqual({ toolCalls: ["search"], toolResults: 2 });
  });

  it("Anthropic：tool_use 块与 tool_result 块", () => {
    const summary = summarizeToolInteraction([
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "read_file" }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }],
      },
    ]);
    expect(summary).toEqual({ toolCalls: ["read_file"], toolResults: 1 });
  });

  it("legacy function_call 与未知结构容错", () => {
    const summary = summarizeToolInteraction([
      { role: "assistant", function_call: { name: "legacy_fn" } },
      null,
      "plain",
      { role: "user", content: "no tools" },
    ]);
    expect(summary).toEqual({ toolCalls: ["legacy_fn"], toolResults: 0 });
  });
});

describe("summarizeResponsesToolInteraction", () => {
  it("Responses input[]：function_call 名称去重 + function_call_output 计数", () => {
    const summary = summarizeResponsesToolInteraction([
      { type: "function_call", name: "get_weather", arguments: "{}" },
      { type: "function_call", name: "get_weather", arguments: "{}" },
      { type: "function_call", name: "search_code" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { type: "message", role: "user", content: [] },
      null,
    ]);
    expect(summary).toEqual({
      toolCalls: ["get_weather", "search_code"],
      toolResults: 1,
    });
  });
});
