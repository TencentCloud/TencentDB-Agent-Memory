import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../anthropic.js";

describe("AnthropicAdapter", () => {
  it("keeps Claude Code's AGENTS.md system message when injection rewrites the top-level system", () => {
    const adapter = new AnthropicAdapter();
    const ctx = adapter.parse({
      model: "claude-sonnet",
      system: "CLAUDE.md instructions",
      messages: [
        { role: "system", content: [{ type: "text", text: "AGENTS.md instructions" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    }, {
      protocol: "anthropic",
      traceId: "trace",
      keyId: "key",
      modelId: "claude-sonnet",
      stream: true,
      agentSource: "claude-code",
    });

    ctx.messages[0].blocks.push({ type: "text", content: "<tdai_memory/>" });

    expect(adapter.serialize(ctx)).toMatchObject({
      system: [
        { type: "text", text: "CLAUDE.md instructions" },
        { type: "text", text: "<tdai_memory/>" },
      ],
      messages: [
        { role: "system", content: [{ type: "text", text: "AGENTS.md instructions" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
  });
});
