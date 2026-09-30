import { describe, expect, it } from "vitest";
import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { dshAdapter } from "../agent-adapters/dsh.js";
import { openclawAdapter } from "../agent-adapters/openclaw.js";

/**
 * OpenClaw / DSH 适配器契约测试（TRACK 02：OpenClaw / DSH 插件接入）。
 *
 * 目的：客户端升级导致请求形状漂移时，这些黄金样例能第一时间暴露破坏。
 * 覆盖：factory 分发、openclaw main 判定、dsh aux 判定、用户输入提取。
 */

describe("resolveAgentAdapter（openclaw / dsh）", () => {
  it("maps known agent sources to their adapters", () => {
    expect(resolveAgentAdapter("openclaw").agentKind).toBe("openclaw");
    expect(resolveAgentAdapter("dsh").agentKind).toBe("dsh");
  });

  it("falls back to default adapter for unknown sources", () => {
    expect(resolveAgentAdapter("unknown-agent").agentKind).toBe("unknown");
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
          content:
            "Create a concise title for an AI coding-assistant session from the supplied human messages.",
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

  it("treats normal conversation as main even with ask_user_question tool", () => {
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
