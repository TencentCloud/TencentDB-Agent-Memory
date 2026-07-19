import { describe, expect, it } from "vitest";

import {
  CleanContextRunner,
  setPreferredEmbeddedAgentRuntime,
  shouldPassExtraSystemPrompt,
} from "./clean-context-runner.js";

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("shouldPassExtraSystemPrompt", () => {
  it("keeps the legacy fallback when the OpenClaw version is unknown", () => {
    expect(shouldPassExtraSystemPrompt(undefined)).toBe(true);
    expect(shouldPassExtraSystemPrompt("unknown")).toBe(true);
  });

  it("keeps the fallback for OpenClaw versions before 2026.4.7", () => {
    expect(shouldPassExtraSystemPrompt("2026.4.6")).toBe(true);
  });

  it("omits the fallback for OpenClaw versions that support systemPromptOverride", () => {
    expect(shouldPassExtraSystemPrompt("2026.4.7")).toBe(false);
    expect(shouldPassExtraSystemPrompt("2026.4.7-beta.1")).toBe(false);
    expect(shouldPassExtraSystemPrompt("2026.5.20")).toBe(false);
  });
});

describe("CleanContextRunner system prompt compatibility", () => {
  it("does not pass extraSystemPrompt on OpenClaw versions with systemPromptOverride support", async () => {
    const calls: any[] = [];
    const runtime = {
      runEmbeddedPiAgent: async (args: any) => {
        calls.push(args);
        return { payloads: [{ text: "ok" }] };
      },
    };
    setPreferredEmbeddedAgentRuntime(runtime, "2026.4.7");

    const runner = new CleanContextRunner({
      config: {},
      agentRuntime: runtime,
      logger: makeLogger(),
    });

    await runner.run({
      prompt: "extract",
      systemPrompt: "system-only-once",
      taskId: "system-prompt-compat",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("extraSystemPrompt");
    expect(calls[0].config.agents.defaults.systemPromptOverride).toBe("system-only-once");
  });
});
