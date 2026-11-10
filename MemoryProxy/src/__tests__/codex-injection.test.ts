import { describe, expect, it } from "vitest";
import { injectCodexAssets } from "../pipeline/runners/codex.js";

const injection = {
  raw: "<knowledge_tools>\nWiki assets\n</knowledge_tools>",
};

describe("Codex Responses asset injection", () => {
  it("writes assets to top-level instructions when instructions are absent", () => {
    const body = {
      input: [{ type: "function_call_output", output: "tool result" }],
    };

    const injected = injectCodexAssets(body, injection);

    expect(injected.instructions).toContain("<tdai_injections>");
    expect(injected.instructions).toContain("<knowledge_tools>");
    expect(injected.input).toBe(body.input);
  });

  it("preserves existing instructions before the injected block", () => {
    const injected = injectCodexAssets(
      {
        instructions: "Keep the existing system instructions.",
        input: [{ type: "function_call_output", output: "tool result" }],
      },
      injection,
    );

    expect(injected.instructions).toMatch(
      /^Keep the existing system instructions\.\n\n<tdai_injections>/,
    );
  });

  it("does not depend on the first input item being a developer message", () => {
    const body = {
      input: [
        { type: "function_call_output", output: "tool result" },
        { type: "message", role: "user", content: "hello" },
      ],
    };

    const injected = injectCodexAssets(body, injection);

    expect(injected.instructions).toContain("<knowledge_tools>");
    expect(injected.input).toBe(body.input);
  });
});
