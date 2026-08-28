import { describe, it, expect } from "vitest";
import { resolveAgentModes } from "../upstream/capability-probe.js";

describe("resolveAgentModes（上游协议自动选路）", () => {
  it("上游仅支持 Chat：workbuddy 直连，claude-code 走 anthropicToChat，codex 走 chatCompletions", () => {
    const m = resolveAgentModes({ chat: true, responses: false, anthropic: false });
    expect(m.workbuddy).toEqual({});
    expect(m["claude-code"]).toEqual({ anthropicToChat: true });
    expect(m.codex).toEqual({ chatCompletions: true });
  });

  it("上游仅支持 Anthropic：workbuddy 走 chatToAnthropic，claude-code 直连，codex 走 responsesToAnthropic", () => {
    const m = resolveAgentModes({ chat: false, responses: false, anthropic: true });
    expect(m.workbuddy).toEqual({ chatToAnthropic: true });
    expect(m["claude-code"]).toEqual({});
    expect(m.codex).toEqual({ responsesToAnthropic: true });
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
