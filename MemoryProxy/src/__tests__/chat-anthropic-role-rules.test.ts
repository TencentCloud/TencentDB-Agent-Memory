import { beforeEach, describe, expect, it } from "vitest";
import { anthropicToChat, chatToAnthropic } from "../common/chat-anthropic-compat.js";
import { protocolStatsToPrometheus, resetProtocolStats } from "../common/protocol-stats.js";

/**
 * Chat → Anthropic 两条硬约束的回归（TRACK 05A 边缘面）。
 *
 * Anthropic Messages 对 OpenAI Chat 侧不强制、但对上游是硬性的两点：
 *   1. `messages` 角色必须**严格交替**（连续两条 assistant → `roles must alternate` 400）；
 *   2. `tool_result` 必须出现在**紧邻**对应 `tool_use` 之后的 user 消息里
 *      （否则 `unexpected tool_use_id` 400）。
 *
 * 这两条都会在「客户端历史被裁剪 / 编辑重发 / 形状漂移」时被触发，而且 400 会让
 * 整轮请求连同记忆注入一起失败 —— 所以转换层必须自己收敛，而不是把问题透传给上游。
 */

type Msg = Record<string, unknown>;

const messagesOf = (out: Record<string, unknown>): Msg[] => out.messages as Msg[];
const roles = (out: Record<string, unknown>): unknown[] => messagesOf(out).map((m) => m.role);
const blocksOf = (out: Record<string, unknown>, i: number): Msg[] => {
  const content = messagesOf(out)[i].content;
  return Array.isArray(content) ? (content as Msg[]) : [];
};
const typesOf = (out: Record<string, unknown>, i: number): unknown[] =>
  blocksOf(out, i).map((b) => b.type);
const toolCall = (id: string): Msg => ({
  id,
  type: "function",
  function: { name: "f", arguments: "{}" },
});

beforeEach(() => {
  resetProtocolStats();
});

describe("Chat → Anthropic：角色严格交替", () => {
  it("相邻 assistant 消息被合并成一条（否则上游 roles must alternate 400）", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "part one" },
        { role: "assistant", content: "part two" },
        { role: "user", content: "continue" },
      ],
    });
    expect(roles(out)).toEqual(["user", "assistant", "user"]);
    expect(blocksOf(out, 1)).toEqual([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
    ]);
  });

  it("连续三条 assistant 也收敛成一条，内容不丢", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "assistant", content: "b" },
        { role: "assistant", content: "c" },
      ],
    });
    expect(roles(out)).toEqual(["user", "assistant"]);
    expect(blocksOf(out, 1).map((b) => b.text)).toEqual(["a", "b", "c"]);
  });

  it("合并时保留 tool_use 及其后续文本的先后关系", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "see", tool_calls: [toolCall("call_1")] },
        { role: "assistant", content: "done" },
      ],
    });
    expect(roles(out)).toEqual(["user", "assistant"]);
    expect(typesOf(out, 1)).toEqual(["text", "tool_use", "text"]);
    expect((blocksOf(out, 1)[1] as Msg).id).toBe("call_1");
  });

  it("合并时 thinking 稳定前移（Anthropic 要求 thinking 位于内容首位）", () => {
    const out = chatToAnthropic(
      {
        model: "claude-x",
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "first" },
          { role: "assistant", content: "second", reasoning_content: "R2" },
        ],
      },
      { thinking: "map" },
    );
    expect(typesOf(out, 1)).toEqual(["thinking", "text", "text"]);
    expect(blocksOf(out, 1).map((b) => b.text ?? b.thinking)).toEqual(["R2", "first", "second"]);
  });

  it("交替本来就正确的会话不被改写（回归护栏）", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    expect(roles(out)).toEqual(["user", "assistant", "user"]);
    // 普通（无工具、无 reasoning）的交替会话保持既有形态：content 仍是字符串。
    expect(messagesOf(out)[1].content).toBe("a1");
  });

  it("相邻 user 仍合并，且 tool_result 前置（既有语义不回退）", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [toolCall("c1")] },
        { role: "tool", tool_call_id: "c1", content: "out" },
        { role: "user", content: "thanks" },
      ],
    });
    expect(roles(out)).toEqual(["user", "assistant", "user"]);
    expect(typesOf(out, 2)).toEqual(["tool_result", "text"]);
  });
});

describe("Chat → Anthropic：tool_result 必须紧邻对应 tool_use", () => {
  it("合法 tool_result 保留，并带上 tool_use_id", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [toolCall("c1")] },
        { role: "tool", tool_call_id: "c1", content: "out" },
      ],
    });
    expect(typesOf(out, 2)).toEqual(["tool_result"]);
    expect((blocksOf(out, 2)[0] as Msg).tool_use_id).toBe("c1");
  });

  it("悬空 tool_result 降级为普通 user 文本，不产出悬空 tool_use_id，并计入 /metrics", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "run it" },
        { role: "tool", tool_call_id: "call_ghost", content: "ok" },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("tool_result");
    expect(JSON.stringify(out)).toContain("ok");
    expect(roles(out)).toEqual(["user"]);
    expect(protocolStatsToPrometheus()).toContain('param="orphan_tool_result"');
  });

  it("tool_result 与 tool_use 之间插入了别的 user 轮次 → 同样降级", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [toolCall("c1")] },
        { role: "user", content: "wait" },
        { role: "tool", tool_call_id: "c1", content: "out" },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("tool_result");
    expect(JSON.stringify(out)).toContain("out");
  });

  it("部分悬空：只降级缺配对的那一条，合法配对不受影响", () => {
    const out = chatToAnthropic({
      model: "claude-x",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [toolCall("c1"), toolCall("c2")] },
        { role: "tool", tool_call_id: "c1", content: "a" },
        { role: "tool", tool_call_id: "c3", content: "b" },
      ],
    });
    const blocks = JSON.stringify(out);
    expect((blocks.match(/"type":"tool_result"/g) ?? []).length).toBe(1);
    expect(blocks).toContain('"tool_use_id":"c1"');
    expect(blocks).toContain('"text":"b"');
  });

  it("Anthropic → Chat → Anthropic 往返：system / 角色 / tool_result 位置与 id 均不变", () => {
    const back = chatToAnthropic(
      anthropicToChat({
        model: "claude-x",
        system: "you are terse",
        max_tokens: 256,
        messages: [
          { role: "user", content: [{ type: "text", text: "查天气" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "看下" },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SZ" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "25C" }] },
        ],
      }),
    );
    expect(back.system).toBe("you are terse");
    expect(roles(back)).toEqual(["user", "assistant", "user"]);
    expect(typesOf(back, 2)).toEqual(["tool_result"]);
    expect((blocksOf(back, 2)[0] as Msg).tool_use_id).toBe("toolu_1");
  });
});
