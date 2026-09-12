import { describe, expect, it } from "vitest";
import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { hermesAdapter } from "../agent-adapters/hermes.js";

/**
 * Hermes 适配器契约测试（TRACK 03：Hermes 交互式 Tools 接入）。
 *
 * 覆盖三个点：
 *   1. resolveAgentAdapter 能把 agentSource="hermes" 分发给 hermesAdapter；
 *   2. classifyRequest 对含 clarify 的交互式工具请求仍判 main
 *      （clarify 是标准 tool-call 往返，不能当 aux 短路）；
 *   3. extractUserText 从字符串 content 取用户输入，未来改 blocks 有兜底。
 */

describe("resolveAgentAdapter（hermes）", () => {
  it("maps hermes agent source to hermesAdapter", () => {
    expect(resolveAgentAdapter("hermes").agentKind).toBe("hermes");
  });

  it("does not affect unknown clients", () => {
    expect(resolveAgentAdapter("cursor").agentKind).toBe("unknown");
  });
});

describe("hermes adapter（交互式 clarify 请求）", () => {
  it("classifies clarify 交互请求为 main，不短路 aux 链路", () => {
    expect(
      hermesAdapter.classifyRequest(
        {
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "clarify",
                parameters: {
                  type: "object",
                  properties: { question: { type: "string" } },
                },
              },
            },
          ],
        },
        "/hermes/default/v1/chat/completions",
        { "user-agent": "hermes-cli/0.19.0" },
      ),
    ).toBe("main");
  });

  it("treats plain requests as main", () => {
    expect(hermesAdapter.classifyRequest({})).toBe("main");
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
