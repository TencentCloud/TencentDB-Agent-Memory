import { describe, it, expect } from "vitest";
import { auditUpstreamAgentKeys, resolveUpstreamApiKey } from "../upstream/auth.js";

describe("上游凭据解析（upstream/auth）", () => {
  it("agent 条目配了 apiKey 时优先使用它", () => {
    expect(
      resolveUpstreamApiKey({
        agentEntry: { apiKey: "sk-agent" },
        globalApiKey: "sk-global",
        clientApiKey: "sk-client",
      }),
    ).toEqual({ apiKey: "sk-agent", source: "agent" });
  });

  it("agent 条目只有 url 时回退 upstream.apiKey（不再直接透传客户端）", () => {
    expect(
      resolveUpstreamApiKey({
        agentEntry: {},
        globalApiKey: "sk-global",
        clientApiKey: "sk-client",
      }),
    ).toEqual({ apiKey: "sk-global", source: "global" });
  });

  it("两级都没有配置时沿用客户端 key", () => {
    expect(
      resolveUpstreamApiKey({ agentEntry: {}, clientApiKey: "sk-client" }),
    ).toEqual({ apiKey: "sk-client", source: "client" });
  });

  it("passthroughClientKey: true 时优先透传，即使配了全局 key", () => {
    expect(
      resolveUpstreamApiKey({
        agentEntry: { passthroughClientKey: true },
        globalApiKey: "sk-global",
        clientApiKey: "sk-client",
      }),
    ).toEqual({ apiKey: "sk-client", source: "client" });
  });

  it("声明透传但客户端没带 key → 返回空串（不注入任何凭据）", () => {
    expect(
      resolveUpstreamApiKey({
        agentEntry: { passthroughClientKey: true },
        globalApiKey: "sk-global",
      }),
    ).toEqual({ apiKey: "", source: "client" });
  });

  it("启动期审计：逐条说明每个 agent 的凭据来源", () => {
    const notes = auditUpstreamAgentKeys(
      {
        "claude-code": { apiKey: "sk-agent" },
        codex: {},
        workbuddy: { passthroughClientKey: true },
      },
      "sk-global",
    );
    expect(notes).toHaveLength(2);
    expect(notes.join("\n")).toContain("upstream.agents.codex 未配置 apiKey，将回退到 upstream.apiKey");
    expect(notes.join("\n")).toContain("upstream.agents.workbuddy 声明 passthroughClientKey: true");
  });

  it("启动期审计：两级 key 都为空时提示会透传客户端 key", () => {
    const notes = auditUpstreamAgentKeys({ codex: {} }, "");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("将透传客户端 key");
    expect(notes[0]).toContain("401");
  });
});
