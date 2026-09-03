import { describe, it, expect } from "vitest";
import { resolveAgentModes } from "../upstream/capability-probe.js";

describe("resolveAgentModes（上游协议自动选路）", () => {
  it("上游仅支持 Chat：workbuddy 桌面走 chatCompletions，claude-code 走 anthropicToChat，codex 走 chatCompletions", () => {
    const m = resolveAgentModes({ chat: true, responses: false, anthropic: false });
    expect(m.workbuddy).toEqual({ chatCompletions: true });
    expect(m["claude-code"]).toEqual({ anthropicToChat: true });
    expect(m.codex).toEqual({ chatCompletions: true });
  });

  it("上游仅支持 Anthropic：workbuddy 走 chatToAnthropic，claude-code 直连，codex 走 responsesToAnthropic", () => {
    const m = resolveAgentModes({ chat: false, responses: false, anthropic: true });
    // WorkBuddy 桌面（Responses）与网页（Chat）两条路径都指向 Anthropic 上游。
    expect(m.workbuddy).toEqual({ chatToAnthropic: true, responsesToAnthropic: true });
    expect(m["claude-code"]).toEqual({});
    expect(m.codex).toEqual({ responsesToAnthropic: true });
  });

  it("上游支持 Chat 但不支持 Responses：workbuddy 桌面走 chatCompletions，网页直连", () => {
    const m = resolveAgentModes({ chat: true, responses: false, anthropic: false });
    expect(m.workbuddy).toEqual({ chatCompletions: true });
    expect(m["claude-code"]).toEqual({ anthropicToChat: true });
    expect(m.codex).toEqual({ chatCompletions: true });
  });

  it("上游仅支持 Responses：claude-code 走 anthropicToResponses，codex 直连，workbuddy 无路（chat 不支持且非 anthropic）", () => {
    const m = resolveAgentModes({ chat: false, responses: true, anthropic: false });
    expect(m["claude-code"]).toEqual({ anthropicToResponses: true });
    expect(m.codex).toEqual({});
    expect(m.workbuddy).toEqual({});
  });

  it("上游全支持：三个客户端都直连（客户端原生协议优先）", () => {
    const m = resolveAgentModes({ chat: true, responses: true, anthropic: true });
    expect(m.workbuddy).toEqual({});
    expect(m["claude-code"]).toEqual({});
    expect(m.codex).toEqual({});
  });
});
