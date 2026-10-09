import { describe, expect, it } from "vitest";
import { handleUserPromptSubmit } from "./user-prompt-submit.js";

describe("handleUserPromptSubmit", () => {
  it("injects additionalContext from Gateway recall", async () => {
    const output = await handleUserPromptSubmit(
      {
        prompt: "What should I remember?",
        session_id: "s1",
        cwd: "C:/tmp/project",
      },
      {
        env: {
          MEMORY_TENCENTDB_AUTO_RECALL: "true",
          MEMORY_TENCENTDB_SHORT_TERM: "false",
        },
        client: {
          recall: async (body) => ({
            context: `query=${body.query} session=${body.session_key}`,
            strategy: "hybrid",
            memory_count: 1,
          }),
        },
      },
    );

    expect(output.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput?.additionalContext).toContain("query=What should I remember?");
    expect(output.hookSpecificOutput?.additionalContext).toContain("agent:claude-code-");
  });

  it("does nothing when auto recall is disabled", async () => {
    const output = await handleUserPromptSubmit(
      { prompt: "hello", session_id: "s1" },
      {
        env: { MEMORY_TENCENTDB_AUTO_RECALL: "false" },
        client: {
          recall: async () => {
            throw new Error("should not be called");
          },
        },
      },
    );

    expect(output).toEqual({});
  });
});

