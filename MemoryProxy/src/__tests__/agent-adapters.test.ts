import { describe, expect, it } from "vitest";
import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { dshAdapter } from "../agent-adapters/dsh.js";
import { openclawAdapter } from "../agent-adapters/openclaw.js";
import { hermesAdapter } from "../agent-adapters/hermes.js";
import { codebuddyAdapter } from "../agent-adapters/codebuddy.js";
import { defaultAdapter } from "../agent-adapters/default.js";

/**
 * Agent adapter 契约测试（TRACK 02：OpenClaw / DSH 插件接入）。
 *
 * 目的：客户端升级导致请求形状漂移时，这些黄金样例能第一时间暴露破坏。
 * 覆盖三个适配点：
 *   1. resolveAgentAdapter 工厂按 agentSource 分发；
 *   2. classifyRequest 的 aux / main 判定（dsh compact/title 信号）；3. extractUserText 的用户输入提取。
 */

describe("resolveAgentAdapter factory", () => {
  it("maps known agent sources to their adapters", () => {
    expect(resolveAgentAdapter("claude-code").agentKind).toBe("claude-code");
    expect(resolveAgentAdapter("codebuddy").agentKind).toBe("codebuddy");
    expect(resolveAgentAdapter("codex").agentKind).toBe("codex");
    expect(resolveAgentAdapter("workbuddy").agentKind).toBe("workbuddy");
    expect(resolveAgentAdapter("dsh").agentKind).toBe("dsh");
    expect(resolveAgentAdapter("openclaw").agentKind).toBe("openclaw");
    expect(resolveAgentAdapter("hermes").agentKind).toBe("hermes");
  });

  it("falls back to default adapter for unknown sources", () => {
    expect(resolveAgentAdapter("cursor").agentKind).toBe("unknown");
    expect(resolveAgentAdapter("totally-unknown-client").agentKind).toBe("unknown");
  });
});

describe("openclaw adapter", () => {
  it("classifies every request as main (no reliable aux signal yet)", () => {
    expect(openclawAdapter.classifyRequest({})).toBe("main");
    expect(
      openclawAdapter.classifyRequest(
        { messages: [{ role: "user", content: "hi" }], tools: [] },
        "/openclaw/default/v1/chat/completions",
        { "user-agent": "openclaw/0.x" },
      ),
    ).toBe("main");
  });

  it("extracts string user content directly", () => {
    expect(openclawAdapter.extractUserText("帮我查一下")).toBe("帮我查一下");
    expect(openclawAdapter.extractUserText("")).toBeNull();
  });

  it("falls back to default block-joining for array content", () => {
    expect(
      openclawAdapter.extractUserText([
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
    expect(openclawAdapter.extractUserText(null)).toBeNull();
  });
});

describe("hermes adapter", () => {
  it("classifies every request as main (no reliable aux signal yet)", () => {
    expect(hermesAdapter.classifyRequest({})).toBe("main");
    expect(
      hermesAdapter.classifyRequest(
        {
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "clarify" } }],
        },
        "/hermes/default/v1/chat/completions",
        { "user-agent": "hermes-cli/0.19.0" },
      ),
    ).toBe("main");
  });

  it("extracts string user content directly", () => {
    expect(hermesAdapter.extractUserText("帮我查一下")).toBe("帮我查一下");
    expect(hermesAdapter.extractUserText("")).toBeNull();
  });

  it("falls back to default block-joining for array content", () => {
    expect(
      hermesAdapter.extractUserText([
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
    expect(hermesAdapter.extractUserText(null)).toBeNull();
  });
});

describe("dsh adapter", () => {
  it("detects compaction by x-deepseek-harness-compact header", () => {
    expect(
      dshAdapter.classifyRequest(
        { messages: [{ role: "user", content: "summarize" }] },
        "/dsh/default/chat/completions",
        { "x-deepseek-harness-compact": "1" },
      ),
    ).toBe("auxiliary");
  });

  it("detects title-gen by three-part body shape", () => {
    const titleGenBody = {
      messages: [
        {
          role: "system",
          content: "Create a concise title for an AI coding-assistant session from the supplied human messages.",
        },
        { role: "user", content: "hello" },
      ],
      thinking: { type: "disabled" },
      max_tokens: 64,
      tools: [],
    };
    expect(dshAdapter.classifyRequest(titleGenBody, "/dsh/default/chat/completions", {})).toBe(
      "auxiliary",
    );
  });

  it("treats normal conversation as main even with tools", () => {
    expect(
      dshAdapter.classifyRequest(
        {
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "ask_user_question" } }],
        },
        "/dsh/default/chat/completions",
        {},
      ),
    ).toBe("main");
  });

  it("extracts string user content", () => {
    expect(dshAdapter.extractUserText("你好")).toBe("你好");
    expect(dshAdapter.extractUserText(123 as unknown)).toBeNull();
  });
});

describe("codebuddy adapter", () => {
  it("extracts the real user query from pseudo-XML wrapper", () => {
    const content =
      "<user_info>OS: Windows</user_info>\n<user_query>写一个排序算法</user_query>";
    expect(codebuddyAdapter.extractUserText(content)).toContain("写一个排序算法");
  });

  it("classifies all requests as main", () => {
    expect(codebuddyAdapter.classifyRequest({})).toBe("main");
  });
});

describe("default adapter", () => {
  it("joins all text blocks and returns string content", () => {
    expect(defaultAdapter.extractUserText("plain")).toBe("plain");
    expect(
      defaultAdapter.extractUserText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });
});
