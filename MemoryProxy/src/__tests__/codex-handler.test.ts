import { describe, expect, it } from "vitest";
import { injectCodexAssets } from "../codexHandler.js";

const assets = { raw: "<knowledge_tools>wiki fixture</knowledge_tools>" };

describe("injectCodexAssets", () => {
  it("writes assets to Responses instructions", () => {
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }];

    const result = injectCodexAssets({ input }, assets);

    expect(result.instructions).toContain("<tdai_injections>");
    expect(result.instructions).toContain("<knowledge_tools>wiki fixture</knowledge_tools>");
    expect(result.input).toEqual(input);
  });

  it("appends assets after existing instructions", () => {
    const result = injectCodexAssets({ instructions: "Keep existing guidance." }, assets);

    expect(result.instructions).toBe(
      "Keep existing guidance.\n\n<tdai_injections>\n<knowledge_tools>wiki fixture</knowledge_tools>\n</tdai_injections>",
    );
  });

  it("does not depend on the first input item being a message", () => {
    const input = [{ type: "function_call_output", call_id: "call_1", output: "done" }];

    const result = injectCodexAssets({ input }, assets);

    expect(result.instructions).toContain("<knowledge_tools>wiki fixture</knowledge_tools>");
    expect(result.input).toEqual(input);
  });
});
